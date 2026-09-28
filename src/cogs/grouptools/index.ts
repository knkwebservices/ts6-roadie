import { join } from 'node:path';
import type { TsUser } from '../../adapter/types.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage } from '../../util/text.js';
import { formatHours, HoursStore } from './hours.js';

export const manifest: CogManifest = {
  name: 'grouptools',
  version: '1.0.0',
  description: 'Ranks for time spent online, and protected server groups',
};

/** How often time online is counted and ranks and protected groups are checked. */
const TICK_MS = 60_000;
/** Never count more than this for one tick, so a pause (the machine sleeping, a long reconnect) is not counted as time online. */
const MAX_TICK_SEC = 5 * 60;
/** After a failed group change for someone, leave them alone this long before trying again. */
const RETRY_MS = 10 * 60_000;
/** Don't tell the admins about the same person in the same protected group more often than this. */
const PROTECT_REPEAT_MS = 30 * 60_000;
const MAX_RULES = 20;

type Rule = { hours: number; group: number; label: string };

interface RankSettings {
  enabled: boolean;
  rules: Rule[];
}

interface ProtectSettings {
  enabled: boolean;
  mode: 'warn' | 'remove';
  groups: { group: number; allowed: string[] }[];
}

/** The highest rank someone has earned with this much time online, or undefined. */
export function earnedRank(rules: Rule[], seconds: number): Rule | undefined {
  return [...rules].sort((a, b) => b.hours - a.hours).find((r) => seconds >= r.hours * 3600);
}

/** The next rank above this much time online, or undefined at the top. */
export function nextRank(rules: Rule[], seconds: number): Rule | undefined {
  return [...rules].sort((a, b) => a.hours - b.hours).find((r) => seconds < r.hours * 3600);
}

export function createGroupToolsCog(bot: BotApi): Cog {
  const cfg = bot.config.grouptools;
  const p = bot.config.prefix;
  const log = bot.log.child('grouptools');
  const adapter = bot.adapter;

  let ranks = bot.state.get<RankSettings>('grouptools.ranks', { enabled: cfg.ranks.enabled, rules: cfg.ranks.rules });
  let protect = bot.state.get<ProtectSettings>('grouptools.protect', { enabled: cfg.protect.enabled, mode: cfg.protect.mode, groups: cfg.protect.groups });

  const hours = new HoursStore(join(bot.dataDir, 'ranks.json'));
  const failedAt = new Map<string, number>();
  const toldAdmins = new Map<string, number>();
  let lastTick = Date.now();
  let timer: NodeJS.Timeout | undefined;
  let offDirectory: (() => void) | undefined;
  let checking = false;
  /** A change arrived while a check was running: look again when it finishes. */
  let again = false;

  const lower = (s: string): string => s.trim().toLowerCase();
  const channelName = (id: bigint): string => adapter.channels().find((c) => c.id === id)?.name ?? '';
  const tell = (u: { id: number; name: string }, text: string): void => {
    adapter.sendPrivate(u.id, text).catch((e) => log.debug(`could not message ${u.name}: ${errMessage(e)}`));
  };
  const tellAdmins = (text: string, except?: number): number => {
    const admins = adapter.users().filter((u) => bot.isAdmin(u.uid) && u.id !== except);
    for (const a of admins) tell(a, text);
    return admins.length;
  };
  const safeSave = (): void => {
    try {
      hours.save();
    } catch (e) {
      log.warn(`could not save ranks.json: ${errMessage(e)}`);
    }
  };
  const sortedRules = (): Rule[] => [...ranks.rules].sort((a, b) => a.hours - b.hours);
  const hrs = (n: number): string => `${n} hour${n === 1 ? '' : 's'}`;

  /**
   * Everyone's server groups as the server last said, by client number. The client list's groups can be
   * stale (group changes made while someone is online are not always reported to it), so nothing is
   * added or removed on its word: each decision uses groups asked from the server a moment ago.
   */
  const known = new Map<number, { uid: string; groups: number[]; at: number }>();
  const FRESH_MS = 2 * 60_000;
  /** Ask the server about at most this many people per check, so a busy server is never flooded. */
  const QUERIES_PER_CHECK = 10;
  let budget = QUERIES_PER_CHECK;
  /** In a check set off by someone joining or moving, only ask about people never asked about before. */
  let onlyNew = false;

  /**
   * Someone's real groups: remembered if fresh (or `force`d to ask), else asked from the server while
   * this check's budget lasts. Undefined means "not known well enough to act on right now".
   */
  async function groupsOf(u: TsUser, force = false): Promise<number[] | undefined> {
    const k = known.get(u.id);
    const mine = k && k.uid === u.uid ? k : undefined;
    if (!force && mine && (onlyNew || Date.now() - mine.at < FRESH_MS)) return mine.groups;
    if (!force && budget <= 0) return undefined;
    budget--;
    try {
      const groups = await adapter.userGroups(u.id);
      known.set(u.id, { uid: u.uid, groups, at: Date.now() });
      return groups;
    } catch (e) {
      log.debug(`could not ask the server for ${u.name}'s groups: ${errMessage(e)}`);
      return undefined;
    }
  }
  const noteGroups = (u: TsUser, change: (g: number[]) => number[]): void => {
    const k = known.get(u.id);
    if (k && k.uid === u.uid) k.groups = change(k.groups);
  };

  /** "They are already in it" / "they are already out of it": the change is done, not failed. */
  const alreadyDone = (e: unknown): boolean => /duplicate entry|empty result set/i.test(errMessage(e));

  /** Add a group. True if it was really added now, false if they were already in it. */
  async function addGroup(u: TsUser, g: number): Promise<boolean> {
    let added = true;
    try {
      await adapter.addServerGroup(u.id, g);
    } catch (e) {
      if (!alreadyDone(e)) throw e;
      added = false;
    }
    noteGroups(u, (gs) => (gs.includes(g) ? gs : [...gs, g]));
    return added;
  }

  async function removeGroup(u: TsUser, g: number): Promise<void> {
    try {
      await adapter.removeServerGroup(u.id, g);
    } catch (e) {
      if (!alreadyDone(e)) throw e;
    }
    noteGroups(u, (gs) => gs.filter((x) => x !== g));
  }

  // ---- ranks ------------------------------------------------------------------------------------------

  const rankExempt = (u: TsUser): boolean => (known.get(u.id)?.uid === u.uid ? known.get(u.id)!.groups : u.groups).some((g) => cfg.ranks.exemptGroups.includes(g));

  function countTime(users: TsUser[]): void {
    const now = Date.now();
    const sec = Math.min(MAX_TICK_SEC, Math.max(0, (now - lastTick) / 1000));
    lastTick = now;
    if (!ranks.enabled || sec <= 0) return;
    const ignore = new Set(cfg.ranks.ignoreChannels.map(lower));
    for (const u of users) {
      if (rankExempt(u)) continue;
      if (u.away && !cfg.ranks.countAway) continue;
      if (ignore.has(lower(channelName(u.channelId)))) continue;
      hours.add(u.uid, u.name, sec);
    }
  }

  /** Why the last rank change failed, per person (for !ranks give and !ranks check to report). */
  const lastRankError = new Map<string, string>();

  /** Give the rank someone has earned (and, with replaceLower, take away the lower ones). Returns what changed. */
  async function applyRank(u: TsUser, force = false): Promise<string | undefined> {
    if (!ranks.rules.length) return undefined;
    const have = hours.get(u.uid)?.seconds ?? 0;
    const target = earnedRank(ranks.rules, have);
    if (!target) return undefined;
    const key = `${u.uid}|rank`;
    const failed = failedAt.get(key);
    if (!force && failed !== undefined && Date.now() - failed < RETRY_MS) return undefined;
    const lowerGroups = cfg.ranks.replaceLower ? ranks.rules.filter((r) => r.hours < target.hours && r.group !== target.group).map((r) => r.group) : [];
    const groups = await groupsOf(u, force);
    if (!groups || groups.some((g) => cfg.ranks.exemptGroups.includes(g))) return undefined;
    const toRemove = lowerGroups.filter((g) => groups.includes(g));
    const needsAdd = !groups.includes(target.group);
    if (!needsAdd && !toRemove.length) return undefined;
    let added = false;
    try {
      if (needsAdd) added = await addGroup(u, target.group);
      for (const g of toRemove) await removeGroup(u, g);
      failedAt.delete(key);
      lastRankError.delete(u.uid);
    } catch (e) {
      failedAt.set(key, Date.now());
      const why = errMessage(e);
      lastRankError.set(u.uid, `could not give ${u.name} "${target.label}" (server group ${target.group}): ${why}`);
      log.warn(`could not give ${u.name} the rank "${target.label}" (server group ${target.group}): ${why}`);
      return undefined;
    }
    if (added) {
      log.info(`${u.name} reached the rank "${target.label}" (${formatHours(have)} online)`);
      tell(u, `Congratulations! After ${formatHours(have)} on the server you've reached the rank "${target.label}".`);
      return `${u.name}: ${target.label}`;
    }
    return undefined;
  }

  // ---- protected groups ----------------------------------------------------------------------------------

  const allowedIn = (uid: string, rule: ProtectSettings['groups'][number]): boolean => bot.isAdmin(uid) || rule.allowed.includes(uid);

  async function checkProtected(u: TsUser, force = false): Promise<void> {
    if (!protect.enabled) return;
    const watched = protect.groups.filter((r) => !allowedIn(u.uid, r));
    if (!watched.length) return;
    const groups = await groupsOf(u, force);
    if (!groups) return;
    for (const rule of watched) {
      if (!groups.includes(rule.group)) continue;
      const key = `${u.uid}|${rule.group}`;
      const now = Date.now();
      if (protect.mode === 'warn') {
        const told = toldAdmins.get(key);
        if (told !== undefined && now - told < PROTECT_REPEAT_MS) continue;
        toldAdmins.set(key, now);
        log.warn(`${u.name} (${u.uid}) is in protected server group ${rule.group} but not on its allowed list`);
        tellAdmins(`Warning: ${u.name} is in protected server group ${rule.group} but isn't on its allowed list. ${p}protect allow ${rule.group} ${u.name} keeps them; ${p}protect mode remove makes me take people out.`);
        continue;
      }
      const failed = failedAt.get(key);
      if (failed !== undefined && now - failed < RETRY_MS) continue;
      try {
        await removeGroup(u, rule.group);
        failedAt.delete(key);
        log.warn(`took ${u.name} (${u.uid}) out of protected server group ${rule.group}: not on its allowed list`);
        tellAdmins(`I took ${u.name} out of protected server group ${rule.group}: they are not on its allowed list. (${p}protect allow ${rule.group} ${u.name}, then add them back, if that was wrong.)`);
      } catch (e) {
        failedAt.set(key, now);
        log.warn(`could not take ${u.name} out of protected server group ${rule.group}: ${errMessage(e)}`);
        tellAdmins(`${u.name} is in protected server group ${rule.group} without being allowed, and I could not take them out (${errMessage(e)}).`);
      }
    }
    if (toldAdmins.size > 500) for (const [k, t] of toldAdmins) if (Date.now() - t > PROTECT_REPEAT_MS) toldAdmins.delete(k);
  }

  // ---- the regular check ------------------------------------------------------------------------------------

  async function check(opts: { count?: boolean; force?: boolean } = {}): Promise<string[]> {
    if (!adapter.connected) return [];
    if (checking) {
      again = true;
      return [];
    }
    checking = true;
    const promoted: string[] = [];
    try {
      const users = adapter.users();
      if (opts.count) countTime(users);
      budget = QUERIES_PER_CHECK;
      onlyNew = !opts.count && !opts.force;
      for (const id of [...known.keys()]) if (!users.some((u) => u.id === id)) known.delete(id);
      // the people asked about longest ago first, so over a few checks everyone is looked at
      users.sort((a, b) => (known.get(a.id)?.at ?? 0) - (known.get(b.id)?.at ?? 0));
      for (const u of users) {
        await checkProtected(u, opts.force);
        if (ranks.enabled) {
          const r = await applyRank(u, opts.force);
          if (r) promoted.push(r);
        }
      }
      safeSave();
    } finally {
      checking = false;
    }
    if (again) {
      again = false;
      promoted.push(...(await check()));
    }
    return promoted;
  }

  // ---- finding people for commands ---------------------------------------------------------------------------

  /** An online person by exact name or "#<client number>". */
  function onlineUser(text: string): TsUser | undefined {
    const t = text.trim();
    const num = /^#(\d+)$/.exec(t);
    if (num) return adapter.users().find((u) => u.id === Number(num[1]));
    return adapter.users().find((u) => lower(u.name) === lower(t));
  }

  /** A unique ID from an online person's name, "#<client number>", or a unique ID typed as it is. */
  function uidFor(text: string): { uid: string; name: string } | undefined {
    const on = onlineUser(text);
    if (on) return { uid: on.uid, name: on.name };
    const t = text.trim();
    if (/^[A-Za-z0-9+/]{20,}={0,2}$/.test(t)) return { uid: t, name: t };
    const known = hours.byName(t);
    if (known.length === 1) return { uid: known[0]!.uid, name: known[0]!.name };
    return undefined;
  }

  // ---- settings ------------------------------------------------------------------------------------------------

  const saveRanks = (next: RankSettings): void => {
    ranks = next;
    bot.state.set('grouptools.ranks', next);
  };
  const saveProtect = (next: ProtectSettings): void => {
    protect = next;
    bot.state.set('grouptools.protect', next);
  };

  function rankLine(uid: string, name: string, self: boolean): string {
    const have = hours.get(uid)?.seconds ?? 0;
    const now = earnedRank(ranks.rules, have);
    const next = nextRank(ranks.rules, have);
    const who = self ? "You've" : `${name} has`;
    return (
      `${who} been online ${formatHours(have)}${ranks.enabled ? '' : ' (not counting right now: ranks are off)'}.` +
      ` Rank: ${now ? now.label : 'none yet'}.` +
      (next ? ` Next: ${next.label} at ${next.hours} hours (${formatHours(next.hours * 3600 - have)} to go).` : now ? ' That is the top rank.' : '')
    );
  }

  const cog: Cog = {
    commands: [
      {
        name: 'rank',
        aliases: ['hours'],
        description: `Your time online and rank, or someone else's: ${p}rank [name]`,
        usage: `${p}rank [name]`,
        run: async (ctx) => {
          if (!ranks.rules.length) return ctx.reply('No ranks are set up on this server.');
          const q = ctx.rest.trim();
          if (!q) return ctx.reply(rankLine(ctx.msg.senderUid, ctx.msg.senderName, true));
          const who = uidFor(q);
          if (!who) return ctx.reply(`I don't know anyone called "${q}".`);
          return ctx.reply(rankLine(who.uid, who.name, who.uid === ctx.msg.senderUid));
        },
      },
      {
        name: 'ranks',
        description: `Ranks for time online: ${p}ranks [on|off|add <hours> <group ID> <label>|remove <n>|give <name> <hours>|check] (bot admins only)`,
        usage: `${p}ranks [on|off|add <hours> <group ID> <label>|remove <n>|give <name> <hours>|check]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub || sub === 'list' || sub === 'status') {
            const rules = sortedRules();
            return ctx.reply(
              [
                `Ranks are ${ranks.enabled ? 'on' : 'off'}. ${hours.size} ${hours.size === 1 ? 'person has' : 'people have'} time counted.`,
                rules.length ? rules.map((r, i) => `${i + 1}. ${r.label}: ${hrs(r.hours)} -> server group ${r.group}`).join('\n') : `No ranks yet. Add one with ${p}ranks add 10 9 Regular (10 hours online gives server group 9).`,
                `${cfg.ranks.replaceLower ? 'Reaching a rank takes away the lower ranks.' : 'Ranks stack: lower ranks are kept.'} Time is not counted while ${cfg.ranks.countAway ? '' : 'away or '}in ${cfg.ranks.ignoreChannels.length ? cfg.ranks.ignoreChannels.map((c) => `"${c}"`).join(', ') : 'no particular channel'}.`,
              ].join('\n'),
            );
          }
          if (sub === 'on') {
            if (!ranks.rules.length) return ctx.reply(`Add a rank first: ${p}ranks add 10 9 Regular`);
            saveRanks({ ...ranks, enabled: true });
            lastTick = Date.now();
            const done = await check({ force: true });
            return ctx.reply(`Ranks are on: I'm counting time online from now.${done.length ? ` Given right away: ${done.join(', ')}.` : ''}`);
          }
          if (sub === 'off') {
            saveRanks({ ...ranks, enabled: false });
            return ctx.reply('Ranks are off: time is no longer counted. Nobody loses a rank they already have.');
          }
          if (sub === 'add') {
            const h = Number(ctx.args[1]);
            const g = Number(ctx.args[2]);
            const label = ctx.args.slice(3).join(' ').trim();
            if (!(h > 0) || h > 100_000 || !Number.isInteger(g) || g <= 0 || !label || label.length > 40) return ctx.reply(`Usage: ${p}ranks add <hours> <server group ID> <label>, like: ${p}ranks add 10 9 Regular`);
            if (ranks.rules.length >= MAX_RULES) return ctx.reply(`That's the most ranks I keep (${MAX_RULES}).`);
            if (ranks.rules.some((r) => r.group === g)) return ctx.reply(`Server group ${g} is already a rank. Remove it first to change it.`);
            saveRanks({ ...ranks, rules: [...ranks.rules, { hours: h, group: g, label }] });
            return ctx.reply(`Added: after ${hrs(h)} online, people get server group ${g} ("${label}").${ranks.enabled ? '' : ` Ranks are off: ${p}ranks on starts them.`} (If ${g} is not the right group, the first try to give it says so.)`);
          }
          if (sub === 'remove') {
            const n = Number(ctx.args[1]);
            const rules = sortedRules();
            if (!Number.isInteger(n) || n < 1 || n > rules.length) return ctx.reply(`Give the number from ${p}ranks, like: ${p}ranks remove 1`);
            const gone = rules[n - 1]!;
            saveRanks({ ...ranks, rules: ranks.rules.filter((r) => r.group !== gone.group) });
            return ctx.reply(`Removed the rank "${gone.label}". People who have server group ${gone.group} keep it; take it away in TeamSpeak if you want.`);
          }
          if (sub === 'give' || sub === 'set') {
            // the hours are the last word, so names with spaces work
            const h = Number(ctx.args.at(-1));
            const name = ctx.args.slice(1, -1).join(' ');
            const who = name ? uidFor(name) : undefined;
            if (!name || !(h >= 0) || h > 100_000) return ctx.reply(`Usage: ${p}ranks give <name> <hours>, like: ${p}ranks give KrazyIce 200 (sets their total; useful for people who were here before ranks)`);
            if (!who) return ctx.reply(`I don't know anyone called "${name}". They need to be online (or give their unique ID).`);
            hours.set(who.uid, who.name, h * 3600);
            safeSave();
            const on = adapter.users().find((u) => u.uid === who.uid);
            lastRankError.delete(who.uid);
            const r = on && ranks.enabled ? await applyRank(on, true) : undefined;
            const err = lastRankError.get(who.uid);
            return ctx.reply(`${who.name} now has ${formatHours(h * 3600)} counted.${r ? ` They reached a new rank: ${r.split(': ')[1]}.` : ''}${err ? ` But I ${err}.` : ''}`);
          }
          if (sub === 'check') {
            lastRankError.clear();
            const done = await check({ force: true });
            const errs = [...lastRankError.values()];
            return ctx.reply(`${done.length ? `Checked. New ranks: ${done.join(', ')}.` : 'Checked. Nobody reached a new rank.'}${errs.length ? `\nProblems: I ${errs.join('; I ')}.` : ''}`);
          }
          return ctx.reply(`Usage: ${p}ranks [on|off|add <hours> <group ID> <label>|remove <n>|give <name> <hours>|check]`);
        },
      },
      {
        name: 'protect',
        description: `Protected server groups: only allowed people may be in them. ${p}protect [on|off|mode|add|remove|allow|disallow] (bot admins only)`,
        usage: `${p}protect [on|off|mode warn|remove|add <group ID>|remove <group ID>|allow <group ID> <name or unique ID>|disallow <group ID> <name or unique ID>]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          const groupArg = (): ProtectSettings['groups'][number] | undefined => protect.groups.find((x) => x.group === Number(ctx.args[1]));
          if (!sub || sub === 'list' || sub === 'status') {
            const users = adapter.users();
            const lines = [
              `Group protection is ${protect.enabled ? `on, in ${protect.mode} mode (${protect.mode === 'warn' ? 'I only tell online bot admins' : 'I take people out'})` : 'off'}. Bot admins are always allowed.`,
              ...protect.groups.map((x) => {
                const inIt = users.filter((u) => u.groups.includes(x.group));
                const bad = inIt.filter((u) => !allowedIn(u.uid, x)).map((u) => u.name);
                return `Server group ${x.group}: ${x.allowed.length} allowed.${inIt.length ? ` Online in it: ${inIt.map((u) => u.name).join(', ')}.` : ''}${bad.length ? ` NOT allowed: ${bad.join(', ')}.` : ''}`;
              }),
            ];
            if (!protect.groups.length) lines.push(`No groups are protected. ${p}protect add <group ID> starts with one (find IDs with ${p}whoami).`);
            return ctx.reply(lines.join('\n'));
          }
          if (sub === 'on') {
            if (!protect.groups.length) return ctx.reply(`Protect a group first: ${p}protect add <group ID>`);
            saveProtect({ ...protect, enabled: true });
            void check();
            return ctx.reply(`Group protection is on, in ${protect.mode} mode.${protect.mode === 'warn' ? ` I'll only warn online bot admins for now. When the allowed lists are right, ${p}protect mode remove makes me take people out.` : ''}`);
          }
          if (sub === 'off') {
            saveProtect({ ...protect, enabled: false });
            return ctx.reply('Group protection is off.');
          }
          if (sub === 'mode') {
            const m = ctx.args[1]?.toLowerCase();
            if (m !== 'warn' && m !== 'remove') return ctx.reply(`Usage: ${p}protect mode warn|remove`);
            saveProtect({ ...protect, mode: m });
            if (protect.enabled) void check();
            return ctx.reply(m === 'warn' ? 'Warn mode: I only tell online bot admins about people who should not be in a protected group.' : `Remove mode: I take people who are not allowed out of protected groups, and tell the online bot admins. Check ${p}protect first: everyone who belongs there must be allowed.`);
          }
          if (sub === 'add') {
            const g = Number(ctx.args[1]);
            if (!Number.isInteger(g) || g <= 0) return ctx.reply(`Usage: ${p}protect add <server group ID>`);
            if (groupArg()) return ctx.reply(`Server group ${g} is already protected.`);
            // everyone in the group right now is allowed, so switching this on never surprises the people who are online
            const members = adapter.users().filter((u) => u.groups.includes(g));
            saveProtect({ ...protect, groups: [...protect.groups, { group: g, allowed: [...new Set(members.map((u) => u.uid))] }] });
            return ctx.reply(
              `Server group ${g} is protected.${members.length ? ` Allowed now (online in it): ${members.map((u) => u.name).join(', ')}.` : ''}` +
                ` Anyone else in the group who is offline right now is NOT allowed yet: add them with ${p}protect allow ${g} <name or unique ID>.`,
            );
          }
          if (sub === 'remove' || sub === 'unprotect') {
            const x = groupArg();
            if (!x) return ctx.reply(`Server group ${ctx.args[1] ?? '?'} isn't protected. See ${p}protect.`);
            saveProtect({ ...protect, groups: protect.groups.filter((y) => y !== x) });
            return ctx.reply(`Server group ${x.group} is no longer protected.`);
          }
          if (sub === 'allow' || sub === 'disallow') {
            const x = groupArg();
            const target = ctx.args.slice(2).join(' ');
            if (!x || !target) return ctx.reply(`Usage: ${p}protect ${sub} <protected group ID> <name, #client number or unique ID>`);
            const who = uidFor(target);
            if (!who) return ctx.reply(`I don't know anyone called "${target}". Use their unique ID (they can get it with ${p}whoami), or ask them to come online.`);
            const allowed = sub === 'allow' ? [...new Set([...x.allowed, who.uid])] : x.allowed.filter((u) => u !== who.uid);
            saveProtect({ ...protect, groups: protect.groups.map((y) => (y === x ? { ...y, allowed } : y)) });
            return ctx.reply(sub === 'allow' ? `${who.name} may be in server group ${x.group}.` : `${who.name} is no longer allowed in server group ${x.group}.${bot.isAdmin(who.uid) ? ' (They are a bot admin, so they are still allowed.)' : ''}`);
          }
          return ctx.reply(`Usage: ${p}protect [on|off|mode warn|remove|add <group ID>|remove <group ID>|allow <group ID> <name>|disallow <group ID> <name>]`);
        },
      },
    ],

    onLoad() {
      lastTick = Date.now();
      offDirectory = adapter.events.on('directory', () => {
        // someone joined or moved: look at newcomers now (everyone else is looked at by the minute-by-minute check)
        if (protect.enabled || ranks.enabled) void check();
      });
      timer = setInterval(() => void check({ count: true }), TICK_MS);
      timer.unref?.();
    },

    onUnload() {
      offDirectory?.();
      if (timer) clearInterval(timer);
      safeSave();
    },

    status: () =>
      `Ranks ${ranks.enabled ? `on (${ranks.rules.length})` : 'off'} | protection ${protect.enabled ? `${protect.mode} (${protect.groups.length} group${protect.groups.length === 1 ? '' : 's'})` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createGroupToolsCog(bot);
export default factory;
