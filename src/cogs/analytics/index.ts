import { join } from 'node:path';
import { AnalyticsStore } from './store.js';
import { ANALYTICS_SERVICE, AUDIO_SERVICE, type AnalyticsService, type AnalyticsState, type AudioService } from '../../core/services.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage, formatUptime } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'analytics',
  version: '1.0.0',
  description: 'Tracks peak times, the busiest channels, the most-played songs, and uptime',
};

/** After loading, wait this long before the first sample, so a fast reload/restart is not counted twice back to back. */
const WARMUP_MS = 5_000;
/** However many history entries !history-style services will hand back at once; never ask for more. */
const MAX_HISTORY_PULL = 50;

const HOUR_LABEL = (h: number): string => `${String(h).padStart(2, '0')}:00`;

export function createAnalyticsCog(bot: BotApi): Cog {
  const cfg = bot.config.analytics;
  const p = bot.config.prefix;
  const log = bot.log.child('analytics');
  const adapter = bot.adapter;

  const store = new AnalyticsStore(join(bot.dataDir, 'analytics.json'));

  let enabled = bot.state.get<boolean>('analytics.enabled', cfg.enabled);
  let pollSeconds = bot.state.get<number>('analytics.pollSeconds', cfg.pollSeconds);

  let timer: NodeJS.Timeout | undefined;
  let warmTimer: NodeJS.Timeout | undefined;
  let unprovide: (() => void) | undefined;

  const save = (): void => {
    bot.state.set('analytics.enabled', enabled);
    bot.state.set('analytics.pollSeconds', pollSeconds);
  };

  function tick(): void {
    const now = Date.now();
    store.touchSession(now);
    if (enabled) {
      const users = adapter.users();
      const channelUsers: Record<string, number> = {};
      for (const ch of adapter.channels()) channelUsers[ch.name] = 0;
      for (const u of users) {
        const ch = adapter.channels().find((c) => c.id === u.channelId);
        if (ch) channelUsers[ch.name] = (channelUsers[ch.name] ?? 0) + 1;
      }
      store.addSample({ at: now, totalUsers: users.length, channelUsers }, pollSeconds);

      const audio = bot.services.get<AudioService>(AUDIO_SERVICE);
      if (audio) {
        try {
          store.addSongs(audio.history(MAX_HISTORY_PULL));
        } catch (e) {
          log.debug(`could not read play history: ${errMessage(e)}`);
        }
      }
    }
  }

  function summary(): string {
    const up = formatUptime(Math.round(store.totalUptimeMs() / 1000));
    const busiest = store
      .hourly()
      .filter((h) => h.samples > 0)
      .sort((a, b) => b.avgUsers - a.avgUsers)[0];
    const channels = store.topChannels(3);
    const songs = store.topSongs(3);
    const lines = [
      `Analytics is ${enabled ? `on (checking every ${pollSeconds}s)` : 'off'}, tracking since ${new Date(store.since).toLocaleDateString()} (${store.samples} checks).`,
      `Uptime: ${up || '0m'} total across ${store.sessionCount} run${store.sessionCount === 1 ? '' : 's'}.`,
      busiest ? `Busiest time of day: ${HOUR_LABEL(busiest.hour)} (avg ${busiest.avgUsers.toFixed(1)} online).` : `Busiest time of day: not enough data yet.`,
      channels.length ? `Top channels: ${channels.map((c) => `${c.name} (${formatUptime(c.seconds)})`).join(', ')}.` : `Top channels: not enough data yet.`,
      songs.length ? `Top songs: ${songs.map((s) => `"${s.title}" (${s.plays}x)`).join(', ')}.` : `Top songs: nothing played yet.`,
      `${p}analytics [hours|channels|songs] [count] shows more detail.`,
    ];
    return lines.join('\n');
  }

  const cog: Cog = {
    commands: [
      {
        name: 'analytics',
        aliases: ['stats'],
        description: `Server analytics: ${p}analytics [hours|channels|songs [count]|on|off|interval <seconds>|reset] (all but the plain command need admin)`,
        usage: `${p}analytics [hours|channels [n]|songs [n]|on|off|interval <60-3600>|reset]`,
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();

          if (sub === 'check') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            tick();
            return ctx.reply('Checked now.\n' + summary());
          }

          if (!sub || sub === 'status') return ctx.reply(summary());

          if (sub === 'hours') {
            const rows = store
              .hourly()
              .filter((h) => h.samples > 0)
              .sort((a, b) => b.avgUsers - a.avgUsers)
              .slice(0, 8);
            if (!rows.length) return ctx.reply('Not enough data yet.');
            return ctx.reply(`Busiest times of day (server clock), by average people online:\n${rows.map((h) => `${HOUR_LABEL(h.hour)}: avg ${h.avgUsers.toFixed(1)}`).join('\n')}`);
          }

          if (sub === 'channels') {
            const n = Math.min(20, Math.max(1, Number(ctx.args[1]) || 5));
            const rows = store.topChannels(n);
            if (!rows.length) return ctx.reply('Not enough data yet.');
            return ctx.reply(`Most-active channels (time with at least one person in them):\n${rows.map((c, i) => `${i + 1}. ${c.name}: ${formatUptime(c.seconds) || '0m'}`).join('\n')}`);
          }

          if (sub === 'songs') {
            const n = Math.min(20, Math.max(1, Number(ctx.args[1]) || 5));
            const rows = store.topSongs(n);
            if (!rows.length) return ctx.reply(`Nothing played yet (needs the ${bot.config.cogs.includes('audio') ? 'audio cog\'s play history' : 'audio cog, which is not loaded'}).`);
            return ctx.reply(`Most-played songs:\n${rows.map((s, i) => `${i + 1}. "${s.title}" (${s.plays}x)`).join('\n')}`);
          }

          if (sub === 'on' || sub === 'off') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            enabled = sub === 'on';
            save();
            return ctx.reply(`Analytics tracking is ${sub}.`);
          }

          if (sub === 'interval') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const n = Number(ctx.args[1]);
            if (!Number.isFinite(n) || n < 60 || n > 3600) return ctx.reply(`Give a number of seconds from 60 to 3600: ${p}analytics interval 300`);
            pollSeconds = Math.round(n);
            save();
            if (timer) clearInterval(timer);
            timer = setInterval(tick, pollSeconds * 1000);
            timer.unref?.();
            return ctx.reply(`I'll check every ${pollSeconds} seconds.`);
          }

          if (sub === 'reset') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            store.reset();
            return ctx.reply('Cleared the busiest-times, channel and song stats. Uptime history is kept.');
          }

          return ctx.reply(`Usage: ${p}analytics [hours|channels [n]|songs [n]|on|off|interval <60-3600>|reset]`);
        },
      },
    ],

    onLoad() {
      const now = Date.now();
      store.startSession(now);
      warmTimer = setTimeout(tick, WARMUP_MS);
      warmTimer.unref?.();
      timer = setInterval(tick, pollSeconds * 1000);
      timer.unref?.();
      unprovide = bot.services.provide<AnalyticsService>(ANALYTICS_SERVICE, {
        state: (): AnalyticsState => ({
          enabled,
          pollSeconds,
          since: store.since,
          samples: store.samples,
          totalUptimeMs: store.totalUptimeMs(),
          restarts: Math.max(0, store.sessionCount - 1),
          hourly: store.hourly().map((h) => ({ hour: h.hour, avgUsers: h.avgUsers })),
          topChannels: store.topChannels(10),
          topSongs: store.topSongs(10),
        }),
      });
    },

    onUnload() {
      if (timer) clearInterval(timer);
      if (warmTimer) clearTimeout(warmTimer);
      store.touchSession(Date.now());
      unprovide?.();
    },

    status: () => `Analytics ${enabled ? `on (every ${pollSeconds}s, ${store.samples} checks)` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createAnalyticsCog(bot);
export default factory;
