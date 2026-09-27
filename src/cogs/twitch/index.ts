import { fetchAppToken, fetchLiveStreams, isTwitchLogin, TwitchAuthError, TwitchError, type AppToken, type TwitchStream } from './api.js';
import { TWITCH_SERVICE, type TwitchService, type TwitchServiceState, type TwitchStreamStatus } from '../../core/services.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'twitch',
  version: '1.0.0',
  description: 'Tells the channel when a tracked Twitch channel goes live',
};

/** However many channels sit in config, never track more than this many at once. */
const MAX_CHANNELS = 25;
/** After loading, wait this long before the first check, so a fast reload does not hammer Twitch. */
const WARMUP_MS = 5_000;

export interface TwitchDeps {
  fetchToken(clientId: string, clientSecret: string): Promise<AppToken>;
  fetchStreams(clientId: string, appToken: string, logins: string[]): Promise<TwitchStream[]>;
}

const defaultDeps: TwitchDeps = {
  fetchToken: (clientId, clientSecret) => fetchAppToken(clientId, clientSecret),
  fetchStreams: (clientId, appToken, logins) => fetchLiveStreams(clientId, appToken, logins),
};

interface TrackedChannel {
  login: string;
  label: string;
}

interface Known {
  live: boolean;
  game?: string;
  title?: string;
  startedAt?: number;
}

export function createTwitchCog(bot: BotApi, deps: TwitchDeps = defaultDeps): Cog {
  const cfg = bot.config.twitch;
  const p = bot.config.prefix;
  const log = bot.log.child('twitch');
  const adapter = bot.adapter;

  let enabled = bot.state.get<boolean>('twitch.enabled', cfg.enabled);
  let pollSeconds = bot.state.get<number>('twitch.pollSeconds', cfg.pollSeconds);
  let channels = bot.state.get<TrackedChannel[]>(
    'twitch.channels',
    cfg.channels.map((c) => ({ login: c.login.toLowerCase(), label: c.label.trim() || c.login })),
  );

  const known = new Map<string, Known>();
  let keyOk = false;
  let lastError: string | undefined;
  /** The first check after (re)loading only fills `known`; it never announces what was already true. */
  let warm = false;
  let polling = false;
  let token: AppToken | undefined;
  let timer: NodeJS.Timeout | undefined;
  let warmTimer: NodeJS.Timeout | undefined;
  let unprovide: (() => void) | undefined;

  const save = (): void => {
    bot.state.set('twitch.enabled', enabled);
    bot.state.set('twitch.pollSeconds', pollSeconds);
    bot.state.set('twitch.channels', channels);
  };

  const findChannel = (want: string): TrackedChannel | undefined => {
    const w = want.trim().toLowerCase();
    return channels.find((c) => c.login === w || c.label.toLowerCase() === w);
  };

  async function getToken(forceFresh: boolean): Promise<string> {
    if (!forceFresh && token && token.expiresAt > Date.now()) return token.token;
    token = await deps.fetchToken(cfg.clientId, cfg.clientSecret);
    return token.token;
  }

  async function poll(): Promise<void> {
    if (polling || !enabled || channels.length === 0) return;
    polling = true;
    try {
      let list: TwitchStream[];
      try {
        const tok = await getToken(false);
        list = await deps.fetchStreams(cfg.clientId, tok, channels.map((c) => c.login));
      } catch (e) {
        if (e instanceof TwitchAuthError) {
          // the cached token was stale or revoked: get a fresh one and try exactly once more
          try {
            const tok = await getToken(true);
            list = await deps.fetchStreams(cfg.clientId, tok, channels.map((c) => c.login));
          } catch (e2) {
            lastError = e2 instanceof TwitchError ? e2.message : errMessage(e2);
            log.warn(`Twitch check failed: ${lastError}`);
            return;
          }
        } else {
          // keyOk is left as-is: a blip does not undo an earlier success
          lastError = e instanceof TwitchError ? e.message : errMessage(e);
          log.warn(`Twitch check failed: ${lastError}`);
          return;
        }
      }
      keyOk = true;
      lastError = undefined;
      const byLogin = new Map(list.map((s) => [s.login.toLowerCase(), s] as const));
      for (const tracked of channels) {
        const s = byLogin.get(tracked.login);
        const prev = known.get(tracked.login);
        known.set(tracked.login, s ? { live: true, game: s.game, title: s.title, startedAt: s.startedAt } : { live: false });
        if (!warm) continue;
        if (s && !prev?.live) {
          const what = [s.game, s.title].filter(Boolean).join(': ');
          adapter.sendChannel(`${tracked.label} is live${what ? ` (${what})` : ''}! https://twitch.tv/${tracked.login}`).catch((e2) => log.debug(`could not announce: ${errMessage(e2)}`));
        }
      }
    } finally {
      warm = true;
      polling = false;
    }
  }

  function describe(tracked: TrackedChannel): string {
    const k = known.get(tracked.login);
    if (!k) return `${tracked.label}: unknown yet`;
    if (k.live) return `${tracked.label}: LIVE${k.game ? ` playing ${k.game}` : ''}${k.title ? ` - "${k.title}"` : ''}`;
    return `${tracked.label}: offline`;
  }

  const cog: Cog = {
    commands: [
      {
        name: 'twitch',
        aliases: ['live'],
        description: `Twitch alerts: ${p}twitch [on|off|check|add <channel> [label]|remove <channel or label>|interval <seconds>] (all but plain ${p}twitch need admin)`,
        usage: `${p}twitch [on|off|check|add <channel> [label]|remove <channel or label>|interval <30-3600>]`,
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();

          if (sub === 'check') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            if (!cfg.clientId.trim() || !cfg.clientSecret.trim()) return ctx.reply('Set twitch.clientId and twitch.clientSecret in config.json first (a free app from https://dev.twitch.tv/console/apps).');
            await poll();
            if (lastError) return ctx.reply(`Check failed: ${lastError}`);
            return ctx.reply(channels.length ? channels.map(describe).join('\n') : 'Nobody is tracked yet.');
          }

          if (!sub || sub === 'list' || sub === 'status') {
            if (!cfg.clientId.trim() || !cfg.clientSecret.trim()) return ctx.reply(`Twitch alerts need a client ID/secret first (twitch.clientId / twitch.clientSecret in config.json, free at https://dev.twitch.tv/console/apps).`);
            if (channels.length === 0) return ctx.reply(`Twitch alerts are ${enabled ? 'on' : 'off'}, but nobody is tracked yet. ${ctx.isAdmin ? `Add someone: ${p}twitch add <channel> [label]` : ''}`);
            const lines = channels.map(describe);
            return ctx.reply(`Twitch alerts are ${enabled ? 'on' : 'off'} (checked every ${pollSeconds}s)${lastError ? `, last check failed: ${lastError}` : ''}:\n${lines.join('\n')}`);
          }

          if (sub === 'on' || sub === 'off') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            if (sub === 'on' && (!cfg.clientId.trim() || !cfg.clientSecret.trim())) return ctx.reply('Set twitch.clientId and twitch.clientSecret in config.json first (a free app from https://dev.twitch.tv/console/apps).');
            enabled = sub === 'on';
            save();
            if (enabled) void poll();
            return ctx.reply(`Twitch alerts are ${sub}.`);
          }

          if (sub === 'interval') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const n = Number(ctx.args[1]);
            if (!Number.isFinite(n) || n < 30 || n > 3600) return ctx.reply(`Give a number of seconds from 30 to 3600: ${p}twitch interval 120`);
            pollSeconds = Math.round(n);
            save();
            if (timer) clearInterval(timer);
            timer = setInterval(() => void poll(), pollSeconds * 1000);
            timer.unref?.();
            return ctx.reply(`I'll check every ${pollSeconds} seconds.`);
          }

          if (sub === 'add') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const login = ctx.args[1]?.trim().toLowerCase() ?? '';
            const label = ctx.args.slice(2).join(' ').trim().slice(0, 64) || login;
            if (!isTwitchLogin(login)) return ctx.reply(`That doesn't look like a Twitch channel name (4-25 letters, digits or underscores, from twitch.tv/<name>). Usage: ${p}twitch add <channel> [label]`);
            if (channels.length >= MAX_CHANNELS) return ctx.reply(`I can only track ${MAX_CHANNELS} channels. Remove one first with ${p}twitch remove <channel or label>.`);
            if (findChannel(login)) return ctx.reply('Already tracking that channel.');
            channels = [...channels, { login, label }];
            save();
            void poll();
            return ctx.reply(`Now tracking ${label} (twitch.tv/${login}).`);
          }

          if (sub === 'remove') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const want = ctx.args.slice(1).join(' ').trim();
            const found = findChannel(want);
            if (!found) return ctx.reply(`Nobody tracked matches "${want}". ${p}twitch list shows who is tracked.`);
            channels = channels.filter((c) => c !== found);
            known.delete(found.login);
            save();
            return ctx.reply(`Stopped tracking ${found.label}.`);
          }

          return ctx.reply(`Usage: ${p}twitch [on|off|add <channel> [label]|remove <channel or label>|interval <30-3600>]`);
        },
      },
    ],

    onLoad() {
      warmTimer = setTimeout(() => void poll(), WARMUP_MS);
      warmTimer.unref?.();
      if (enabled) {
        timer = setInterval(() => void poll(), pollSeconds * 1000);
        timer.unref?.();
      }
      if (enabled && (!cfg.clientId.trim() || !cfg.clientSecret.trim())) log.warn('twitch.enabled is true but twitch.clientId/clientSecret are empty, so nothing will be checked');
      unprovide = bot.services.provide<TwitchService>(TWITCH_SERVICE, {
        state: (): TwitchServiceState => ({
          enabled,
          pollSeconds,
          keyOk,
          lastError,
          channels: channels.map((c): TwitchStreamStatus => {
            const k = known.get(c.login);
            return { login: c.login, label: c.label, live: !!k?.live, game: k?.game, title: k?.title, startedAt: k?.startedAt };
          }),
        }),
      });
    },

    onUnload() {
      if (timer) clearInterval(timer);
      if (warmTimer) clearTimeout(warmTimer);
      unprovide?.();
    },

    status: () => `Twitch alerts ${enabled ? `on (${channels.length} tracked, every ${pollSeconds}s)` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createTwitchCog(bot);
export default factory;
