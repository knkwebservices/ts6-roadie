import { join } from 'node:path';
import type { TsChannel, TsUser } from '../../adapter/types.js';
import { AUDIO_SERVICE, type AudioService } from '../../core/services.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage, formatAgo } from '../../util/text.js';
import { MAX_CHANNEL_NAME, renderLiveName, type LiveValues } from './livenames.js';
import { SeenStore, type SeenEntry } from './seen.js';

export const manifest: CogManifest = {
  name: 'servertools',
  version: '1.0.0',
  description: 'Support notifier, live channel names, !seen and the online record',
};

/** After connecting, ignore the client list for a moment so the people already there do not count as "joining". */
const WARMUP_MS = 2_000;
/** How often to look at the live channel names (each is still renamed at most every liveNames.updateSeconds). */
const LIVE_TICK_MS = 5_000;
/** How often "last seen" is refreshed for everyone online, and the file written if anything changed. */
const SEEN_TICK_MS = 60_000;
/** After a failed rename, wait at least this long before trying that channel again. */
const RENAME_RETRY_MS = 5 * 60_000;
const MAX_RULES = 20;
const MAX_LIVE = 10;
const MAX_MATCHES_SHOWN = 5;

interface NotifySettings {
  enabled: boolean;
  rules: { channel: string; groups: number[] }[];
  message: string;
}

interface LiveSettings {
  enabled: boolean;
  channels: { channelId: number; template: string }[];
}

interface OnlineRecord {
  count: number;
  at: number;
}

/** Per live-name channel, in memory only. */
interface LiveTrack {
  lastAt?: number;
  failedAt?: number;
  lastError?: string;
}

export function createServerToolsCog(bot: BotApi): Cog {
  const cfg = bot.config.servertools;
  const p = bot.config.prefix;
  const log = bot.log.child('servertools');
  const adapter = bot.adapter;

  let notify = bot.state.get<NotifySettings>('servertools.notify', { enabled: cfg.notify.enabled, rules: cfg.notify.rules, message: cfg.notify.message });
  let live = bot.state.get<LiveSettings>('servertools.liveNames', { enabled: cfg.liveNames.enabled, channels: cfg.liveNames.channels });
  let record = bot.state.get<OnlineRecord>('servertools.record', { count: 0, at: 0 });

  const seen = new SeenStore(join(bot.dataDir, 'seen.json'));
  const liveTrack = new Map<number, LiveTrack>();
  /** Where each client was at the last look (client number -> channel), to notice people arriving. */
  let whereWas = new Map<number, bigint>();
  let onlineUids = new Map<string, string>();
  let warm = false;
  const lastNotified = new Map<string, number>();

  let offDirectory: (() => void) | undefined;
  let offReady: (() => void) | undefined;
  let offLost: (() => void) | undefined;
  let warmTimer: NodeJS.Timeout | undefined;
  let liveTimer: NodeJS.Timeout | undefined;
  let seenTimer: NodeJS.Timeout | undefined;
  let liveBusy = false;

  const lower = (s: string): string => s.trim().toLowerCase();
  const channelById = (id: bigint): TsChannel | undefined => adapter.channels().find((c) => c.id === id);
  const channelName = (id: bigint): string => channelById(id)?.name ?? `#${id}`;

  /** A channel by name, or by "#<id>" (the form a live-named channel is best given in, since its name keeps changing). */
  const resolveChannel = (text: string): TsChannel | undefined => {
    const t = text.trim();
    const byId = /^#(\d+)$/.exec(t);
    return byId ? channelById(BigInt(byId[1]!)) : adapter.findChannel(t);
  };

  const safeSave = (): void => {
    try {
      seen.save();
    } catch (e) {
      log.warn(`could not save seen.json: ${errMessage(e)}`);
    }
  };

  // ---- the online record and "last seen" ------------------------------------------------------

  function noteRecord(count: number): void {
    if (count <= record.count) return;
    record = { count, at: Date.now() };
    bot.state.set('servertools.record', record);
  }

  function refreshSeen(users: TsUser[]): void {
    if (!cfg.seen.enabled) return;
    const now = Date.now();
    const next = new Map<string, string>();
    for (const u of users) {
      seen.saw(u.uid, u.name, now);
      next.set(u.uid, u.name);
    }
    // people who just left were last seen now, not at the last minute-by-minute refresh
    for (const [uid, name] of onlineUids) if (!next.has(uid)) seen.saw(uid, name, now);
    onlineUids = next;
  }

  // ---- the support notifier ---------------------------------------------------------------------

  function renderNotify(u: TsUser, ch: TsChannel): string {
    return notify.message.replace(/\{name\}/g, u.name).replace(/\{channel\}/g, ch.name);
  }

  /** Tell the online members of the rule's groups. Returns how many were told. */
  function tellStaff(rule: NotifySettings['rules'][number], who: TsUser, ch: TsChannel, users: TsUser[]): number {
    const staff = users.filter((s) => s.id !== who.id && s.groups.some((g) => rule.groups.includes(g)));
    const text = renderNotify(who, ch);
    for (const s of staff) adapter.sendPrivate(s.id, text).catch((e) => log.debug(`could not message ${s.name}: ${errMessage(e)}`));
    return staff.length;
  }

  function checkArrivals(users: TsUser[]): void {
    if (!notify.enabled || !notify.rules.length) return;
    const now = Date.now();
    const cooldown = cfg.notify.cooldownSeconds * 1000;
    for (const u of users) {
      const before = whereWas.get(u.id);
      if (before === u.channelId) continue;
      for (const rule of notify.rules) {
        const ch = resolveChannel(rule.channel);
        if (!ch || ch.id !== u.channelId) continue;
        // staff going into the room they watch is not news
        if (u.groups.some((g) => rule.groups.includes(g))) continue;
        const key = `${u.uid}|${ch.id}`;
        const last = lastNotified.get(key);
        if (last !== undefined && now - last < cooldown) continue;
        lastNotified.set(key, now);
        const told = tellStaff(rule, u, ch, users);
        log.info(`${u.name} joined "${ch.name}": told ${told} ${told === 1 ? 'person' : 'people'}`);
      }
    }
    if (lastNotified.size > 500) for (const [k, t] of lastNotified) if (now - t > cooldown) lastNotified.delete(k);
  }

  // ---- live channel names -----------------------------------------------------------------------

  function liveValues(): LiveValues {
    let song = '';
    const audio = bot.services.get<AudioService>(AUDIO_SERVICE);
    if (audio) {
      try {
        const cur = audio.snapshot().current;
        song = cur ? (cur.liveTitle || cur.title) : '';
      } catch (e) {
        log.debug(`could not read what is playing: ${errMessage(e)}`);
      }
    }
    return { online: adapter.users().length, record: record.count, song };
  }

  /** Rename the live channels whose name is out of date. `force` ignores the minimum wait (used by !livename now). */
  async function liveTick(force = false): Promise<{ renamed: number; failed: string[] }> {
    const result = { renamed: 0, failed: [] as string[] };
    if ((!live.enabled && !force) || liveBusy || !adapter.connected) return result;
    liveBusy = true;
    try {
      const values = liveValues();
      const now = Date.now();
      for (const entry of live.channels) {
        const ch = channelById(BigInt(entry.channelId));
        const t = liveTrack.get(entry.channelId) ?? {};
        liveTrack.set(entry.channelId, t);
        if (!ch) {
          if (t.lastError !== 'missing') log.warn(`live name: there is no channel #${entry.channelId} any more`);
          t.lastError = 'missing';
          continue;
        }
        const want = renderLiveName(entry.template, values);
        if (ch.name === want) continue;
        if (!force) {
          if (t.lastAt !== undefined && now - t.lastAt < cfg.liveNames.updateSeconds * 1000) continue;
          if (t.failedAt !== undefined && now - t.failedAt < Math.max(RENAME_RETRY_MS, cfg.liveNames.updateSeconds * 1000)) continue;
        }
        t.lastAt = now;
        try {
          await adapter.renameChannel(ch.id, want);
          t.failedAt = undefined;
          t.lastError = undefined;
          result.renamed++;
          log.debug(`live name: #${entry.channelId} is now "${want}"`);
        } catch (e) {
          const why = errMessage(e);
          t.failedAt = now;
          if (t.lastError !== why) log.warn(`live name: could not rename #${entry.channelId} to "${want}": ${why}`);
          t.lastError = why;
          result.failed.push(`#${entry.channelId}: ${why}`);
        }
      }
    } finally {
      liveBusy = false;
    }
    return result;
  }

  // ---- watching the client list -------------------------------------------------------------------

  function onDirectory(): void {
    const users = adapter.users();
    noteRecord(users.length);
    refreshSeen(users);
    if (warm) checkArrivals(users);
    whereWas = new Map(users.map((u) => [u.id, u.channelId]));
  }

  function startWarmup(): void {
    warm = false;
    whereWas = new Map(adapter.users().map((u) => [u.id, u.channelId]));
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(() => {
      whereWas = new Map(adapter.users().map((u) => [u.id, u.channelId]));
      warm = true;
    }, WARMUP_MS);
    warmTimer.unref?.();
  }

  // ---- settings ---------------------------------------------------------------------------------------

  const saveNotify = (next: NotifySettings): void => {
    notify = next;
    bot.state.set('servertools.notify', next);
  };
  const saveLive = (next: LiveSettings): void => {
    live = next;
    bot.state.set('servertools.liveNames', next);
  };

  const when = (ms: number): string => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const ruleLine = (r: NotifySettings['rules'][number], i: number): string => {
    const ch = resolveChannel(r.channel);
    return `${i + 1}. "${ch ? ch.name : r.channel}"${ch ? '' : ' (I cannot find this channel!)'} -> server group${r.groups.length === 1 ? '' : 's'} ${r.groups.join(', ')}`;
  };
  const liveLine = (e: LiveSettings['channels'][number], i: number): string => {
    const ch = channelById(BigInt(e.channelId));
    return `${i + 1}. #${e.channelId} ${ch ? `now "${ch.name}"` : '(I cannot find this channel!)'} <- ${e.template}`;
  };

  function describeSeen(e: SeenEntry, now = Date.now()): string {
    const on = adapter.users().find((u) => u.uid === e.uid);
    if (on) return `${on.name} is online now, in "${channelName(on.channelId)}".`;
    return `${e.name} was last seen ${formatAgo(e.last, now)} (${when(e.last)}).`;
  }

  const cog: Cog = {
    commands: [
      {
        name: 'seen',
        aliases: ['lastseen'],
        description: `When someone was last online: ${p}seen <name>`,
        usage: `${p}seen <name>`,
        run: async (ctx) => {
          if (!cfg.seen.enabled) return ctx.reply('Last-seen tracking is switched off on this server.');
          const q = ctx.rest.trim();
          if (!q) return ctx.reply(`Usage: ${p}seen <name>`);
          // someone online right now wins, even if the bot has never saved them
          const onNow = adapter.users().filter((u) => lower(u.name) === lower(q));
          if (onNow.length) return ctx.reply(onNow.map((u) => `${u.name} is online now, in "${channelName(u.channelId)}".`).join('\n'));
          const hits = seen.find(q);
          if (!hits.length) return ctx.reply(`I haven't seen anyone called "${q}".`);
          if (hits.length === 1) return ctx.reply(describeSeen(hits[0]!));
          const shown = hits.slice(0, MAX_MATCHES_SHOWN).map((e) => describeSeen(e));
          return ctx.reply(`${hits.length} people match "${q}":\n${shown.join('\n')}${hits.length > MAX_MATCHES_SHOWN ? `\n...and ${hits.length - MAX_MATCHES_SHOWN} more. Try more of the name.` : ''}`);
        },
      },
      {
        name: 'record',
        description: `The most people ever online at once. ${p}record reset starts it again from who is online now (bot admins)`,
        usage: `${p}record [reset]`,
        run: async (ctx) => {
          const now = adapter.users().length;
          if (ctx.args[0]?.toLowerCase() === 'reset') {
            if (!ctx.isAdmin) return ctx.reply('Only bot admins can reset the record.');
            record = { count: now, at: Date.now() };
            bot.state.set('servertools.record', record);
            void liveTick(true);
            return ctx.reply(`The record is reset. It starts again from ${now} (online now).`);
          }
          if (!record.count) return ctx.reply(`No record yet. ${now} ${now === 1 ? 'person is' : 'people are'} online now.`);
          return ctx.reply(`The most people online at once: ${record.count}, on ${when(record.at)}. Right now: ${now}.`);
        },
      },
      {
        name: 'notify',
        description: `The support notifier: tell a server group when someone joins a channel. ${p}notify [on|off|add|remove|message|test] (bot admins only)`,
        usage: `${p}notify [on|off|add <channel> | <group IDs>|remove <n>|message <text>|test <n>]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub || sub === 'list' || sub === 'status') {
            const lines = [
              `The support notifier is ${notify.enabled ? 'on' : 'off'}.`,
              notify.rules.length ? `Watching:\n${notify.rules.map(ruleLine).join('\n')}` : `Nothing is watched yet. Add a channel with ${p}notify add <channel> | <group IDs>.`,
              `Message: ${notify.message}`,
              `(Find a server group's ID with ${p}whoami.)`,
            ];
            return ctx.reply(lines.join('\n'));
          }
          if (sub === 'on') {
            if (!notify.rules.length) return ctx.reply(`Add a channel to watch first: ${p}notify add Support Room | 12`);
            saveNotify({ ...notify, enabled: true });
            return ctx.reply(`The support notifier is on. Members of the listed groups get a private message when someone joins a watched channel (not when one of them does).`);
          }
          if (sub === 'off') {
            saveNotify({ ...notify, enabled: false });
            return ctx.reply('The support notifier is off.');
          }
          if (sub === 'add') {
            const body = ctx.rest.slice('add'.length);
            const bar = body.lastIndexOf('|');
            if (bar < 0) return ctx.reply(`Usage: ${p}notify add <channel name or #id> | <group ID>[, <group ID>...]`);
            const ch = resolveChannel(body.slice(0, bar));
            if (!ch) return ctx.reply(`I cannot find a channel called "${body.slice(0, bar).trim()}".`);
            const parts = body.slice(bar + 1).split(/[,\s]+/).filter(Boolean);
            const groups = parts.map(Number);
            if (!groups.length || groups.some((g) => !Number.isInteger(g) || g < 0)) return ctx.reply(`Give server-group ID numbers after the "|", like: ${p}notify add ${ch.name} | 12, 15`);
            if (notify.rules.length >= MAX_RULES) return ctx.reply(`That's the most I can watch (${MAX_RULES}). Remove one first.`);
            const rules = notify.rules.filter((r) => resolveChannel(r.channel)?.id !== ch.id);
            rules.push({ channel: `#${ch.id}`, groups: [...new Set(groups)] });
            saveNotify({ ...notify, rules });
            return ctx.reply(`When someone joins "${ch.name}", I'll tell the online members of server group${groups.length === 1 ? '' : 's'} ${[...new Set(groups)].join(', ')}.${notify.enabled ? '' : ` The notifier is off: ${p}notify on starts it.`}`);
          }
          if (sub === 'remove') {
            const n = Number(ctx.args[1]);
            if (!Number.isInteger(n) || n < 1 || n > notify.rules.length) return ctx.reply(`Give the number from ${p}notify, like: ${p}notify remove 1`);
            const gone = notify.rules[n - 1]!;
            saveNotify({ ...notify, rules: notify.rules.filter((_, i) => i !== n - 1) });
            return ctx.reply(`No longer watching "${resolveChannel(gone.channel)?.name ?? gone.channel}".`);
          }
          if (sub === 'message') {
            const text = ctx.rest.slice('message'.length).trim();
            if (!text || text.length > 300) return ctx.reply(`Give the text, up to 300 characters. {name} is who joined and {channel} the channel: ${p}notify message {name} is waiting in {channel}`);
            saveNotify({ ...notify, message: text });
            return ctx.reply(`Saved. It will read like: ${text.replace(/\{name\}/g, ctx.msg.senderName).replace(/\{channel\}/g, 'Support Room')}`);
          }
          if (sub === 'test') {
            const n = Number(ctx.args[1] ?? 1);
            const rule = notify.rules[n - 1];
            if (!rule) return ctx.reply(`There is no rule ${ctx.args[1] ?? 1}. See ${p}notify.`);
            const ch = resolveChannel(rule.channel);
            if (!ch) return ctx.reply('I cannot find that channel any more.');
            const me = (await ctx.user()) ?? { id: ctx.msg.senderId, uid: ctx.msg.senderUid, name: ctx.msg.senderName, channelId: 0n, groups: ctx.msg.senderGroups };
            // (the caller is told too, so they can see what staff get)
            const told = tellStaff(rule, { ...me, id: -1 }, ch, adapter.users());
            return ctx.reply(`Sent a test to ${told} online member${told === 1 ? '' : 's'} of server group${rule.groups.length === 1 ? '' : 's'} ${rule.groups.join(', ')}.`);
          }
          return ctx.reply(`Usage: ${p}notify [on|off|add <channel> | <group IDs>|remove <n>|message <text>|test <n>]`);
        },
      },
      {
        name: 'livename',
        aliases: ['livenames'],
        description: `Keep channel names up to date, like "Online: 12": ${p}livename [on|off|add|remove|now] (bot admins only)`,
        usage: `${p}livename [on|off|add <channel or #id> | <template>|remove <n>|now]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub || sub === 'list' || sub === 'status') {
            const lines = [
              `Live channel names are ${live.enabled ? `on (each updated at most every ${cfg.liveNames.updateSeconds}s)` : 'off'}.`,
              live.channels.length ? live.channels.map(liveLine).join('\n') : `No channels yet. Add one with ${p}livename add <channel> | [cspacer]Online: {online}`,
              `You can use {online} (people online now), {record} (most ever at once) and {song} (what I'm playing). TeamSpeak allows ${MAX_CHANNEL_NAME} characters.`,
            ];
            return ctx.reply(lines.join('\n'));
          }
          if (sub === 'on') {
            if (!live.channels.length) return ctx.reply(`Add a channel first: ${p}livename add <channel> | [cspacer]Online: {online}`);
            saveLive({ ...live, enabled: true });
            const r = await liveTick();
            return ctx.reply(`Live channel names are on.${r.failed.length ? ` But I could not rename ${r.failed.join('; ')}. Does my server group have permission to change channel names?` : ''}`);
          }
          if (sub === 'off') {
            saveLive({ ...live, enabled: false });
            return ctx.reply('Live channel names are off. The channels keep their current names.');
          }
          if (sub === 'add') {
            const body = ctx.rest.slice('add'.length);
            const bar = body.indexOf('|');
            if (bar < 0) return ctx.reply(`Usage: ${p}livename add <channel name or #id> | <template>, like: ${p}livename add Online | [cspacer]Online: {online}`);
            const ch = resolveChannel(body.slice(0, bar));
            if (!ch) return ctx.reply(`I cannot find a channel called "${body.slice(0, bar).trim()}".`);
            const template = body.slice(bar + 1).trim();
            if (!template || template.length > 100) return ctx.reply('Give the name to use after the "|", up to 100 characters.');
            if (!/\{(online|record|song)\}/i.test(template)) return ctx.reply('Put at least one of {online}, {record} or {song} in it, or there is nothing to keep up to date.');
            const others = live.channels.filter((e) => e.channelId !== Number(ch.id));
            if (others.length >= MAX_LIVE) return ctx.reply(`That's the most I keep up to date (${MAX_LIVE}). Remove one first.`);
            saveLive({ ...live, channels: [...others, { channelId: Number(ch.id), template }] });
            liveTrack.delete(Number(ch.id));
            const preview = renderLiveName(template, liveValues());
            if (live.enabled) void liveTick();
            return ctx.reply(`Channel #${ch.id} ("${ch.name}") will be named like: ${preview}${live.enabled ? '' : `\nLive names are off: ${p}livename on starts them.`}`);
          }
          if (sub === 'remove') {
            const n = Number(ctx.args[1]);
            if (!Number.isInteger(n) || n < 1 || n > live.channels.length) return ctx.reply(`Give the number from ${p}livename, like: ${p}livename remove 1`);
            const gone = live.channels[n - 1]!;
            saveLive({ ...live, channels: live.channels.filter((_, i) => i !== n - 1) });
            liveTrack.delete(gone.channelId);
            return ctx.reply(`I'll leave channel #${gone.channelId} alone now (it keeps its current name).`);
          }
          if (sub === 'now') {
            if (!live.channels.length) return ctx.reply('There are no live channels to update.');
            const r = await liveTick(true);
            return ctx.reply(r.failed.length ? `Renamed ${r.renamed}. Could not rename ${r.failed.join('; ')}.` : r.renamed ? `Renamed ${r.renamed} channel${r.renamed === 1 ? '' : 's'}.` : 'Every live channel already has the right name.');
          }
          return ctx.reply(`Usage: ${p}livename [on|off|add <channel or #id> | <template>|remove <n>|now]`);
        },
      },
    ],

    onLoad() {
      seen.prune(cfg.seen.keepDays);
      onlineUids = new Map(adapter.users().map((u) => [u.uid, u.name]));
      // Loaded while already connected (a start-up or !reload): whoever is here now is not "joining".
      // Otherwise the 'ready' event starts a short warm-up once the bot connects.
      whereWas = new Map(adapter.users().map((u) => [u.id, u.channelId]));
      warm = adapter.connected;
      if (adapter.connected) {
        noteRecord(adapter.users().length);
        refreshSeen(adapter.users());
      }
      offDirectory = adapter.events.on('directory', onDirectory);
      offReady = bot.events.on('ready', startWarmup);
      offLost = bot.events.on('lost', () => {
        // everyone online was seen until now; after reconnecting they are counted afresh
        refreshSeen([]);
        safeSave();
      });
      liveTimer = setInterval(() => void liveTick(), LIVE_TICK_MS);
      liveTimer.unref?.();
      seenTimer = setInterval(() => {
        if (adapter.connected) refreshSeen(adapter.users());
        seen.prune(cfg.seen.keepDays);
        safeSave();
      }, SEEN_TICK_MS);
      seenTimer.unref?.();
    },

    onUnload() {
      offDirectory?.();
      offReady?.();
      offLost?.();
      if (warmTimer) clearTimeout(warmTimer);
      if (liveTimer) clearInterval(liveTimer);
      if (seenTimer) clearInterval(seenTimer);
      if (adapter.connected) refreshSeen(adapter.users());
      safeSave();
    },

    status: () =>
      `Notifier ${notify.enabled ? `on (${notify.rules.length} channel${notify.rules.length === 1 ? '' : 's'})` : 'off'} | live names ${live.enabled ? `on (${live.channels.length})` : 'off'} | seen ${cfg.seen.enabled ? `${seen.size} people` : 'off'} | record ${record.count}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createServerToolsCog(bot);
export default factory;
