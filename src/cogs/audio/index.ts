import { join } from 'node:path';
import type { TsUser } from '../../adapter/types.js';
import type { BotApi, Cog, CogFactory, CogManifest, CommandContext } from '../../core/types.js';
import { AUDIO_SERVICE, PLAYLISTS_SERVICE, type AudioService, type AudioState, type PlaylistsService, type QueueItem, type RepeatMode, type SearchResult, type ToolsInfo, type TrollSettings } from '../../core/services.js';
import { Mutex } from '../../util/mutex.js';
import { errMessage, formatAgo, formatDuration } from '../../util/text.js';
import { PlayHistory } from './history.js';
import { startIcyTitles } from './icy.js';
import { Player, type PlayerLike, type PlayerOptions } from './player.js';
import { TrackQueue, type Track } from './queue.js';
import { parseSeek } from './seek.js';
import { checkYoutube, listStations, resolveMedia, resolveRadio, searchMedia, SourceError, toolVersion, updateYtdlp, type MediaInfo } from './sources.js';

export const manifest: CogManifest = {
  name: 'audio',
  version: '1.2.0',
  description: 'Music: YouTube/links + radio, follows whoever calls it',
};

/** Seams so the cog's logic can be tested without yt-dlp, ffmpeg or a TeamSpeak server. */
export interface AudioDeps {
  resolveMedia: typeof resolveMedia;
  createPlayer: (opts: PlayerOptions) => PlayerLike;
  toolVersion: typeof toolVersion;
  searchMedia: typeof searchMedia;
  checkYoutube: typeof checkYoutube;
  updateYtdlp: typeof updateYtdlp;
  /** Start reading a radio station's song titles. Returns a function that stops. */
  startRadioTitles: (url: string, onTitle: (title: string) => void, note: (message: string) => void) => () => void;
}

const defaultDeps: AudioDeps = {
  resolveMedia,
  createPlayer: (o) => new Player(o),
  toolVersion,
  searchMedia,
  checkYoutube,
  updateYtdlp,
  startRadioTitles: (url, onTitle, note) => startIcyTitles(url, { onTitle, onNote: note }),
};

/** After someone uses !stop, Auto-DJ stays quiet for this long, so it does not undo what they asked for. */
const AUTODJ_STOP_PAUSE_MS = 10 * 60_000;
const MAX_BLOCK_MINUTES = 7 * 24 * 60;

interface Block {
  uid: string;
  name: string;
  /** When the block ends (ms since 1970). Missing = until an admin lifts it. */
  until?: number;
}

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
  let repeat: RepeatMode = 'off';
  /** Set by !seek: the position to resume the same track from once the current run has stopped. */
  let pendingSeek: number | undefined;
  /** Set when everything was stopped on purpose, so the pump does not repeat or replay what was just stopped. */
  let halted = false;
  let autoDj = bot.state.get<{ enabled: boolean; source: string }>('audio.autodj', { enabled: cfg.autoDj.enabled, source: cfg.autoDj.source });
  let stay = bot.state.get<boolean>('audio.stay', cfg.stayInChannel);
  let autoDjPausedUntil = 0;
  let autoDjBusy = false;
  let autoDjWarned = '';
  let lastAutoUrl = '';
  const history = new PlayHistory(join(bot.dataDir, 'history.json'));
  /** What each person's last !search found, so !pick <number> knows what they meant. */
  const searchResults = new Map<string, { at: number; items: MediaInfo[] }>();
  let toolInfo: { ytdlp: string; ffmpeg: string; at: number } | undefined;
  let lastHealth: { ok: boolean; message: string; at: number } | undefined;
  let healthFailStreak = 0;
  let updatingYtdlp = false;
  let healthTimer: NodeJS.Timeout | undefined;
  let healthFirstTimer: NodeJS.Timeout | undefined;
  let healthRetryTimer: NodeJS.Timeout | undefined;

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
    if (stay) return; // 24/7 mode: the bot stays where it is
    if (!player || busy()) return; // no player = the cog was unloaded while a track was finishing
    idleTimer = setTimeout(() => void goHome(), bot.config.follow.idleReturnSeconds * 1000);
    idleTimer.unref?.();
  }

  /** Stop and clear the queue. `byPerson` = someone asked for it, so Auto-DJ holds off for a while. */
  function stopEverything(byPerson = false): number {
    halted = true;
    if (byPerson) autoDjPausedUntil = Date.now() + AUTODJ_STOP_PAUSE_MS;
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
    if (stay) {
      // 24/7 mode never goes home, but there is no point streaming Auto-DJ to an empty room; it starts again when someone joins
      if (autoOnly()) {
        log.info('alone in channel - pausing Auto-DJ until someone joins');
        stopEverything();
      }
      return;
    }
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

  // ---- keeping trolls out ---------------------------------------------------------------

  /** People blocked from the music commands. Blocks that have run out are dropped as they are noticed. */
  function blockList(): Block[] {
    const all = bot.state.get<Block[]>('audio.blocked', []);
    const now = Date.now();
    const live = all.filter((b) => !b.until || b.until > now);
    if (live.length !== all.length) bot.state.set('audio.blocked', live);
    return live;
  }
  const isBlocked = (uid: string): boolean => !bot.isAdmin(uid) && blockList().some((b) => b.uid === uid);
  const blockedWords = (): string[] => [...new Set([...cfg.blockedWords, ...bot.state.get<string[]>('audio.blockedWords', [])].map((w) => w.toLowerCase()))];

  function blockedNotice(uid: string): string {
    const until = blockList().find((b) => b.uid === uid)?.until;
    return until ? `You are blocked from the music commands for another ${Math.max(1, Math.ceil((until - Date.now()) / 60_000))} minute(s).` : 'You are blocked from the music commands.';
  }

  /** Who did they mean? A name (exact, or a part that fits one person) or #<client id> for certainty. */
  function findUser(arg: string): { user?: TsUser; problem?: string } {
    const want = arg.trim();
    if (!want) return { problem: 'Tell me who: a name, or #<number> from the dashboard.' };
    const users = adapter.users();
    const byId = /^#(\d{1,9})$/.exec(want);
    if (byId) {
      const u = users.find((x) => x.id === Number(byId[1]));
      return u ? { user: u } : { problem: `Nobody with the number ${byId[1]} is online.` };
    }
    const lower = want.toLowerCase();
    const exact = users.filter((u) => u.name.toLowerCase() === lower);
    const hits = exact.length ? exact : users.filter((u) => u.name.toLowerCase().includes(lower));
    if (hits.length === 1) return { user: hits[0]! };
    if (hits.length === 0) return { problem: `I can only find people who are online now, and nobody is called "${want}".` };
    return { problem: `More than one person fits: ${hits.map((u) => `${u.name} (#${u.id})`).join(', ')}. Use the #number.` };
  }

  // ---- keeping it working: tool versions and the YouTube check ------------------------

  /** Versions of yt-dlp and ffmpeg, looked up at most every five minutes (or when forced). */
  async function refreshTools(force = false): Promise<NonNullable<typeof toolInfo>> {
    const now = Date.now();
    if (!toolInfo || force || now - toolInfo.at > 300_000) {
      const [ytdlp, ffmpeg] = await Promise.all([deps.toolVersion(cfg.ytdlpPath, ['--version']), deps.toolVersion(cfg.ffmpegPath, ['-version'])]);
      toolInfo = { ytdlp, ffmpeg, at: now };
    }
    return toolInfo;
  }

  function tellAdmins(text: string): void {
    for (const u of adapter.users()) {
      if (bot.isAdmin(u.uid)) adapter.sendPrivate(u.id, text).catch((e) => log.debug(`could not tell ${u.name}: ${errMessage(e)}`));
    }
  }

  /** Run the YouTube check. A failure is checked once more a few minutes later before the admins are told. */
  async function runHealthCheck(retryLater = true): Promise<{ ok: boolean; message: string; ms: number }> {
    const r = await deps.checkYoutube(cfg);
    lastHealth = { ok: r.ok, message: r.message, at: Date.now() };
    if (r.ok) {
      if (healthFailStreak >= 2) tellAdmins('YouTube playback is working again.');
      healthFailStreak = 0;
    } else {
      healthFailStreak++;
      log.warn(`YouTube check failed: ${r.message}`);
      if (healthFailStreak === 2) tellAdmins(`YouTube playback looks broken: ${r.message}`);
      if (healthFailStreak === 1 && retryLater && cfg.healthCheckHours > 0) {
        healthRetryTimer = setTimeout(() => void runHealthCheck(false), Math.min(300_000, cfg.healthCheckHours * 3_600_000));
        healthRetryTimer.unref?.();
      }
    }
    return r;
  }

  // ---- Auto-DJ ------------------------------------------------------------------------

  /** Auto-DJ is the only thing on: nothing a person asked for is playing or waiting. */
  const autoOnly = (): boolean => !!queue.current?.auto && queue.upcoming.every((t) => t.auto) && pending === 0;
  const listeners = (): number => adapter.usersInChannel(adapter.selfChannelId()).length;

  function sourceName(source: string): string {
    const m = /^(radio|playlist):(.*)$/.exec(source);
    if (!m) return '';
    if (m[1] === 'playlist') return m[2]!;
    const key = m[2]!.toLowerCase();
    const st = listStations(cfg).find((x, i) => x.key.toLowerCase() === key || String(i + 1) === key);
    return st ? st.name : m[2]!;
  }

  /** What Auto-DJ would play next, or undefined (with a note in the log, once) if the source cannot supply anything. */
  function pickAutoDj(): QueueItem | undefined {
    const m = /^(radio|playlist):(.+)$/.exec(autoDj.source);
    const warn = (why: string): undefined => {
      if (autoDjWarned !== why) log.warn(`Auto-DJ: ${why}`);
      autoDjWarned = why;
      return undefined;
    };
    if (!m) return warn(`"${autoDj.source}" is not a source I understand (use radio:<station> or playlist:<name>)`);
    if (m[1] === 'radio') {
      const hit = resolveRadio(m[2]!, cfg);
      return hit ? { kind: 'radio', title: hit.title, url: hit.url } : warn(`there is no radio station "${m[2]}"`);
    }
    const list = bot.services.get<PlaylistsService>(PLAYLISTS_SERVICE)?.tracks(m[2]!);
    if (!list?.length) return warn(`the playlist "${m[2]}" is missing or empty (is the playlists cog loaded?)`);
    autoDjWarned = '';
    const fresh = list.length > 1 ? list.filter((t) => t.url !== lastAutoUrl) : list; // do not play the same song twice in a row
    return fresh[Math.floor(Math.random() * fresh.length)];
  }

  /** If Auto-DJ is on and someone is listening, start something. Safe to call as often as you like. */
  async function autoDjTick(): Promise<void> {
    if (autoDjBusy || !autoDj.enabled || !autoDj.source || !player || !adapter.connected) return;
    if (busy() || Date.now() < autoDjPausedUntil || listeners() === 0) return;
    autoDjBusy = true;
    try {
      const item = pickAutoDj();
      if (!item || busy()) return;
      autoDjWarned = '';
      lastAutoUrl = item.url;
      queue.add({ id: nextId++, kind: item.kind, title: item.title, url: item.url, durationSec: item.durationSec, requesterUid: '', requesterName: 'Auto-DJ', auto: true });
      log.info(`Auto-DJ picked "${item.title}"`);
      void pump();
    } finally {
      autoDjBusy = false;
    }
  }

  function saveAutoDj(next: { enabled: boolean; source: string }): void {
    autoDj = next;
    bot.state.set('audio.autodj', next);
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
      // Auto-DJ playing to an empty room is not worth protecting: a person asking for something wins.
      const freeToMove = autoOnly() && listeners() === 0;
      if (busy() && !freeToMove) {
        await ctx.reply(`I'm playing in "${channelName(here)}" right now. Join me there, or wait until I'm done.`);
        return false;
      }
      pending++; // claim the bot for this caller right away, so Auto-DJ cannot slip in while it moves
      if (freeToMove) stopEverything();
      try {
        await adapter.moveSelf(user.channelId);
      } catch (e) {
        pending--;
        await ctx.reply(`I couldn't join your channel (${errMessage(e)}). It may have a password, or I may lack permission there.`);
        return false;
      }
      cancelIdle();
      return true;
    });
  }

  async function requireControl(ctx: CommandContext): Promise<boolean> {
    if (!ctx.isAdmin && isBlocked(ctx.msg.senderUid)) {
      await ctx.reply(blockedNotice(ctx.msg.senderUid));
      return false;
    }
    if (ctx.isAdmin || (await ctx.withBot())) return true;
    await ctx.reply('You need to be in my channel to control playback.');
    return false;
  }

  function describe(t: { title: string; durationSec?: number; kind: string }): string {
    return t.kind === 'radio' ? `${t.title} [radio]` : `${t.title} [${formatDuration(t.durationSec)}]`;
  }

  /** Add resolved items to the queue, honouring the size, length, per-person and blocked-word limits. Returns what happened. */
  function enqueue(items: MediaInfo[], kind: Track['kind'], ctx: CommandContext): { added: Track[]; skipped: number; overLimit: number; blocked: number } {
    const room = Math.max(0, cfg.maxQueue - queue.size);
    const uid = ctx.msg.senderUid;
    const words = ctx.isAdmin ? [] : blockedWords();
    const limit = ctx.isAdmin ? 0 : cfg.maxQueuePerUser;
    let mine = (queue.current?.requesterUid === uid ? 1 : 0) + queue.upcoming.filter((t) => t.requesterUid === uid).length;
    const added: Track[] = [];
    let skipped = 0;
    let overLimit = 0;
    let blocked = 0;
    for (const it of items) {
      if (words.length && words.some((w) => it.title.toLowerCase().includes(w) || it.url.toLowerCase().includes(w))) {
        blocked++;
        continue;
      }
      if (limit > 0 && mine >= limit) {
        overLimit++;
        continue;
      }
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
        requesterUid: uid,
        requesterName: ctx.msg.senderName,
      });
      mine++;
    }
    queue.add(...added);
    return { added, skipped, overLimit, blocked };
  }

  async function pump(): Promise<void> {
    if (pumping || !player) return;
    pumping = true;
    cancelIdle();
    try {
      let t = queue.next();
      let startAt = 0;
      let announce = true;
      let radioTries = 0;
      while (t) {
        const p = player;
        if (!p) break; // unloaded while the previous track was finishing
        const track = t; // (a fixed name for the closures below; `t` changes as the loop goes on)
        halted = false;
        pendingSeek = undefined;
        if (announce) {
          radioTries = 0;
          history.add({ kind: t.kind, title: t.title, url: t.url, durationSec: t.durationSec, byName: t.auto ? 'Auto-DJ' : t.requesterName, ...(t.auto ? { auto: true } : {}) });
          if (cfg.announceNowPlaying && !t.auto) say(`Now playing: ${describe(t)} - requested by ${t.requesterName}`);
        }
        announce = true;

        // A radio station announces its current song inside the stream; read it on the side.
        let stopTitles: (() => void) | undefined;
        liveTitle = undefined;
        if (t.kind === 'radio' && cfg.radioNowPlaying && /^https?:\/\//i.test(t.url)) {
          stopTitles = deps.startRadioTitles(
            t.url,
            (title) => {
              liveTitle = title;
              if (cfg.announceRadioTitles) say(`Now on ${track.title}: ${title}`);
            },
            (note) => log.debug(`radio titles for ${track.title}: ${note}`),
          );
        }
        let r;
        const from = startAt;
        startAt = 0;
        try {
          r = await p.play({ kind: t.kind, url: t.url, startSec: from });
        } finally {
          stopTitles?.();
          liveTitle = undefined;
        }
        // A live station never ends on purpose, so one that drops (or fails part-way) is reconnected, then swapped for the fallback.
        const dropped = !halted && track.kind === 'radio' && (r.reason === 'ended' || (r.reason === 'error' && !/was not found|no such file/i.test(r.error ?? '')));
        if (dropped && r.seconds >= 60) radioTries = 0; // it ran well for a while, so this is a fresh drop
        if (dropped && radioTries < cfg.radioRetries) {
          const wait = cfg.radioRetrySeconds * [1, 2.5, 7][Math.min(radioTries, 2)]! * 1000;
          radioTries++;
          log.warn(`radio "${track.title}" dropped (${r.reason === 'error' ? (r.error ?? 'error') : 'stream ended'}); reconnecting ${radioTries}/${cfg.radioRetries}`);
          if (!track.auto && radioTries === 1) say(`"${track.title}" dropped - reconnecting...`);
          await new Promise((res) => setTimeout(res, wait));
          if (!halted && player) {
            announce = false;
            continue; // the same station again
          }
          t = queue.next();
          continue;
        }
        if (dropped) {
          const fb = cfg.radioFallback && !track.fellBack ? resolveRadio(cfg.radioFallback, cfg) : undefined;
          if (fb && fb.url !== track.url) {
            log.warn(`radio "${track.title}" is not working; switching to "${fb.title}"`);
            if (!track.auto) say(`"${track.title}" isn't working, so I switched to "${fb.title}".`);
            t = { ...track, id: nextId++, title: fb.title, url: fb.url, durationSec: undefined, fellBack: true };
            queue.setCurrent(t);
            radioTries = 0;
            announce = false;
            continue;
          }
        }
        if (r.reason === 'error') {
          if (track.auto) {
            // Do not chatter about Auto-DJ's own trouble, and do not keep hammering a source that is failing.
            log.warn(`Auto-DJ could not play "${track.title}": ${r.error ?? 'unknown error'}`);
            autoDjPausedUntil = Date.now() + 60_000;
          } else {
            say(`Couldn't play "${t.title}": ${r.error ?? 'unknown error'}`);
          }
        } else if (dropped && !track.auto && cfg.radioRetries > 0) {
          say(`"${track.title}" stopped and I couldn't reconnect.`);
        }

        // What comes next? A seek plays the same track again from the new spot.
        if (!halted && r.reason === 'stopped' && pendingSeek !== undefined) {
          startAt = pendingSeek;
          pendingSeek = undefined;
          announce = false;
          continue;
        }
        pendingSeek = undefined;

        // Repeat, for tracks (not live radio, not Auto-DJ picks) that were not stopped on purpose and did not fail.
        if (!halted && repeat !== 'off' && t.kind !== 'radio' && !t.auto && r.reason !== 'error') {
          if (repeat === 'track' && r.reason === 'ended') {
            t = { ...t, id: nextId++ };
            queue.setCurrent(t);
            announce = false;
            continue;
          }
          if (repeat === 'queue') queue.add({ ...t, id: nextId++ });
        }
        t = queue.next();
      }
    } finally {
      pumping = false;
      queue.finish();
      scheduleIdle();
      void autoDjTick();
    }
  }

  /** Shared path for !play and !radio once the input has been resolved into items. */
  async function queueRequest(ctx: CommandContext, kind: Track['kind'], resolve: () => Promise<MediaInfo[]>, label?: string): Promise<void> {
    if (!ctx.isAdmin && isBlocked(ctx.msg.senderUid)) {
      await ctx.reply(blockedNotice(ctx.msg.senderUid));
      return;
    }
    if (queue.size >= cfg.maxQueue) {
      await ctx.reply(`The queue is full (${cfg.maxQueue} tracks).`);
      return;
    }
    if (!(await followCaller(ctx))) return;

    // followCaller() left us holding a `pending` claim; always release it, whatever happens.
    const addedAny = await (async (): Promise<boolean> => {
      try {
        // (Auto-DJ alone does not count as busy: the request will take its place)
        const wasIdle = (!pl().playing && queue.size === 0) || (!!queue.current?.auto && queue.size === 0);
        const items = await resolve();
        const { added, skipped, overLimit, blocked } = enqueue(items, kind, ctx);
        if (!added.length) {
          await ctx.reply(
            overLimit
              ? `You already have as many tracks queued as you are allowed (${cfg.maxQueuePerUser}). Wait for one to play first.`
              : blocked
                ? "That one isn't allowed here."
                : skipped
                  ? `Nothing was added - tracks longer than ${cfg.maxTrackMinutes} minutes are skipped, and the queue holds ${cfg.maxQueue}.`
                  : 'Nothing to add.',
          );
          return false;
        }
        // A person's request goes ahead of Auto-DJ.
        if (queue.current?.auto && pl().playing) pl().stop();
        const left = skipped + overLimit + blocked;
        if (added.length === 1) {
          const where = wasIdle ? 'starting now' : `position ${queue.size}`;
          await ctx.reply(`Queued: ${describe(added[0]!)} (${where})`);
        } else {
          await ctx.reply(`Queued ${added.length} tracks${label ? ` from "${label}"` : ''}${left ? ` (${left} skipped)` : ''}.`);
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
          if (repeat !== 'off') lines.push(`Repeat: ${repeat}`);
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
          const n = stopEverything(true);
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
        name: 'seek',
        description: 'Jump to a time in the current track: 1:30, 90, +30 or -30',
        usage: `${p}seek <1:30 | 90 | +30 | -30>`,
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          const cur = queue.current;
          if (!cur || !pl().playing) return ctx.reply('Nothing is playing.');
          if (cur.kind === 'radio') return ctx.reply("Live radio has no position to jump to.");
          const to = parseSeek(ctx.args[0], pl().positionSec);
          if (to === undefined) return ctx.reply(`Usage: ${p}seek <1:30 | 90 | +30 | -30>`);
          if (cur.durationSec !== undefined && to >= cur.durationSec) return ctx.reply(`That is past the end (${formatDuration(cur.durationSec)}).`);
          pendingSeek = to;
          pl().stop();
          return ctx.reply(`Jumping to ${formatDuration(to)}.`);
        },
      },
      {
        name: 'repeat',
        aliases: ['loop'],
        description: 'Repeat the current track, the whole queue, or nothing',
        usage: `${p}repeat [off|track|queue]`,
        run: async (ctx) => {
          const want = ctx.args[0]?.toLowerCase();
          if (!want) return ctx.reply(`Repeat is ${repeat}. ${p}repeat off, track or queue changes it.`);
          if (want !== 'off' && want !== 'track' && want !== 'queue') return ctx.reply(`Usage: ${p}repeat [off|track|queue]`);
          if (!(await requireControl(ctx))) return;
          repeat = want;
          return ctx.reply(
            want === 'off' ? 'Repeat is off.' : want === 'track' ? 'Repeating the current track. Live radio is never repeated.' : 'Repeating the queue: each track goes to the back once it has played.',
          );
        },
      },
      {
        name: 'move',
        description: 'Move a queued track to another position',
        usage: `${p}move <from> <to>`,
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          const t = queue.move(Number(ctx.args[0]), Number(ctx.args[1]));
          return ctx.reply(t ? `Moved "${t.title}" to position ${Number(ctx.args[1])}.` : `Usage: ${p}move <from> <to>, using positions from ${p}queue.`);
        },
      },
      {
        name: 'search',
        description: 'Search YouTube and choose from the results: !search <words>, then !pick <number>',
        usage: `${p}search <words>`,
        run: async (ctx) => {
          if (!ctx.isAdmin && isBlocked(ctx.msg.senderUid)) return ctx.reply(blockedNotice(ctx.msg.senderUid));
          if (!ctx.rest) return ctx.reply(`Usage: ${p}search <words>`);
          try {
            const items = await deps.searchMedia(ctx.rest, cfg, 5);
            const now = Date.now();
            for (const [k, v] of searchResults) if (now - v.at > 300_000) searchResults.delete(k);
            if (searchResults.size > 200) searchResults.clear();
            searchResults.set(ctx.msg.senderUid, { at: now, items });
            const lines = items.map((it, i) => `${i + 1}. ${it.title} [${formatDuration(it.durationSec)}]${it.by ? ` - ${it.by}` : ''}`);
            return ctx.reply(`Results for "${ctx.rest.slice(0, 60)}":\n${lines.join('\n')}\nUse ${p}pick <number> to queue one.`);
          } catch (e) {
            return ctx.reply(e instanceof SourceError ? e.message : `That didn't work: ${errMessage(e)}`);
          }
        },
      },
      {
        name: 'pick',
        description: 'Queue one of the results from your last !search',
        usage: `${p}pick <number>`,
        run: async (ctx) => {
          const found = searchResults.get(ctx.msg.senderUid);
          if (!found || Date.now() - found.at > 300_000) return ctx.reply(`Search first: ${p}search <words>`);
          const n = Number(ctx.args[0]);
          const it = Number.isInteger(n) ? found.items[n - 1] : undefined;
          if (!it) return ctx.reply(`Pick a number from 1 to ${found.items.length}.`);
          await queueRequest(ctx, 'media', async () => [it]);
        },
      },
      {
        name: 'history',
        aliases: ['recent'],
        description: 'Show what was played recently',
        usage: `${p}history [how many]`,
        run: (ctx) => {
          const n = Math.max(1, Math.min(20, Math.floor(Number(ctx.args[0])) || 10));
          const list = history.recent(n);
          if (!list.length) return ctx.reply('Nothing has been played yet.');
          const lines = list.map((e) => `#${e.id} ${e.title}${e.kind === 'radio' ? ' [radio]' : ` [${formatDuration(e.durationSec)}]`} - ${e.byName}, ${formatAgo(e.at)}`);
          return ctx.reply(`Recently played:\n${lines.join('\n')}\nUse ${p}again <#number> to play one again.`);
        },
      },
      {
        name: 'again',
        aliases: ['replay'],
        description: 'Play something from !history again',
        usage: `${p}again <number from ${p}history>`,
        run: async (ctx) => {
          const id = Number((ctx.args[0] ?? '').replace('#', ''));
          const e = Number.isInteger(id) ? history.get(id) : undefined;
          if (!e) return ctx.reply(`I don't have that one. ${p}history lists what was played.`);
          await queueRequest(ctx, e.kind, async () => [{ kind: e.kind, title: e.title, url: e.url, durationSec: e.durationSec }]);
        },
      },
      {
        name: 'tools',
        description: 'Show the yt-dlp and ffmpeg versions and the last YouTube check (bot admins only)',
        perm: 'admin',
        run: async (ctx) => {
          const t = await refreshTools();
          const h = lastHealth ? `${lastHealth.ok ? 'OK' : 'PROBLEM'} ${formatAgo(lastHealth.at)}: ${lastHealth.message}` : `not checked yet (${p}ytcheck runs it)`;
          return ctx.reply(`yt-dlp ${t.ytdlp} | ffmpeg ${t.ffmpeg}\nYouTube: ${h}${updatingYtdlp ? '\nyt-dlp is being updated right now.' : ''}`);
        },
      },
      {
        name: 'ytcheck',
        description: 'Check that YouTube playback still works (bot admins only)',
        perm: 'admin',
        run: async (ctx) => {
          await ctx.reply('Checking YouTube...');
          const r = await runHealthCheck(false);
          return ctx.reply(`${r.ok ? 'OK' : 'PROBLEM'} (${(r.ms / 1000).toFixed(1)} s): ${r.message}`);
        },
      },
      {
        name: 'ytupdate',
        description: 'Update yt-dlp, which fixes most YouTube problems (bot admins only)',
        perm: 'admin',
        run: async (ctx) => {
          if (updatingYtdlp) return ctx.reply('yt-dlp is already being updated.');
          updatingYtdlp = true;
          try {
            await ctx.reply('Updating yt-dlp (this can take a minute)...');
            const r = await deps.updateYtdlp(cfg);
            const t = await refreshTools(true);
            return ctx.reply(`${r.ok ? 'Done' : 'The update did not work'}. yt-dlp is now ${t.ytdlp}.\n${r.output}${r.ok ? `\nTip: ${p}ytcheck confirms YouTube works.` : ''}`);
          } finally {
            updatingYtdlp = false;
          }
        },
      },
      {
        name: 'autodj',
        description: 'Play something by itself when the queue is empty and someone is listening (bot admins only)',
        usage: `${p}autodj [on|off|source radio <station>|source playlist <name>]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          const show = (): string =>
            `Auto-DJ is ${autoDj.enabled ? 'on' : 'off'}. Source: ${autoDj.source ? `${sourceName(autoDj.source)} (${autoDj.source})` : 'none chosen yet'}.`;
          if (!sub) return ctx.reply(show());
          if (sub === 'on') {
            if (!autoDj.source) return ctx.reply(`Choose a source first: ${p}autodj source radio <station> or ${p}autodj source playlist <name>.`);
            saveAutoDj({ ...autoDj, enabled: true });
            autoDjPausedUntil = 0;
            void autoDjTick();
            return ctx.reply(`Auto-DJ is on (${sourceName(autoDj.source)}). It plays when the queue is empty and someone is in my channel.`);
          }
          if (sub === 'off') {
            saveAutoDj({ ...autoDj, enabled: false });
            if (queue.current?.auto && pl().playing) pl().stop();
            return ctx.reply('Auto-DJ is off.');
          }
          if (sub === 'source') {
            const m = /^source\s+(radio|playlist)\s+(.+)$/i.exec(ctx.rest.trim());
            if (!m) return ctx.reply(`Usage: ${p}autodj source radio <station number, name or stream address>, or ${p}autodj source playlist <name>`);
            const value = m[2]!.trim();
            let source: string;
            if (m[1]!.toLowerCase() === 'radio') {
              const hit = resolveRadio(value, cfg);
              if (!hit) return ctx.reply(`I don't know that station. ${p}radio lists them.`);
              const st = listStations(cfg).find((x) => x.url === hit.url);
              source = `radio:${st ? st.key : value}`;
            } else {
              const playlists = bot.services.get<PlaylistsService>(PLAYLISTS_SERVICE);
              if (!playlists) return ctx.reply('The playlists cog is not loaded.');
              const found = playlists.list().find((x) => x.name.toLowerCase() === value.toLowerCase());
              if (!found) return ctx.reply(`There is no playlist called "${value}". ${p}playlist list shows them.`);
              if (found.tracks === 0) return ctx.reply(`"${found.name}" has no tracks yet.`);
              source = `playlist:${found.name}`;
            }
            saveAutoDj({ ...autoDj, source });
            if (queue.current?.auto && pl().playing) pl().stop(); // so the new source takes over
            void autoDjTick();
            return ctx.reply(`Auto-DJ source is now ${sourceName(source)}. ${autoDj.enabled ? '' : `Turn it on with ${p}autodj on.`}`.trim());
          }
          return ctx.reply(`Usage: ${p}autodj [on|off|source radio <station>|source playlist <name>]`);
        },
      },
      {
        name: 'stay',
        aliases: ['247'],
        description: '24/7 mode: stay in the current channel instead of going home (bot admins only)',
        usage: `${p}stay [on|off]`,
        perm: 'admin',
        run: async (ctx) => {
          const want = ctx.args[0]?.toLowerCase();
          if (!want) return ctx.reply(`24/7 mode is ${stay ? 'on' : 'off'}. ${stay ? 'I stay in my channel and never go home by myself.' : 'I go home when idle or alone.'}`);
          if (want !== 'on' && want !== 'off') return ctx.reply(`Usage: ${p}stay [on|off]`);
          stay = want === 'on';
          bot.state.set('audio.stay', stay);
          if (stay) cancelIdle();
          else scheduleIdle();
          return ctx.reply(stay ? "24/7 mode is on. I'll stay in my current channel. After a restart I return to my home channel." : '24/7 mode is off.');
        },
      },
      {
        name: 'block',
        description: 'Block someone from the music commands: !block <name or #number> [minutes] (bot admins only)',
        usage: `${p}block <name or #number> [minutes]`,
        perm: 'admin',
        run: async (ctx) => {
          let who = findUser(ctx.rest);
          let minutes: number | undefined;
          if (!who.user) {
            const m = /^(.*\S)\s+(\d+)$/.exec(ctx.rest.trim());
            if (m) {
              const again = findUser(m[1]!);
              if (again.user) {
                who = again;
                minutes = Number(m[2]);
              }
            }
          }
          if (!who.user) return ctx.reply(who.problem ?? `Usage: ${p}block <name or #number> [minutes]`);
          const u = who.user;
          if (bot.isAdmin(u.uid)) return ctx.reply('Bot admins cannot be blocked.');
          if (minutes !== undefined && (minutes < 1 || minutes > MAX_BLOCK_MINUTES)) return ctx.reply(`Minutes must be from 1 to ${MAX_BLOCK_MINUTES}, or leave it out to block until you unblock.`);
          const until = minutes ? Date.now() + minutes * 60_000 : undefined;
          bot.state.set('audio.blocked', [...blockList().filter((b) => b.uid !== u.uid), { uid: u.uid, name: u.name, until }]);
          return ctx.reply(`${u.name} is blocked from the music commands ${minutes ? `for ${minutes} minute(s)` : `until you use ${p}unblock`}.`);
        },
      },
      {
        name: 'unblock',
        description: 'Let someone use the music commands again (bot admins only)',
        usage: `${p}unblock <name or number from ${p}blocklist>`,
        perm: 'admin',
        run: async (ctx) => {
          const list = blockList();
          const want = ctx.rest.trim().toLowerCase();
          if (!want) return ctx.reply(`Usage: ${p}unblock <name or number from ${p}blocklist>`);
          const hit = /^\d+$/.test(want) ? list[Number(want) - 1] : (list.find((b) => b.name.toLowerCase() === want) ?? list.find((b) => b.name.toLowerCase().includes(want)));
          if (!hit) return ctx.reply(`Nobody blocked matches "${ctx.rest.trim()}". ${p}blocklist shows who is blocked.`);
          bot.state.set('audio.blocked', list.filter((b) => b !== hit));
          return ctx.reply(`${hit.name} can use the music commands again.`);
        },
      },
      {
        name: 'blockword',
        description: 'Keep tracks with a word in the title or address out of the queue (bot admins only)',
        usage: `${p}blockword <word>`,
        perm: 'admin',
        run: async (ctx) => {
          const w = ctx.rest.trim().toLowerCase();
          if (!w || w.length > 64) return ctx.reply(`Usage: ${p}blockword <word or short phrase>`);
          const mine = bot.state.get<string[]>('audio.blockedWords', []);
          if (blockedWords().includes(w)) return ctx.reply(`"${w}" is already blocked.`);
          bot.state.set('audio.blockedWords', [...mine, w]);
          return ctx.reply(`Tracks with "${w}" in the title or address are now kept out of the queue (bot admins can still add them).`);
        },
      },
      {
        name: 'unblockword',
        description: 'Allow a blocked word again (bot admins only)',
        usage: `${p}unblockword <word>`,
        perm: 'admin',
        run: async (ctx) => {
          const w = ctx.rest.trim().toLowerCase();
          const mine = bot.state.get<string[]>('audio.blockedWords', []);
          if (mine.includes(w)) {
            bot.state.set('audio.blockedWords', mine.filter((x) => x !== w));
            return ctx.reply(`"${w}" is allowed again.`);
          }
          return ctx.reply(cfg.blockedWords.map((x) => x.toLowerCase()).includes(w) ? `"${w}" comes from config.json (audio.blockedWords); take it out there.` : `"${w}" is not on the list.`);
        },
      },
      {
        name: 'blocklist',
        description: 'Show who is blocked and which words are blocked (bot admins only)',
        perm: 'admin',
        run: (ctx) => {
          const users = blockList();
          const words = blockedWords();
          const lines = [
            users.length ? `Blocked people:\n${users.map((b, i) => `${i + 1}. ${b.name}${b.until ? ` (${Math.max(1, Math.ceil((b.until - Date.now()) / 60_000))} min left)` : ''}`).join('\n')}` : 'Nobody is blocked.',
            words.length ? `Blocked words: ${words.join(', ')}` : 'No words are blocked.',
            cfg.maxQueuePerUser ? `Each person may have ${cfg.maxQueuePerUser} tracks queued.` : 'There is no per-person queue limit.',
          ];
          return ctx.reply(lines.join('\n'));
        },
      },
      {
        name: 'summon',
        aliases: ['join'],
        description: 'Bring me to your channel',
        run: async (ctx) => {
          if (!ctx.isAdmin && isBlocked(ctx.msg.senderUid)) return ctx.reply(blockedNotice(ctx.msg.senderUid));
          const user = await ctx.user();
          if (!user || user.channelId === 0n) return ctx.reply("I can't tell which channel you're in.");
          const here = adapter.selfChannelId();
          if (user.channelId === here) return ctx.reply("I'm already here.");
          if (busy() && !ctx.isAdmin && !(autoOnly() && listeners() === 0)) return ctx.reply(`I'm playing in "${channelName(here)}" right now. Join me there, or wait until I'm done.`);
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
        name: 'goto',
        description: 'Send me to a channel, by name or as #id (bot admins only)',
        usage: `${p}goto <channel name>`,
        perm: 'admin',
        run: async (ctx) => {
          const want = ctx.rest.trim();
          if (!want) return ctx.reply(`Usage: ${p}goto <channel name>`);
          const byId = /^#(\d{1,18})$/.exec(want);
          const target = byId ? adapter.channels().find((c) => c.id === BigInt(byId[1]!)) : adapter.findChannel(want);
          if (!target) return ctx.reply(`I can't find a channel called "${want}".`);
          if (target.id === adapter.selfChannelId()) return ctx.reply("I'm already there.");
          const home = adapter.findChannel(bot.config.server.homeChannel);
          try {
            await adapter.moveSelf(target.id, home && home.id === target.id ? bot.config.server.homeChannelPassword : undefined);
            cancelIdle();
            scheduleIdle();
            return ctx.reply(`Moved to "${target.name}".`);
          } catch (e) {
            return ctx.reply(`I couldn't move there (${errMessage(e)}).`);
          }
        },
      },
      {
        name: 'leave',
        aliases: ['home'],
        description: 'Stop playing and go back to the home channel',
        run: async (ctx) => {
          if (!(await requireControl(ctx))) return;
          stopEverything(true);
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
      watchTimer = setInterval(() => {
        watchChannel();
        void autoDjTick();
      }, 5_000);
      void refreshTools().catch(() => {});
      if (cfg.healthCheckHours > 0) {
        const every = cfg.healthCheckHours * 3_600_000;
        healthTimer = setInterval(() => void runHealthCheck(), every);
        healthFirstTimer = setTimeout(() => void runHealthCheck(), Math.min(60_000, every / 2)); // a minute after start (sooner if the interval is short)
        healthTimer.unref?.();
        healthFirstTimer.unref?.();
      }
      watchTimer.unref?.();
      unprovide = bot.services.provide<AudioService>(AUDIO_SERVICE, {
        snapshot() {
          const item = (t: Track): QueueItem => ({ kind: t.kind, title: t.title, url: t.url, durationSec: t.durationSec, auto: t.auto });
          return {
            current: queue.current && player?.playing ? { ...item(queue.current), id: queue.current.id, liveTitle } : undefined,
            upcoming: queue.upcoming.map(item),
          };
        },
        queue: (ctx, items, opts) => queueRequest(ctx, 'media', async () => items, opts?.label),
        state() {
          const item = (t: Track): QueueItem => ({ kind: t.kind, title: t.title, url: t.url, durationSec: t.durationSec, auto: t.auto });
          const playing = !!player?.playing;
          return {
            playing,
            paused: !!player?.paused,
            volume: Math.round((player?.volume ?? 0) * 100),
            positionSec: player?.positionSec ?? 0,
            current: queue.current && playing ? { ...item(queue.current), id: queue.current.id, liveTitle } : undefined,
            upcoming: queue.upcoming.map(item),
            repeat,
            autoDj: { enabled: autoDj.enabled, source: autoDj.source, sourceName: sourceName(autoDj.source) },
            stay,
          } satisfies AudioState;
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
        search: async (query): Promise<SearchResult[]> =>
          (await deps.searchMedia(query, cfg, 5)).map((it) => ({ title: it.title, url: it.url, durationSec: it.durationSec, ...(it.by ? { by: it.by } : {}) })),
        history: (count = 20) => history.recent(Math.min(50, Math.max(1, Math.floor(count)))),
        tools: (): ToolsInfo => ({ ytdlp: toolInfo?.ytdlp ?? '...', ffmpeg: toolInfo?.ffmpeg ?? '...', youtube: lastHealth, updating: updatingYtdlp }),
        blocked: (uid) => isBlocked(uid),
        troll: (): TrollSettings => ({
          users: blockList().map((b) => ({ name: b.name, until: b.until })),
          words: blockedWords(),
          maxQueuePerUser: cfg.maxQueuePerUser,
        }),
      });
    },

    onUnload() {
      offLost?.();
      unprovide?.();
      if (watchTimer) clearInterval(watchTimer);
      if (healthTimer) clearInterval(healthTimer);
      if (healthFirstTimer) clearTimeout(healthFirstTimer);
      if (healthRetryTimer) clearTimeout(healthRetryTimer);
      cancelIdle();
      queue.clear();
      player?.dispose();
      player = undefined;
    },

    async status() {
      const cur = queue.current;
      const t = await refreshTools();
      const state = cur && player?.playing ? `playing "${cur.title}"` : 'idle';
      return `${state} | queue ${queue.size} | repeat ${repeat} | auto-DJ ${autoDj.enabled ? 'on' : 'off'} | 24/7 ${stay ? 'on' : 'off'} | volume ${Math.round((player?.volume ?? 0) * 100)} | yt-dlp ${t.ytdlp} | ffmpeg ${t.ffmpeg}`;
    },
  };

  return cog;
}

const factory: CogFactory = (bot) => createAudioCog(bot);
export default factory;
