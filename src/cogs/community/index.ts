import type { TsUser } from '../../adapter/types.js';
import { COMMUNITY_SERVICE, type CommunityService, type CommunityState } from '../../core/services.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage, formatAgo } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'community',
  version: '1.0.0',
  description: 'AFK mover and a welcome message for people who join',
};

/** Ask the server how long someone has been idle at most this often, per person (each ask is one command to the server). */
const IDLE_POLL_MS = 90_000;
/** Before acting on an idle time that is older than this, ask again. */
const IDLE_RECHECK_MS = 20_000;
/** ...and never more than this many people per check, so a big server cannot make the bot flood the server with questions. */
const IDLE_QUERIES_PER_TICK = 5;
/** People are considered "back" once they have done something in the last minute. */
const BACK_IDLE_SEC = 60;
/** After a failed move, leave that person alone for a while. */
const RETRY_AFTER_MS = 5 * 60_000;
/** After connecting, ignore the client list for a moment so the people already there are not "welcomed". */
const WARMUP_MS = 2_000;
const MOVED_KEEP_MS = 24 * 3_600_000;

interface AfkSettings {
  enabled: boolean;
  channel: string;
  minutes: number;
}

interface WelcomeSettings {
  enabled: boolean;
  message: string;
}

/** What has been noticed about one person (by client number), only in memory. */
interface Watch {
  awaySince?: number;
  mutedSince?: number;
  /** Seconds idle as the server last said, and when it said so. */
  idleSec?: number;
  idleAt?: number;
  warned?: boolean;
  failedAt?: number;
}

/** Someone the mover moved, so they can be moved back (kept by unique ID, so a reconnect does not lose them). */
interface Moved {
  name: string;
  /** The channel they were in, as a number in text. */
  from: string;
  at: number;
}

export function createCommunityCog(bot: BotApi): Cog {
  const cfg = bot.config.community;
  const p = bot.config.prefix;
  const log = bot.log.child('community');
  const adapter = bot.adapter;

  let afk = bot.state.get<AfkSettings>('community.afk', { enabled: cfg.afk.enabled, channel: cfg.afk.channel, minutes: cfg.afk.minutes });
  let welcome = bot.state.get<WelcomeSettings>('community.welcome', { enabled: cfg.welcome.enabled, message: cfg.welcome.message });

  const watching = new Map<number, Watch>();
  let ticking = false;
  let warnedNoChannel = '';
  let afkTimer: NodeJS.Timeout | undefined;
  let warmTimer: NodeJS.Timeout | undefined;
  let offDirectory: (() => void) | undefined;
  let offReady: (() => void) | undefined;
  let unprovide: (() => void) | undefined;

  let known = new Set<number>();
  let warm = false;
  const lastGreeted = new Map<string, number>();

  const lower = (s: string): string => s.trim().toLowerCase();
  const channelName = (id: bigint): string => adapter.channels().find((c) => c.id === id)?.name ?? `#${id}`;
  const tell = (u: { id: number; name: string }, text: string): void => {
    adapter.sendPrivate(u.id, text).catch((e) => log.debug(`could not message ${u.name}: ${errMessage(e)}`));
  };

  // ---- who was moved -------------------------------------------------------------------

  function movedMap(): Record<string, Moved> {
    const all = bot.state.get<Record<string, Moved>>('community.moved', {});
    const now = Date.now();
    const kept = Object.fromEntries(Object.entries(all).filter(([, m]) => now - m.at < MOVED_KEEP_MS));
    if (Object.keys(kept).length !== Object.keys(all).length) bot.state.set('community.moved', kept);
    return kept;
  }
  const saveMoved = (m: Record<string, Moved>): void => bot.state.set('community.moved', m);

  // ---- the AFK mover ----------------------------------------------------------------------

  const exempt = (u: TsUser): boolean =>
    bot.isAdmin(u.uid) || u.groups.some((g) => cfg.afk.exemptGroups.includes(g)) || cfg.afk.ignoreChannels.some((n) => lower(n) === lower(channelName(u.channelId)));

  /** Bring back someone we moved, as soon as they are doing something again. */
  async function considerReturn(u: TsUser, rec: Moved, afkChannelId: bigint, moved: Record<string, Moved>): Promise<void> {
    if (u.channelId !== afkChannelId) {
      delete moved[u.uid]; // they went somewhere else themselves: nothing more to do
      return;
    }
    if (u.away || u.inputMuted || u.outputMuted) return;
    const idle = await adapter.idleSeconds(u.id);
    // (well under the AFK time, so someone is never moved back only to be moved out again)
    if (idle !== undefined && idle > Math.min(BACK_IDLE_SEC, (afk.minutes * 60) / 2)) return;
    delete moved[u.uid];
    const from = adapter.channels().find((c) => String(c.id) === rec.from);
    if (!from) return;
    try {
      await adapter.moveUser(u.id, from.id);
      log.info(`${u.name} is back: moved from the AFK channel to "${from.name}"`);
      tell(u, `Welcome back! I moved you back to "${from.name}".`);
    } catch (e) {
      log.warn(`could not move ${u.name} back to "${from.name}": ${errMessage(e)}`);
    }
  }

  async function afkTick(): Promise<void> {
    if (ticking || !afk.enabled || !adapter.connected) return;
    ticking = true;
    try {
      const target = adapter.findChannel(afk.channel);
      if (!target) {
        if (warnedNoChannel !== afk.channel) log.warn(`AFK mover: there is no channel called "${afk.channel}"`);
        warnedNoChannel = afk.channel;
        return;
      }
      warnedNoChannel = '';
      const now = Date.now();
      const limit = afk.minutes * 60;
      // Ask about idle time often enough to be useful, but a fraction of the AFK time apart, and never too often
      const pollMs = Math.min(IDLE_POLL_MS, (limit * 1000) / 4);
      const recheckMs = Math.min(IDLE_RECHECK_MS, (limit * 1000) / 10);
      // (no warning if the wait is no longer than the warning itself)
      const warnAt = cfg.afk.warnSeconds > 0 && limit > cfg.afk.warnSeconds ? limit - cfg.afk.warnSeconds : undefined;
      const users = adapter.users();
      for (const id of [...watching.keys()]) if (!users.some((u) => u.id === id)) watching.delete(id);

      // the people we moved earlier come first
      const moved = movedMap();
      for (const u of users) {
        const rec = moved[u.uid];
        if (rec) await considerReturn(u, rec, target.id, moved);
      }
      saveMoved(moved);

      // then everyone else, asking the server about the least recently checked first
      let budget = IDLE_QUERIES_PER_TICK;
      const others = users.filter((u) => u.channelId !== target.id && !moved[u.uid]).sort((a, b) => (watching.get(a.id)?.idleAt ?? 0) - (watching.get(b.id)?.idleAt ?? 0));
      for (const u of others) {
        if (exempt(u)) {
          watching.delete(u.id);
          continue;
        }
        const w = watching.get(u.id) ?? {};
        watching.set(u.id, w);
        w.awaySince = u.away ? (w.awaySince ?? now) : undefined;
        w.mutedSince = u.inputMuted || u.outputMuted ? (w.mutedSince ?? now) : undefined;
        if (budget > 0 && (w.idleAt === undefined || now - w.idleAt >= pollMs)) {
          budget--;
          w.idleSec = await adapter.idleSeconds(u.id);
          w.idleAt = Date.now();
        }
        const measure = (): { inactive: number; why: 'idle' | 'away' | 'muted' } => {
          const t = Date.now();
          const away = w.awaySince ? (t - w.awaySince) / 1000 : 0;
          const muted = w.mutedSince ? (t - w.mutedSince) / 1000 : 0;
          const idle = w.idleSec !== undefined && w.idleAt ? w.idleSec + (t - w.idleAt) / 1000 : 0;
          const inactive = Math.max(away, muted, idle);
          return { inactive, why: inactive === idle ? 'idle' : inactive === away ? 'away' : 'muted' };
        };
        let { inactive, why } = measure();
        // The idle time is only asked for now and then, so before acting on it ask again: they may have come back a minute ago.
        if (why === 'idle' && inactive >= (warnAt ?? limit) && (w.idleAt === undefined || Date.now() - w.idleAt > recheckMs)) {
          w.idleSec = await adapter.idleSeconds(u.id);
          w.idleAt = Date.now();
          ({ inactive, why } = measure());
        }
        if (warnAt !== undefined && inactive < warnAt) w.warned = false;
        if (warnAt !== undefined && inactive >= warnAt && inactive < limit && !w.warned) {
          w.warned = true;
          const secs = Math.max(10, Math.round(limit - inactive));
          tell(u, `You have been ${why === 'idle' ? 'idle' : why === 'away' ? 'away' : 'muted'} for a while, so I will move you to "${target.name}" in about ${secs >= 90 ? `${Math.round(secs / 60)} minutes` : `${secs} seconds`}. Move, speak or unmute to stay.`);
        }
        if (inactive >= limit && !(w.failedAt && now - w.failedAt < RETRY_AFTER_MS)) {
          const from = String(u.channelId); // (noted before the move)
          try {
            await adapter.moveUser(u.id, target.id);
            moved[u.uid] = { name: u.name, from, at: now };
            watching.delete(u.id);
            log.info(`moved ${u.name} to "${target.name}" (${why} for ${Math.round(inactive / 60)} min)`);
            tell(u, `I moved you to "${target.name}" because you were ${why === 'idle' ? 'idle' : why === 'away' ? 'away' : 'muted'} for ${afk.minutes} minutes. I'll move you back when you're active again.`);
          } catch (e) {
            w.failedAt = now;
            log.warn(`could not move ${u.name} to "${target.name}": ${errMessage(e)}`);
          }
        }
      }
      saveMoved(moved);
    } finally {
      ticking = false;
    }
  }

  // ---- the welcome message ------------------------------------------------------------------

  const render = (u: { name: string }): string => welcome.message.replace(/\{name\}/g, u.name);

  function onDirectory(): void {
    const users = adapter.users();
    const fresh = warm ? users.filter((u) => !known.has(u.id)) : [];
    known = new Set(users.map((u) => u.id));
    if (!welcome.enabled) return;
    const now = Date.now();
    for (const u of fresh) {
      const last = lastGreeted.get(u.uid);
      if (last !== undefined && now - last < cfg.welcome.cooldownSeconds * 1000) continue;
      lastGreeted.set(u.uid, now);
      tell(u, render(u));
    }
    if (lastGreeted.size > 500) for (const [k, t] of lastGreeted) if (now - t > cfg.welcome.cooldownSeconds * 1000) lastGreeted.delete(k);
  }

  // ---- settings, kept between restarts ---------------------------------------------------------

  const saveAfk = (next: AfkSettings): void => {
    afk = next;
    bot.state.set('community.afk', next);
  };
  const saveWelcome = (next: WelcomeSettings): void => {
    welcome = next;
    bot.state.set('community.welcome', next);
  };

  const cog: Cog = {
    commands: [
      {
        name: 'afk',
        description: 'The AFK mover: !afk [on|off|minutes <n>|channel <name>] (bot admins only)',
        usage: `${p}afk [on|off|minutes <1-1440>|channel <name>]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          const found = !!adapter.findChannel(afk.channel);
          if (!sub || sub === 'status') {
            const moved = Object.values(movedMap());
            return ctx.reply(
              `AFK mover is ${afk.enabled ? 'on' : 'off'}. It moves people who have been away, muted or idle for ${afk.minutes} minutes to "${afk.channel}"${found ? '' : ' (I cannot find that channel!)'}.` +
                `${cfg.afk.warnSeconds > 0 ? ` They get a warning ${cfg.afk.warnSeconds} seconds before.` : ''}` +
                `${moved.length ? `\nMoved now: ${moved.map((m) => `${m.name} (${formatAgo(m.at)})`).join(', ')}` : ''}`,
            );
          }
          if (sub === 'on') {
            if (!found) return ctx.reply(`I cannot find a channel called "${afk.channel}". Use ${p}afk channel <name> first.`);
            saveAfk({ ...afk, enabled: true });
            void afkTick();
            return ctx.reply(`AFK mover is on: after ${afk.minutes} minutes away, muted or idle, people go to "${afk.channel}" and come back when they are active. Bot admins are never moved.`);
          }
          if (sub === 'off') {
            saveAfk({ ...afk, enabled: false });
            return ctx.reply('AFK mover is off.');
          }
          if (sub === 'minutes') {
            const n = Number(ctx.args[1]);
            if (!Number.isFinite(n) || n < 1 || n > 1440) return ctx.reply(`Give a number of minutes from 1 to 1440: ${p}afk minutes 30`);
            saveAfk({ ...afk, minutes: Math.round(n) });
            return ctx.reply(`People will be moved after ${Math.round(n)} minutes.`);
          }
          if (sub === 'channel') {
            const want = ctx.rest.slice('channel'.length).trim();
            const ch = adapter.findChannel(want);
            if (!want || !ch) return ctx.reply(`I cannot find a channel called "${want}".`);
            saveAfk({ ...afk, channel: ch.name });
            return ctx.reply(`The AFK channel is now "${ch.name}".`);
          }
          return ctx.reply(`Usage: ${p}afk [on|off|minutes <1-1440>|channel <name>]`);
        },
      },
      {
        name: 'welcome',
        description: 'The welcome message: !welcome [on|off|set <text>|test] (bot admins only)',
        usage: `${p}welcome [on|off|set <text>|test]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub) return ctx.reply(`The welcome message is ${welcome.enabled ? 'on' : 'off'}. Everyone who joins gets:\n${welcome.message}\n(${p}welcome set <text> changes it; {name} becomes their nickname.)`);
          if (sub === 'on' || sub === 'off') {
            saveWelcome({ ...welcome, enabled: sub === 'on' });
            return ctx.reply(`The welcome message is ${sub}.`);
          }
          if (sub === 'set') {
            const text = ctx.rest.slice('set'.length).trim();
            if (!text || text.length > 500) return ctx.reply(`Give me the text, up to 500 characters: ${p}welcome set Welcome, {name}!`);
            saveWelcome({ ...welcome, message: text });
            return ctx.reply(`Saved. This is what people will see:\n${render({ name: ctx.msg.senderName })}`);
          }
          if (sub === 'test') return ctx.reply(render({ name: ctx.msg.senderName }));
          return ctx.reply(`Usage: ${p}welcome [on|off|set <text>|test]`);
        },
      },
    ],

    onLoad() {
      known = new Set(adapter.users().map((u) => u.id));
      warm = adapter.connected;
      offDirectory = adapter.events.on('directory', onDirectory);
      offReady = bot.events.on('ready', () => {
        // a fresh connection: the people already here are not new
        warm = false;
        known = new Set(adapter.users().map((u) => u.id));
        watching.clear();
        if (warmTimer) clearTimeout(warmTimer);
        warmTimer = setTimeout(() => {
          known = new Set(adapter.users().map((u) => u.id));
          warm = true;
        }, WARMUP_MS);
        warmTimer.unref?.();
      });
      afkTimer = setInterval(() => void afkTick(), cfg.afk.checkSeconds * 1000);
      afkTimer.unref?.();
      unprovide = bot.services.provide<CommunityService>(COMMUNITY_SERVICE, {
        state: (): CommunityState => ({
          afk: {
            enabled: afk.enabled,
            channel: afk.channel,
            minutes: afk.minutes,
            warnSeconds: cfg.afk.warnSeconds,
            channelFound: !!adapter.findChannel(afk.channel),
            moved: Object.values(movedMap()).map((m) => ({ name: m.name, at: m.at })),
          },
          welcome: { enabled: welcome.enabled, message: welcome.message },
        }),
      });
    },

    onUnload() {
      offDirectory?.();
      offReady?.();
      unprovide?.();
      if (afkTimer) clearInterval(afkTimer);
      if (warmTimer) clearTimeout(warmTimer);
    },

    status: () => `AFK mover ${afk.enabled ? `on (${afk.minutes} min)` : 'off'} | welcome ${welcome.enabled ? 'on' : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createCommunityCog(bot);
export default factory;
