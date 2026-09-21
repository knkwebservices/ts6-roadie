import type { BotApi, Cog, CogFactory, CogManifest, CommandContext } from '../../core/types.js';
import { AUDIO_SERVICE, type AudioService, type QueueItem } from '../../core/services.js';
import { Mutex } from '../../util/mutex.js';
import { errMessage, formatDuration } from '../../util/text.js';
import { startIcyTitles } from './icy.js';
import { Player, type PlayerLike, type PlayerOptions } from './player.js';
import { TrackQueue, type Track } from './queue.js';
import { listStations, resolveMedia, resolveRadio, SourceError, toolVersion, type MediaInfo } from './sources.js';

export const manifest: CogManifest = {
  name: 'audio',
  version: '1.0.0',
  description: 'Music: YouTube/links + radio, follows whoever calls it',
};

/** Seams so the cog's logic can be tested without yt-dlp, ffmpeg or a TeamSpeak server. */
export interface AudioDeps {
  resolveMedia: typeof resolveMedia;
  createPlayer: (opts: PlayerOptions) => PlayerLike;
  toolVersion: typeof toolVersion;
  /** Start reading a radio station's song titles. Returns a function that stops. */
  startRadioTitles: (url: string, onTitle: (title: string) => void, note: (message: string) => void) => () => void;
}

const defaultDeps: AudioDeps = {
  resolveMedia,
  createPlayer: (o) => new Player(o),
  toolVersion,
  startRadioTitles: (url, onTitle, note) => startIcyTitles(url, { onTitle, onNote: note }),
};

export function createAudioCog(bot: BotApi, deps: AudioDeps = defaultDeps): Cog {
  const cfg = bot.config.audio;
  const p = bot.config.prefix;
  const log = bot.log.child('audio');
  const adapter = bot.adapter;

  const queue = new TrackQueue();
  const lock = new Mutex();
  let player: PlayerLike | undefined;
  let pumping = false;
  /** Callers who have claimed the bot but whose track hasn't reached the queue yet. */
  let pending = 0;
  let nextId = 1;
  let idleTimer: NodeJS.Timeout | undefined;
  let watchTimer: NodeJS.Timeout | undefined;
  let aloneSince: number | undefined;
  let offLost: (() => void) | undefined;
  let unprovide: (() => void) | undefined;
  /** The song a radio station is announcing right now (only while a radio track plays). */
  let liveTitle: string | undefined;
  let versionCache: { at: number; text: string } | undefined;

  const pl = (): PlayerLike => {
    if (!player) throw new Error('audio cog is not loaded');
    return player;
  };

  // ---- helpers ------------------------------------------------------------------------

  const channelName = (id: bigint): string => adapter.channels().find((c) => c.id === id)?.name ?? `#${id}`;
  const busy = (): boolean => pl().playing || queue.size > 0 || pending > 0;
  const say = (text: string): void => {
    adapter.sendChannel(text).catch((e) => log.debug(`announce failed: ${errMessage(e)}`));
  };

  function cancelIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  }

  async function goHome(): Promise<void> {
    if (!player || busy() || !adapter.connected) return;
    const home = adapter.findChannel(bot.config.server.homeChannel);
    if (!home || adapter.selfChannelId() === home.id) return;
    try {
      await adapter.moveSelf(home.id, bot.config.server.homeChannelPassword);
      log.info(`returned to home channel "${home.name}"`);
    } catch (e) {
      log.warn(`could not return to home channel: ${errMessage(e)}`);
    }
  }

  function scheduleIdle(): void {
    cancelIdle();
    if (!player || busy()) return; // no player = the cog was unloaded while a track was finishing
    idleTimer = setTimeout(() => void goHome(), bot.config.follow.idleReturnSeconds * 1000);
    idleTimer.unref?.();
  }

  function stopEverything(): number {
    const dropped = queue.clear();
    player?.stop();
    return dropped;
  }

  /** If the bot is left alone in a channel for a while, stop and head home. */
  function watchChannel(): void {
    if (!player || !adapter.connected) return;
    const here = adapter.selfChannelId();
    if (here === 0n || adapter.usersInChannel(here).length > 0) {
      aloneSince = undefined;
      return;
    }
    aloneSince ??= Date.now();
    if (Date.now() - aloneSince < bot.config.follow.aloneLeaveSeconds * 1000) return;
    aloneSince = undefined;
    if (pending === 0 && (pl().playing || queue.size > 0)) {
      log.info('alone in channel - stopping playback');
      stopEverything();
    }
    void (async () => {
      // give the pump a moment to unwind so busy() is false
      await new Promise((r) => setTimeout(r, 250));
      await goHome();
    })();
  }

  /**
   * Make sure the bot is in the caller's channel (moving there if it is idle) and mark the
   * caller's request as pending. Returns false (after replying) if the request can't proceed.
   * On true, the caller MUST decrement `pending` when done.
   */
  function followCaller(ctx: CommandContext): Promise<boolean> {
    return lock.run(async () => {
      const user = await ctx.user();
      if (!user || user.channelId === 0n) {
        await ctx.reply("I can't tell which channel you're in right now - try again in a moment.");
        return false;
      }
      const here = adapter.selfChannelId();
      if (user.channelId === here) {
        pending++;
        return true;
      }
      if (busy()) {
        await ctx.reply(`I'm playing in "${channelName(here)}" right now. Join me there, or wait until I'm done.`);
        return false;
      }
      try {
        await adapter.moveSelf(user.channelId);
      } catch (e) {
        await ctx.reply(`I couldn't join your channel (${errMessage(e)}). It may have a password, or I may lack permission there.`);
        return false;
      }
      cancelIdle();
      pending++;
      return true;
    });
  }

  async function requireControl(ctx: CommandContext): Promise<boolean> {
    if (ctx.isAdmin || (await ctx.withBot())) return true;
    await ctx.reply('You need to be in my channel to control playback.');
    return false;
  }

  function describe(t: { title: string; durationSec?: number; kind: string }): string {
    return t.kind === 'radio' ? `${t.title} [radio]` : `${t.title} [${formatDuration(t.durationSec)}]`;
  }

  /** Add resolved items to the queue, honouring size and length limits. Returns what was added. */
  function enqueue(items: MediaInfo[], kind: Track['kind'], ctx: CommandContext): { added: Track[]; skipped: number } {
    const room = Math.max(0, cfg.maxQueue - queue.size);
    const added: Track[] = [];
    let skipped = 0;
    for (const it of items) {
      const tooLong = it.durationSec !== undefined && it.durationSec > cfg.maxTrackMinutes * 60;
      if (tooLong || added.length >= room) {
        skipped++;
        continue;
      }
      added.push({
        id: nextId++,
        kind: it.kind ?? kind,
        title: it.title,
        url: it.url,
        durationSec: it.durationSec,
        requesterUid: ctx.msg.senderUid,
        requesterName: ctx.msg.senderName,
      });
    }
    queue.add(...added);
    return { added, skipped };
  }

  async function pump(): Promise<void> {
    if (pumping || !player) return;
    pumping = true;
    cancelIdle();
    try {
      for (let t = queue.next(); t; t = queue.next()) {
        const p = player;
        if (!p) break; // unloaded while the previous track was finishing
        if (cfg.announceNowPlaying) say(`Now playing: ${describe(t)} - requested by ${t.requesterName}`);

        // A radio station announces its current song inside the stream; read it on the side.
        let stopTitles: (() => void) | undefined;
        liveTitle = undefined;
        if (t.kind === 'radio' && cfg.radioNowPlaying && /^https?:\/\//i.test(t.url)) {
          stopTitles = deps.startRadioTitles(
            t.url,
            (title) => {
              liveTitle = title;
              if (cfg.announceRadioTitles) say(`Now on ${t.title}: ${title}`);
            },
            (note) => log.debug(`radio titles for ${t.title}: ${note}`),
          );
        }
        let r;
        try {
          r = await p.play(t);
        } finally {
          stopTitles?.();
          liveTitle = undefined;
        }
        if (r.reason === 'error') say(`Couldn't play "${t.title}": ${r.error ?? 'unknown error'}`);
      }
    } finally {
      pumping = false;
      queue.finish();
      scheduleIdle();
    }
  }

  /** Shared path for !play and !radio once the input has been resolved into items. */
  async function queueRequest(ctx: CommandContext, kind: Track['kind'], resolve: () => Promise<MediaInfo[]>, label?: string): Promise<void> {
    if (queue.size >= cfg.maxQueue) {
      await ctx.reply(`The queue is full (${cfg.maxQueue} tracks).`);
      return;
    }
    if (!(await followCaller(ctx))) return;

    // followCaller() left us holding a `pending` claim; always release it, whatever happens.
    const addedAny = await (async (): Promise<boolean> => {
      try {
        const wasIdle = !pl().playing && queue.size === 0;
        const items = await resolve();
        const { added, skipped } = enqueue(items, kind, ctx);
        if (!added.length) {
          await ctx.reply(
            skipped
              ? `Nothing was added - tracks longer than ${cfg.maxTrackMinutes} minutes are skipped, and the queue holds ${cfg.maxQueue}.`
              : 'Nothing to add.',
          );
          return false;
        }
        if (added.length === 1) {
          const where = wasIdle ? 'starting now' : `position ${queue.size}`;
          await ctx.reply(`Queued: ${describe(added[0]!)} (${where})`);
        } else {
          await ctx.reply(`Queued ${added.length} tracks${label ? ` from "${label}"` : ''}${skipped ? ` (${skipped} skipped)` : ''}.`);
        }
        return true;
      } catch (e) {
        await ctx.reply(e instanceof SourceError ? e.message : `That didn't work: ${errMessage(e)}`);
        log.warn(`request "${ctx.rest}" failed: ${errMessage(e)}`);
        return false;
      } finally {
        pending--;
      }
    })();

    if (addedAny) void pump();
    else scheduleIdle();
  }

  // ---- commands ------------------------------------------------------------------------

  const cog: Cog = {
    commands: [
      {
        name: 'play',
        aliases: ['p'],
        description: 'Queue a YouTube link, another supported link, or search text. I join your channel if I am idle.',
        usage: `${p}play <link or search words>`,
        run: async (ctx) => {
          if (!ctx.rest) {
            if (pl().paused && (await requireControl(ctx))) {
              pl().resume();
              return ctx.reply('Resumed.');
            }
            return ctx.reply(`Usage: ${p}play <link or search words>`);
          }
          await queueRequest(ctx, 'media', () => deps.resolveMedia(ctx.rest, cfg));
        },
      },
      {
        name: 'radio',
        description: 'Play a radio station (no argument lists them). Also accepts a direct stream URL.',
        usage: `${p}radio [number | name | stream URL]`,
        run: async (ctx) => {
          if (!ctx.rest) {
            const list = listStations(cfg)
              .map((s, i) => `${i + 1}. ${s.name} (${s.key})`)
              .join('\n');
            return ctx.reply(`Radio stations:\n${list}\nUse ${p}radio <number or name>`);
          }
          const hit = resolveRadio(ctx.rest, cfg);
          if (!hit) return ctx.reply(`I don't know that station. ${p}radio lists them.`);
          await queueRequest(ctx, 'radio', async () => [hit]);
        },
      },
      {
        name: 'queue',
        aliases: ['q'],
        description: 'Show what is playing and what is next',
        run: (ctx) => {
          const lines: string[] = [];
          const cur = queue.current;
          lines.push(cur ? `Now: ${describe(cur)} - ${cur.requesterName}` : 'Nothing is playing.');
          const up = queue.upcoming;
          if (up.length) {
            lines.push(`Up next (${up.length}):`);
            up.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${describe(t)} - ${t.requesterName}`));
            if (up.length > 10) lines.push(`...and ${up.length - 10} more`);
          }
          return ctx.reply(lines.join('\n'));
        },
      },
      {
        name: 'np',
        aliases: ['nowplaying'],
        description: 'Show the current track',
        run: (ctx) => {
          const cur = queue.current;
          if (!cur || !pl().playing) return ctx.reply('Nothing is playing.');
          const pos = formatDuration(pl().positionSec);
          const total = cur.kind === 'radio' ? 'live' : formatDuration(cur.durationSec);
          const now = cur.kind === 'radio' && liveTitle ? ` - now: ${liveTitle}` : '';
          return ctx.reply(`${cur.title} - ${pos} / ${total}${now}${pl().paused ? ' (paused)' : ''} - requested by ${cur.requesterName}`);
        },
      },
      {
        name: 'skip',
        aliases: ['next'],
        description: 'Skip the current track',
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          const cur = queue.current;
          if (!cur || !pl().playing) return ctx.reply('Nothing is playing.');
          pl().stop();
          return ctx.reply(`Skipped: ${cur.title}`);
        },
      },
      {
        name: 'stop',
        description: 'Stop playback and clear the queue',
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          const n = stopEverything();
          return ctx.reply(n ? `Stopped and cleared ${n} queued track${n === 1 ? '' : 's'}.` : 'Stopped.');
        },
      },
      {
        name: 'pause',
        description: 'Pause playback',
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          if (!pl().playing) return ctx.reply('Nothing is playing.');
          if (queue.current?.kind === 'radio') {
            pl().stop();
            return ctx.reply(`Radio cannot be paused, so I stopped it. Use ${p}radio to start it again.`);
          }
          pl().pause();
          return ctx.reply(`Paused. ${p}resume to continue.`);
        },
      },
      {
        name: 'resume',
        aliases: ['unpause'],
        description: 'Resume playback',
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          return ctx.reply(pl().resume() ? 'Resumed.' : 'Nothing is paused.');
        },
      },
      {
        name: 'clear',
        description: 'Clear the queue but keep the current track playing',
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          const n = queue.clear();
          return ctx.reply(`Cleared ${n} track${n === 1 ? '' : 's'}.`);
        },
      },
      {
        name: 'remove',
        description: 'Remove a queued track by its position',
        usage: `${p}remove <position>`,
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          const t = queue.remove(Number(ctx.args[0]));
          return ctx.reply(t ? `Removed: ${t.title}` : `Give me a position from ${p}queue.`);
        },
      },
      {
        name: 'shuffle',
        description: 'Shuffle the queue',
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          queue.shuffle();
          return ctx.reply(`Shuffled ${queue.size} tracks.`);
        },
      },
      {
        name: 'volume',
        aliases: ['vol'],
        description: 'Show or set the volume (0-100)',
        usage: `${p}volume [0-100]`,
        run: async (ctx) => {
          const cur = Math.round(pl().volume * 100);
          if (!ctx.args.length) return ctx.reply(`Volume is ${cur}.`);
          if (!(await requireControl(ctx))) return;
          const n = Number(ctx.args[0]);
          if (!Number.isFinite(n) || n < 0 || n > 100) return ctx.reply('Volume must be a number from 0 to 100.');
          pl().volume = Math.round(n) / 100;
          bot.state.set('audio.volume', Math.round(n));
          return ctx.reply(`Volume set to ${Math.round(n)}.`);
        },
      },
      {
        name: 'summon',
        aliases: ['join'],
        description: 'Bring me to your channel',
        run: async (ctx) => {
          const user = await ctx.user();
          if (!user || user.channelId === 0n) return ctx.reply("I can't tell which channel you're in.");
          const here = adapter.selfChannelId();
          if (user.channelId === here) return ctx.reply("I'm already here.");
          if (busy() && !ctx.isAdmin) return ctx.reply(`I'm playing in "${channelName(here)}" right now. Join me there, or wait until I'm done.`);
          try {
            await adapter.moveSelf(user.channelId);
            cancelIdle();
            scheduleIdle();
            return ctx.reply(`Joined "${channelName(user.channelId)}".`);
          } catch (e) {
            return ctx.reply(`I couldn't join your channel (${errMessage(e)}).`);
          }
        },
      },
      {
        name: 'leave',
        aliases: ['home'],
        description: 'Stop playing and go back to the home channel',
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          stopEverything();
          await new Promise((r) => setTimeout(r, 250));
          await goHome();
          return ctx.reply('Heading home.');
        },
      },
    ],

    onLoad() {
      player = deps.createPlayer({
        ffmpegPath: cfg.ffmpegPath,
        ytdlpPath: cfg.ytdlpPath,
        ytdlpExtraArgs: cfg.ytdlpExtraArgs,
        bitrate: cfg.bitrate,
        codec: cfg.codec,
        send: (frame, codec) => adapter.sendVoice(frame, codec),
        log,
      });
      player.volume = bot.state.get<number>('audio.volume', cfg.defaultVolume) / 100;
      // Losing the TeamSpeak connection means nobody is listening: drop everything.
      offLost = bot.events.on('lost', () => {
        stopEverything();
      });
      watchTimer = setInterval(watchChannel, 5_000);
      watchTimer.unref?.();
      unprovide = bot.services.provide<AudioService>(AUDIO_SERVICE, {
        snapshot() {
          const item = (t: Track): QueueItem => ({ kind: t.kind, title: t.title, url: t.url, durationSec: t.durationSec });
          return {
            current: queue.current && player?.playing ? { ...item(queue.current), id: queue.current.id, liveTitle } : undefined,
            upcoming: queue.upcoming.map(item),
          };
        },
        queue: (ctx, items, opts) => queueRequest(ctx, 'media', async () => items, opts?.label),
        state() {
          const item = (t: Track): QueueItem => ({ kind: t.kind, title: t.title, url: t.url, durationSec: t.durationSec });
          const playing = !!player?.playing;
          return {
            playing,
            paused: !!player?.paused,
            volume: Math.round((player?.volume ?? 0) * 100),
            positionSec: player?.positionSec ?? 0,
            current: queue.current && playing ? { ...item(queue.current), id: queue.current.id, liveTitle } : undefined,
            upcoming: queue.upcoming.map(item),
          };
        },
        skip() {
          if (!player?.playing) return false;
          player.stop();
          return true;
        },
        resolve: async (input) => {
          const found = await deps.resolveMedia(input, cfg);
          return found.map((it) => ({ kind: it.kind ?? 'media', title: it.title, url: it.url, durationSec: it.durationSec }));
        },
      });
    },

    onUnload() {
      offLost?.();
      unprovide?.();
      if (watchTimer) clearInterval(watchTimer);
      cancelIdle();
      queue.clear();
      player?.dispose();
      player = undefined;
    },

    async status() {
      const cur = queue.current;
      const now = Date.now();
      if (!versionCache || now - versionCache.at > 300_000) {
        const [yt, ff] = await Promise.all([deps.toolVersion(cfg.ytdlpPath, ['--version']), deps.toolVersion(cfg.ffmpegPath, ['-version'])]);
        versionCache = { at: now, text: `yt-dlp ${yt} | ffmpeg ${ff}` };
      }
      const state = cur && player?.playing ? `playing "${cur.title}"` : 'idle';
      return `${state} | queue ${queue.size} | volume ${Math.round((player?.volume ?? 0) * 100)} | ${versionCache.text}`;
    },
  };

  return cog;
}

const factory: CogFactory = (bot) => createAudioCog(bot);
export default factory;
