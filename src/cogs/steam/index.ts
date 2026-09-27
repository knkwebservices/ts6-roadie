import { fetchPlayerSummaries, isSteamId64, SteamError, type SteamPlayer } from './api.js';
import { STEAM_SERVICE, type SteamPlayerStatus, type SteamService, type SteamServiceState } from '../../core/services.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage, formatAgo } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'steam',
  version: '1.0.0',
  description: 'Tells the channel when a tracked Steam player starts a game',
};

/** However many stations sit in config, never track more than this many people at once. */
const MAX_PLAYERS = 25;
/** After loading, wait this long before the first check, so a fast reload does not hammer Steam. */
const WARMUP_MS = 5_000;

export interface SteamDeps {
  fetchPlayers(apiKey: string, steamIds: string[]): Promise<SteamPlayer[]>;
}

const defaultDeps: SteamDeps = {
  fetchPlayers: (apiKey, steamIds) => fetchPlayerSummaries(apiKey, steamIds),
};

interface TrackedPlayer {
  steamId: string;
  label: string;
}

interface Known {
  online: boolean;
  game?: string;
  name: string;
  at: number;
}

export function createSteamCog(bot: BotApi, deps: SteamDeps = defaultDeps): Cog {
  const cfg = bot.config.steam;
  const p = bot.config.prefix;
  const log = bot.log.child('steam');
  const adapter = bot.adapter;

  let enabled = bot.state.get<boolean>('steam.enabled', cfg.enabled);
  let pollSeconds = bot.state.get<number>('steam.pollSeconds', cfg.pollSeconds);
  let players = bot.state.get<TrackedPlayer[]>(
    'steam.players',
    cfg.players.map((pl) => ({ steamId: pl.steamId, label: pl.label.trim() || pl.steamId })),
  );

  const known = new Map<string, Known>();
  let keyOk = false;
  let lastError: string | undefined;
  /** The first check after (re)loading only fills `known`; it never announces what was already true. */
  let warm = false;
  let polling = false;
  let timer: NodeJS.Timeout | undefined;
  let warmTimer: NodeJS.Timeout | undefined;
  let unprovide: (() => void) | undefined;

  const save = (): void => {
    bot.state.set('steam.enabled', enabled);
    bot.state.set('steam.pollSeconds', pollSeconds);
    bot.state.set('steam.players', players);
  };

  const findPlayer = (want: string): TrackedPlayer | undefined => {
    const w = want.trim().toLowerCase();
    return players.find((pl) => pl.steamId === want.trim() || pl.label.toLowerCase() === w);
  };

  async function poll(): Promise<void> {
    if (polling || !enabled || players.length === 0) return;
    polling = true;
    try {
      let list: SteamPlayer[];
      try {
        list = await deps.fetchPlayers(cfg.apiKey, players.map((pl) => pl.steamId));
      } catch (e) {
        // keyOk is left as-is: a blip does not undo an earlier success
        lastError = e instanceof SteamError ? e.message : errMessage(e);
        log.warn(`Steam check failed: ${lastError}`);
        return;
      }
      keyOk = true;
      lastError = undefined;
      const byId = new Map(list.map((sp) => [sp.steamId, sp] as const));
      for (const tracked of players) {
        const sp = byId.get(tracked.steamId);
        if (!sp) continue;
        const prev = known.get(tracked.steamId);
        known.set(tracked.steamId, { online: sp.state !== 0, game: sp.game, name: sp.name, at: Date.now() });
        if (!warm) continue;
        if (sp.game && sp.game !== prev?.game) {
          adapter.sendChannel(`${tracked.label} started playing ${sp.game}.`).catch((e2) => log.debug(`could not announce: ${errMessage(e2)}`));
        }
      }
    } finally {
      warm = true;
      polling = false;
    }
  }

  function describe(tracked: TrackedPlayer): string {
    const k = known.get(tracked.steamId);
    if (!k) return `${tracked.label}: unknown yet`;
    if (k.game) return `${tracked.label}: playing ${k.game}`;
    return `${tracked.label}: ${k.online ? 'online' : 'offline'} (${formatAgo(k.at)})`;
  }

  const cog: Cog = {
    commands: [
      {
        name: 'steam',
        description: `Steam status: ${p}steam [on|off|check|add <steamid64> [label]|remove <steamid or label>|interval <seconds>] (all but plain !steam need admin)`,
        usage: `${p}steam [on|off|check|add <steamid64> [label]|remove <steamid or label>|interval <30-3600>]`,
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();

          if (sub === 'check') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            if (!cfg.apiKey.trim()) return ctx.reply('Set steam.apiKey in config.json first (a free key from https://steamcommunity.com/dev/apikey).');
            await poll();
            if (lastError) return ctx.reply(`Check failed: ${lastError}`);
            return ctx.reply(players.length ? players.map(describe).join('\n') : 'Nobody is tracked yet.');
          }

          if (!sub || sub === 'list' || sub === 'status') {
            if (!cfg.apiKey.trim()) return ctx.reply(`Steam tracking needs an API key first (steam.apiKey in config.json, free at https://steamcommunity.com/dev/apikey).`);
            if (players.length === 0) return ctx.reply(`Steam tracking is ${enabled ? 'on' : 'off'}, but nobody is tracked yet. ${ctx.isAdmin ? `Add someone: ${p}steam add <steamid64> [label]` : ''}`);
            const lines = players.map(describe);
            return ctx.reply(`Steam tracking is ${enabled ? 'on' : 'off'} (checked every ${pollSeconds}s)${lastError ? `, last check failed: ${lastError}` : ''}:\n${lines.join('\n')}`);
          }

          if (sub === 'on' || sub === 'off') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            if (sub === 'on' && !cfg.apiKey.trim()) return ctx.reply('Set steam.apiKey in config.json first (a free key from https://steamcommunity.com/dev/apikey).');
            enabled = sub === 'on';
            save();
            if (enabled) void poll();
            return ctx.reply(`Steam tracking is ${sub}.`);
          }

          if (sub === 'interval') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const n = Number(ctx.args[1]);
            if (!Number.isFinite(n) || n < 30 || n > 3600) return ctx.reply(`Give a number of seconds from 30 to 3600: ${p}steam interval 120`);
            pollSeconds = Math.round(n);
            save();
            if (timer) clearInterval(timer);
            timer = setInterval(() => void poll(), pollSeconds * 1000);
            timer.unref?.();
            return ctx.reply(`I'll check every ${pollSeconds} seconds.`);
          }

          if (sub === 'add') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const id = ctx.args[1]?.trim() ?? '';
            const label = ctx.args.slice(2).join(' ').trim().slice(0, 64) || id;
            if (!isSteamId64(id)) return ctx.reply(`That doesn't look like a SteamID64 (a 17-digit number). Find it at https://steamid.io. Usage: ${p}steam add <steamid64> [label]`);
            if (players.length >= MAX_PLAYERS) return ctx.reply(`I can only track ${MAX_PLAYERS} people. Remove one first with ${p}steam remove <steamid or label>.`);
            if (findPlayer(id)) return ctx.reply('Already tracking that SteamID64.');
            players = [...players, { steamId: id, label }];
            save();
            void poll();
            return ctx.reply(`Now tracking ${label} (${id}).`);
          }

          if (sub === 'remove') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const want = ctx.args.slice(1).join(' ').trim();
            const found = findPlayer(want);
            if (!found) return ctx.reply(`Nobody tracked matches "${want}". ${p}steam list shows who is tracked.`);
            players = players.filter((pl) => pl !== found);
            known.delete(found.steamId);
            save();
            return ctx.reply(`Stopped tracking ${found.label}.`);
          }

          return ctx.reply(`Usage: ${p}steam [on|off|add <steamid64> [label]|remove <steamid or label>|interval <30-3600>]`);
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
      if (enabled && !cfg.apiKey.trim()) log.warn('steam.enabled is true but steam.apiKey is empty, so nothing will be checked');
      unprovide = bot.services.provide<SteamService>(STEAM_SERVICE, {
        state: (): SteamServiceState => ({
          enabled,
          pollSeconds,
          keyOk,
          lastError,
          players: players.map((pl): SteamPlayerStatus => {
            const k = known.get(pl.steamId);
            return { steamId: pl.steamId, label: pl.label, online: !!k?.online, game: k?.game, at: k?.at ?? 0 };
          }),
        }),
      });
    },

    onUnload() {
      if (timer) clearInterval(timer);
      if (warmTimer) clearTimeout(warmTimer);
      unprovide?.();
    },

    status: () => `Steam tracking ${enabled ? `on (${players.length} tracked, every ${pollSeconds}s)` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createSteamCog(bot);
export default factory;
