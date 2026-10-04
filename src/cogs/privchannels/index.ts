import type { TsChannel, TsUser } from '../../adapter/types.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage, formatAgo } from '../../util/text.js';
import { roomName, uniqueName } from '../rooms/index.js';

export const manifest: CogManifest = {
  name: 'privchannels',
  version: '1.0.0',
  description: 'Private channels you keep (join "Get a Channel"), and a cleaner for channels nobody uses',
};

/** How often channel use is noted (and the claim channel looked at between directory updates). */
const TICK_MS = 60_000;
/** How often the cleaner looks for channels to delete. */
const CLEAN_MS = 60 * 60_000;
const DAY_MS = 86_400_000;

interface Settings {
  enabled: boolean;
  claimChannel: string;
  parentChannel: string;
  nameTemplate: string;
}

interface CleanerSettings {
  enabled: boolean;
  days: number;
  /** Channel IDs whose sub-channels are cleaned too (like a "Squad Rooms" spacer). */
  zones: number[];
}

/** A private channel, kept by channel ID (as text). */
export interface Owned {
  uid: string;
  name: string;
  at: number;
}

/** Which of `candidates` have gone unused for at least `days`: never one with someone in it or with sub-channels. */
export function staleChannels(
  candidates: TsChannel[],
  lastUsed: Record<string, number>,
  opts: { days: number; now: number; occupied: Set<bigint>; hasChildren: Set<bigint> },
): TsChannel[] {
  return candidates.filter((c) => {
    if (opts.occupied.has(c.id) || opts.hasChildren.has(c.id)) return false;
    const seen = lastUsed[String(c.id)];
    return seen !== undefined && opts.now - seen >= opts.days * DAY_MS;
  });
}

export function createPrivChannelsCog(bot: BotApi): Cog {
  const cfg = bot.config.privchannels;
  const p = bot.config.prefix;
  const log = bot.log.child('privchannels');
  const adapter = bot.adapter;

  let s = bot.state.get<Settings>('privchannels.settings', {
    enabled: cfg.enabled,
    claimChannel: cfg.claimChannel,
    parentChannel: cfg.parentChannel,
    nameTemplate: cfg.nameTemplate,
  });
  let cl = bot.state.get<CleanerSettings>('cleaner.settings', { enabled: cfg.cleaner.enabled, days: cfg.cleaner.days, zones: cfg.cleaner.zones });
  let owned = bot.state.get<Record<string, Owned>>('privchannels.owned', {});
  let lastUsed = bot.state.get<Record<string, number>>('cleaner.lastUsed', {});
  const busy = new Set<string>();
  let tickTimer: NodeJS.Timeout | undefined;
  let cleanTimer: NodeJS.Timeout | undefined;
  let offDirectory: (() => void) | undefined;
  let lastCleanReport = '';

  const saveSettings = (): void => bot.state.set('privchannels.settings', s);
  const saveCleaner = (): void => bot.state.set('cleaner.settings', cl);
  const saveOwned = (): void => bot.state.set('privchannels.owned', owned);
  const saveUsed = (): void => bot.state.set('cleaner.lastUsed', lastUsed);

  const channelById = (id: bigint): TsChannel | undefined => adapter.channels().find((c) => c.id === id);
  const resolveChannel = (text: string): TsChannel | undefined => {
    const t = text.trim();
    if (!t) return undefined;
    const byId = /^#(\d+)$/.exec(t);
    return byId ? channelById(BigInt(byId[1]!)) : adapter.findChannel(t);
  };
  const tell = (u: { id: number; name: string }, text: string): void => {
    adapter.sendPrivate(u.id, text).catch((e) => log.debug(`could not message ${u.name}: ${errMessage(e)}`));
  };

  /** Forget private channels that no longer exist (deleted by hand, say). */
  function tidy(): void {
    const alive = Object.fromEntries(Object.entries(owned).filter(([id]) => channelById(BigInt(id))));
    if (Object.keys(alive).length !== Object.keys(owned).length) {
      owned = alive;
      saveOwned();
    }
  }
  const channelOf = (uid: string): TsChannel | undefined => {
    tidy();
    const hit = Object.entries(owned).find(([, o]) => o.uid === uid);
    return hit ? channelById(BigInt(hit[0])) : undefined;
  };

  /** Channels never cleaned, whatever is configured. */
  const protectedIds = (): Set<bigint> => {
    const out = new Set<bigint>([adapter.selfChannelId()]);
    for (const n of [s.claimChannel, s.parentChannel, bot.config.server.homeChannel, bot.config.modtools.jailChannel, bot.config.community.afk.channel]) {
      const c = n ? resolveChannel(n) : undefined;
      if (c) out.add(c.id);
    }
    for (const z of cl.zones) out.add(BigInt(z));
    return out;
  };

  /** Private channels plus the sub-channels of the cleaner's zones. */
  function candidates(): TsChannel[] {
    const all = adapter.channels();
    const keep = protectedIds();
    const ids = new Set<string>(Object.keys(owned));
    for (const c of all) if (cl.zones.includes(Number(c.parentId))) ids.add(String(c.id));
    return all.filter((c) => ids.has(String(c.id)) && !keep.has(c.id));
  }

  /** Note which watched channels are in use right now; a channel seen for the first time counts as used now. */
  function noteUse(): void {
    const now = Date.now();
    const occupied = new Set(adapter.users().map((u) => u.channelId));
    let changed = false;
    const watched = candidates();
    const watchedIds = new Set(watched.map((c) => String(c.id)));
    for (const c of watched) {
      const k = String(c.id);
      if (occupied.has(c.id) || lastUsed[k] === undefined) {
        lastUsed[k] = now;
        changed = true;
      }
    }
    for (const k of Object.keys(lastUsed)) if (!watchedIds.has(k)) (delete lastUsed[k], (changed = true));
    if (changed) saveUsed();
  }

  function stale(): TsChannel[] {
    const users = adapter.users();
    const all = adapter.channels();
    return staleChannels(candidates(), lastUsed, {
      days: cl.days,
      now: Date.now(),
      occupied: new Set(users.map((u) => u.channelId)),
      hasChildren: new Set(all.map((c) => c.parentId)),
    });
  }

  /** Delete the channels nobody has used for `days`. Returns what was deleted and what failed. */
  async function clean(): Promise<{ deleted: string[]; failed: string[] }> {
    noteUse();
    const out = { deleted: [] as string[], failed: [] as string[] };
    for (const c of stale()) {
      try {
        await adapter.deleteChannel(c.id, false);
        out.deleted.push(c.name);
        const o = owned[String(c.id)];
        delete owned[String(c.id)];
        delete lastUsed[String(c.id)];
        log.info(`cleaner: deleted "${c.name}"${o ? ` (${o.name}'s channel)` : ''}, unused for ${cl.days} days`);
      } catch (e) {
        out.failed.push(`${c.name} (${errMessage(e)})`);
      }
    }
    if (out.deleted.length) (saveOwned(), saveUsed());
    if (out.failed.length) {
      const report = out.failed.join(', ');
      if (report !== lastCleanReport) log.warn(`cleaner could not delete: ${report}`);
      lastCleanReport = report;
    }
    return out;
  }

  // ---- claiming a channel -------------------------------------------------------------------------

  async function giveChannel(u: TsUser, claim: TsChannel): Promise<void> {
    const own = channelOf(u.uid);
    if (own) {
      await adapter.moveUser(u.id, own.id).catch((e) => log.debug(`could not move ${u.name}: ${errMessage(e)}`));
      tell(u, `You already have a channel, "${own.name}". I moved you to it.`);
      return;
    }
    if (Object.keys(owned).length >= cfg.maxChannels) {
      tell(u, `There are already ${cfg.maxChannels} private channels, the most allowed. Ask a staff member.`);
      return;
    }
    const parent = (s.parentChannel && resolveChannel(s.parentChannel)) || claim;
    const siblings = adapter.channels().filter((c) => c.parentId === parent.id).map((c) => c.name);
    const name = uniqueName(roomName(s.nameTemplate, u.name), siblings);
    const botWas = adapter.selfChannelId();
    let id: bigint;
    try {
      id = await adapter.createPermanentChannel({ name, parentId: parent.id });
    } catch (e) {
      const why = errMessage(e);
      log.warn(`could not create a channel for ${u.name}: ${why}`);
      tell(u, `Sorry, I couldn't make you a channel (${why}).`);
      return;
    }
    owned = { ...owned, [String(id)]: { uid: u.uid, name: u.name, at: Date.now() } };
    lastUsed[String(id)] = Date.now();
    saveOwned();
    saveUsed();
    await adapter.moveUser(u.id, id).catch((e) => log.warn(`made "${name}" but could not move ${u.name} in: ${errMessage(e)}`));
    let isAdmin = false;
    if (cfg.ownerChannelGroup > 0) {
      try {
        await adapter.setChannelGroup(u.id, id, cfg.ownerChannelGroup);
        isAdmin = true;
      } catch (e) {
        log.warn(`could not make ${u.name} channel admin of "${name}": ${errMessage(e)}`);
      }
    }
    if (botWas !== 0n && adapter.selfChannelId() !== botWas) {
      const home = bot.config.server.homeChannel ? adapter.findChannel(bot.config.server.homeChannel) : undefined;
      await adapter.moveSelf(botWas, home && home.id === botWas ? bot.config.server.homeChannelPassword : '').catch(() => undefined);
    }
    log.info(`made private channel "${name}" for ${u.name}`);
    tell(
      u,
      `Here's your own channel, "${name}". It stays when you leave${cl.enabled ? `, and is only removed if nobody uses it for ${cl.days} days` : ''}.` +
        (isAdmin ? ' You are its channel admin, so you can rename it, set a password or decide who can talk.' : '') +
        ` ${p}mychannel takes you back to it from anywhere.`,
    );
  }

  function onDirectory(): void {
    if (!adapter.connected) return;
    noteUse();
    if (!s.enabled) return;
    const claim = resolveChannel(s.claimChannel);
    if (!claim) return;
    for (const u of adapter.usersInChannel(claim.id)) {
      if (busy.has(u.uid)) continue;
      busy.add(u.uid);
      giveChannel(u, claim)
        .catch((e) => log.error(`making a channel for ${u.name} failed`, e))
        .finally(() => busy.delete(u.uid));
    }
  }

  const ago = (k: string): string => (lastUsed[k] ? formatAgo(lastUsed[k]!) : 'unknown');

  const cog: Cog = {
    commands: [
      {
        name: 'mychannel',
        aliases: ['mych'],
        description: `Go to your own private channel, or give it up: ${p}mychannel [giveup]`,
        usage: `${p}mychannel [giveup]`,
        run: async (ctx) => {
          const own = channelOf(ctx.msg.senderUid);
          if (ctx.args[0]?.toLowerCase() === 'giveup') {
            if (!own) return ctx.reply("You don't have a channel.");
            try {
              await adapter.deleteChannel(own.id, true);
            } catch (e) {
              return ctx.reply(`I couldn't remove it (${errMessage(e)}).`);
            }
            delete owned[String(own.id)];
            saveOwned();
            return ctx.reply(`"${own.name}" is gone. Join "${s.claimChannel}" any time for a new one.`);
          }
          if (!own) return ctx.reply(s.enabled ? `You don't have a channel yet. Join "${s.claimChannel}" and I'll make you one.` : "You don't have a channel.");
          try {
            await adapter.moveUser(ctx.msg.senderId, own.id);
          } catch (e) {
            return ctx.reply(`I couldn't move you (${errMessage(e)}).`);
          }
          return ctx.reply(`Moved you to "${own.name}".`);
        },
      },
      {
        name: 'privchannels',
        aliases: ['pchannels'],
        description: `Private channels people keep: ${p}privchannels [on|off|claim <channel>|under <channel>|name <template>|list|remove <owner or channel>] (bot admins only)`,
        usage: `${p}privchannels [on|off|claim <channel>|under <channel>|name <template>|list|remove <name>]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          const rest = ctx.args.slice(1).join(' ').trim();
          tidy();
          if (!sub || sub === 'list') {
            const list = Object.entries(owned);
            return ctx.reply(
              [
                `Private channels are ${s.enabled ? 'ON' : 'off'}: join "${s.claimChannel}" to get one${s.parentChannel ? `, made under "${s.parentChannel}"` : ''}, named like "${roomName(s.nameTemplate, 'Ann')}".`,
                list.length ? `${list.length} so far:` : 'None made yet.',
                ...list.map(([id, o]) => `"${channelById(BigInt(id))?.name ?? `#${id}`}" - ${o.name}, last used ${ago(id)}`),
              ].join('\n'),
            );
          }
          if (sub === 'on' || sub === 'off') {
            if (sub === 'on' && !resolveChannel(s.claimChannel)) return ctx.reply(`Make a channel called "${s.claimChannel}" first (or choose one: ${p}privchannels claim <channel>).`);
            s = { ...s, enabled: sub === 'on' };
            saveSettings();
            return ctx.reply(`Private channels are ${sub}.`);
          }
          if (sub === 'claim' || sub === 'under') {
            const ch = resolveChannel(rest);
            if (!ch) return ctx.reply(`I can't find a channel called "${rest}".`);
            s = sub === 'claim' ? { ...s, claimChannel: ch.name } : { ...s, parentChannel: ch.name };
            saveSettings();
            return ctx.reply(sub === 'claim' ? `Joining "${ch.name}" now gets someone a channel.` : `New private channels are made under "${ch.name}".`);
          }
          if (sub === 'name') {
            if (!/\{name\}/i.test(rest) || rest.length > 40) return ctx.reply(`Usage: ${p}privchannels name <template with {name}>, like ${p}privchannels name {name}'s Base`);
            s = { ...s, nameTemplate: rest };
            saveSettings();
            return ctx.reply(`New private channels will be named like "${roomName(rest, 'Ann')}".`);
          }
          if (sub === 'remove') {
            const q = rest.toLowerCase();
            const hit = Object.entries(owned).find(([id, o]) => o.name.toLowerCase() === q || channelById(BigInt(id))?.name.toLowerCase() === q);
            if (!hit) return ctx.reply(`No private channel matches "${rest}". ${p}privchannels list shows them.`);
            const ch = channelById(BigInt(hit[0]));
            if (ch) {
              try {
                await adapter.deleteChannel(ch.id, true);
              } catch (e) {
                return ctx.reply(`I couldn't remove it (${errMessage(e)}).`);
              }
            }
            delete owned[hit[0]];
            saveOwned();
            return ctx.reply(`Removed ${hit[1].name}'s channel.`);
          }
          return ctx.reply(`Usage: ${p}privchannels [on|off|claim <channel>|under <channel>|name <template>|list|remove <name>]`);
        },
      },
      {
        name: 'cleaner',
        description: `Remove channels nobody has used for a while: ${p}cleaner [on|off|days <n>|add <channel>|remove <channel>|preview|run] (bot admins only)`,
        usage: `${p}cleaner [on|off|days <n>|add <channel>|remove <channel>|preview|run]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          const rest = ctx.args.slice(1).join(' ').trim();
          noteUse();
          if (!sub) {
            const zones = cl.zones.map((z) => channelById(BigInt(z))?.name ?? `#${z}`);
            return ctx.reply(
              [
                `The channel cleaner is ${cl.enabled ? 'ON' : 'off'}: channels unused for ${cl.days} days are removed (only when empty, never ones with sub-channels).`,
                `It looks after: private channels${zones.length ? `, and the sub-channels of ${zones.map((z) => `"${z}"`).join(', ')}` : ''}. (${p}cleaner add <channel> watches another channel's sub-channels.)`,
                `${p}cleaner preview shows what would go now.`,
              ].join('\n'),
            );
          }
          if (sub === 'on' || sub === 'off') {
            cl = { ...cl, enabled: sub === 'on' };
            saveCleaner();
            return ctx.reply(sub === 'on' ? `The cleaner is on. It checks every hour. (${p}cleaner preview shows what it would remove now.)` : 'The cleaner is off. Nothing will be removed.');
          }
          if (sub === 'days') {
            const n = Number(ctx.args[1]);
            if (!Number.isInteger(n) || n < 1 || n > 365) return ctx.reply(`Usage: ${p}cleaner days <1-365>`);
            cl = { ...cl, days: n };
            saveCleaner();
            return ctx.reply(`Channels unused for ${n} days will be removed.`);
          }
          if (sub === 'add' || sub === 'remove') {
            const ch = resolveChannel(rest);
            if (!ch) return ctx.reply(`I can't find a channel called "${rest}".`);
            cl = { ...cl, zones: sub === 'add' ? [...new Set([...cl.zones, Number(ch.id)])] : cl.zones.filter((z) => z !== Number(ch.id)) };
            saveCleaner();
            noteUse();
            return ctx.reply(sub === 'add' ? `I'll watch the sub-channels of "${ch.name}" (they count as used from now on, so nothing goes for ${cl.days} days).` : `I'll leave the sub-channels of "${ch.name}" alone.`);
          }
          if (sub === 'preview') {
            const list = stale();
            const watched = candidates();
            return ctx.reply(
              list.length
                ? `${cl.enabled ? 'Next check removes' : 'Would remove (the cleaner is off)'}: ${list.map((c) => `"${c.name}" (last used ${ago(String(c.id))})`).join(', ')}`
                : `Nothing to remove. Watching ${watched.length} channel${watched.length === 1 ? '' : 's'}${watched.length ? `: ${watched.slice(0, 10).map((c) => `"${c.name}" (${ago(String(c.id))})`).join(', ')}` : ''}.`,
            );
          }
          if (sub === 'run') {
            if (!cl.enabled) return ctx.reply(`The cleaner is off. ${p}cleaner preview shows what it would remove; ${p}cleaner on to let it.`);
            const r = await clean();
            return ctx.reply(r.deleted.length || r.failed.length ? `Removed: ${r.deleted.join(', ') || 'nothing'}.${r.failed.length ? ` Couldn't remove: ${r.failed.join(', ')}.` : ''}` : 'Nothing to remove.');
          }
          return ctx.reply(`Usage: ${p}cleaner [on|off|days <n>|add <channel>|remove <channel>|preview|run]`);
        },
      },
    ],

    onLoad() {
      offDirectory = adapter.events.on('directory', onDirectory);
      tickTimer = setInterval(() => noteUse(), TICK_MS);
      tickTimer.unref?.();
      cleanTimer = setInterval(() => {
        if (cl.enabled && adapter.connected) void clean();
      }, CLEAN_MS);
      cleanTimer.unref?.();
    },

    onUnload() {
      offDirectory?.();
      if (tickTimer) clearInterval(tickTimer);
      if (cleanTimer) clearInterval(cleanTimer);
    },

    status: () => `Private channels ${s.enabled ? 'on' : 'off'} (${Object.keys(owned).length}); cleaner ${cl.enabled ? `on (${cl.days} days)` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createPrivChannelsCog(bot);
export default factory;
