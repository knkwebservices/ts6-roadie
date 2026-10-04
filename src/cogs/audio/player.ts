import { spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { PassThrough } from 'node:stream';
import type { Log } from '../../logger.js';
import { createOpusEncoder, SAMPLES_PER_FRAME, type FrameEncoder } from './opus.js';
import { killTree } from './proc.js';
import type { TrackKind } from './queue.js';

export const FRAME_MS = 20;
/** 20 ms of 48 kHz, 16-bit, stereo. */
export const FRAME_BYTES = SAMPLES_PER_FRAME * 2 * 2;

const PREBUFFER_FRAMES = 10; // 200 ms of audio before the first packet goes out
const LEAD_MS = 40; // how far ahead of the clock we may send (absorbs timer jitter)
const MAX_BURST = 4;
const START_TIMEOUT_MS = 30_000;
const STALL_TIMEOUT_MS = 20_000;
/** While someone is being read out (text to speech), the music plays at this fraction of its volume. */
export const SPEECH_DUCK = 0.15;

export interface PlayInput {
  kind: TrackKind;
  url: string;
  /** Start this many seconds in (ignored for live radio). */
  startSec?: number;
}

export interface PlayResult {
  reason: 'ended' | 'stopped' | 'error';
  error?: string;
  seconds: number;
}

export interface PlayerOptions {
  ffmpegPath: string;
  ytdlpPath: string;
  ytdlpExtraArgs: string[];
  bitrate: number;
  codec: number;
  send: (frame: Uint8Array, codec: number) => void;
  log: Log;
  /** Test seam. */
  createEncoder?: (bitrate: number) => FrameEncoder;
}

export interface PlayerLike {
  /** 0..1 linear gain. */
  volume: number;
  readonly playing: boolean;
  readonly paused: boolean;
  readonly positionSec: number;
  play(input: PlayInput): Promise<PlayResult>;
  stop(): void;
  pause(): boolean;
  resume(): boolean;
  /**
   * Say something over whatever is playing (the music is turned down meanwhile), or on its own if nothing
   * is. `pcm` is 48 kHz 16-bit stereo, already at the volume it should be heard. Resolves once it has all
   * been sent (or the player was disposed).
   */
  speak(pcm: Buffer): Promise<void>;
  dispose(): void;
}

function tail(s: string, n = 400): string {
  return s.length > n ? s.slice(-n) : s;
}

/** Pull a readable one-liner out of a tool's stderr. */
function summarizeStderr(s: string): string {
  const lines = s
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => /error/i.test(l)) ?? lines[lines.length - 1] ?? '';
  return err.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, '').slice(0, 200);
}

/** music * duck + speech, in place in `music`. */
export function mixSpeech(music: Buffer, speech: Buffer, duck = SPEECH_DUCK): void {
  for (let i = 0; i + 1 < music.length && i + 1 < speech.length; i += 2) {
    const v = Math.round(music.readInt16LE(i) * duck) + speech.readInt16LE(i);
    music.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i);
  }
}

function applyGain(pcm: Buffer, gain: number): void {
  if (gain === 1) return;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const v = Math.round(pcm.readInt16LE(i) * gain);
    pcm.writeInt16LE(v > 32767 ? 32767 : v < -32768 ? -32768 : v, i);
  }
}

/**
 * Plays one track at a time: [yt-dlp] -> ffmpeg (48 kHz stereo PCM) -> Opus -> paced
 * 20 ms packets. TeamSpeak has no server-side audio relay like Lavalink, so the bot
 * itself has to hand the server audio in real time.
 */
export class Player implements PlayerLike {
  volume = 0.5;
  readonly #o: PlayerOptions;
  #encoder?: FrameEncoder;
  #run?: Run;
  /** Speech still to be sent, and who is waiting for it to finish. */
  #speech: Buffer = Buffer.alloc(0);
  #speechWaiters: (() => void)[] = [];
  #soloTimer?: NodeJS.Timeout;

  constructor(options: PlayerOptions) {
    this.#o = options;
  }

  get hasSpeech(): boolean {
    return this.#speech.length > 0;
  }

  /** The next 20 ms of speech (padded with silence at the end), or undefined if there is none. */
  takeSpeechFrame(): Buffer | undefined {
    if (!this.#speech.length) return undefined;
    let frame: Buffer;
    if (this.#speech.length >= FRAME_BYTES) {
      frame = Buffer.from(this.#speech.subarray(0, FRAME_BYTES));
      this.#speech = this.#speech.subarray(FRAME_BYTES);
    } else {
      frame = Buffer.alloc(FRAME_BYTES);
      this.#speech.copy(frame);
      this.#speech = Buffer.alloc(0);
    }
    if (!this.#speech.length) this.#speechDone();
    return frame;
  }

  #speechDone(): void {
    const waiters = this.#speechWaiters;
    this.#speechWaiters = [];
    for (const w of waiters) w();
  }

  speak(pcm: Buffer): Promise<void> {
    if (!pcm.length) return Promise.resolve();
    this.#speech = this.#speech.length ? Buffer.concat([this.#speech, pcm]) : Buffer.from(pcm);
    const done = new Promise<void>((res) => this.#speechWaiters.push(res));
    this.kickSpeech();
    return done;
  }

  /**
   * Send speech on its own while no music is going out (nothing playing, or paused). While music plays,
   * the track's own pump mixes the speech in instead.
   */
  kickSpeech(): void {
    if (this.#soloTimer || !this.#speech.length) return;
    if (this.#run && !this.#run.paused) return;
    this.#encoder ??= (this.#o.createEncoder ?? createOpusEncoder)(this.#o.bitrate);
    const enc = this.#encoder;
    let next = performance.now();
    let sentAny = false;
    const tick = (): void => {
      this.#soloTimer = undefined;
      if (this.#run && !this.#run.paused) return; // a track started: its pump takes over the speech
      const now = performance.now();
      let sent = 0;
      while (next <= now + LEAD_MS && sent < MAX_BURST) {
        const frame = this.takeSpeechFrame();
        if (!frame) break;
        try {
          this.#o.send(enc.encode(frame), this.#o.codec);
        } catch (e) {
          this.#o.log.warn(`could not send speech: ${(e as Error).message}`);
          this.#speech = Buffer.alloc(0);
          this.#speechDone();
          return;
        }
        sentAny = true;
        next += FRAME_MS;
        sent++;
      }
      if (!this.#speech.length) {
        if (sentAny) this.#o.send(new Uint8Array(0), this.#o.codec); // end of the transmission
        return;
      }
      if (next < now - 100) next = now;
      this.#soloTimer = setTimeout(tick, Math.max(1, next - LEAD_MS - performance.now()));
    };
    tick();
  }

  get playing(): boolean {
    return !!this.#run;
  }
  get paused(): boolean {
    return !!this.#run?.paused;
  }
  get positionSec(): number {
    return this.#run ? this.#run.startSec + (this.#run.frames * FRAME_MS) / 1000 : 0;
  }

  play(input: PlayInput): Promise<PlayResult> {
    if (this.#run) throw new Error('player is already playing');
    this.#encoder ??= (this.#o.createEncoder ?? createOpusEncoder)(this.#o.bitrate);
    return new Promise((resolve) => {
      this.#run = new Run(this, this.#o, this.#encoder!, input, (r) => {
        this.#run = undefined;
        resolve(r);
        this.kickSpeech(); // anything left to say goes out on its own now
      });
    });
  }

  stop(): void {
    this.#run?.finish('stopped');
  }

  pause(): boolean {
    if (!this.#run) return false;
    this.#run.pause();
    return true;
  }

  resume(): boolean {
    if (!this.#run || !this.#run.paused) return false;
    this.#run.resume();
    return true;
  }

  dispose(): void {
    if (this.#soloTimer) clearTimeout(this.#soloTimer);
    this.#soloTimer = undefined;
    this.#speech = Buffer.alloc(0);
    this.#speechDone();
    this.stop();
    this.#encoder?.destroy();
    this.#encoder = undefined;
  }
}

class Run {
  frames = 0;
  paused = false;
  /** Where in the track this run began, so the position shown counts from the track's start. */
  readonly startSec: number;

  #ff?: ChildProcess;
  #yt?: ChildProcess;
  readonly #pcm = new PassThrough({ highWaterMark: 512 * 1024 });
  #ffErr = '';
  #ytErr = '';
  #finished = false;
  #timer?: NodeJS.Timeout;
  #nextDue = 0;
  #startedAt = performance.now();
  #lastFrameAt = performance.now();
  #pauseSignalled = false;

  constructor(
    private readonly player: Player,
    private readonly o: PlayerOptions,
    private readonly enc: FrameEncoder,
    input: PlayInput,
    private readonly done: (r: PlayResult) => void,
  ) {
    const viaYtdlp = input.kind === 'media';
    const isNet = /^https?:\/\//i.test(input.url);
    // Live radio has no position to jump to; everything else can start part-way in.
    const start = input.kind === 'radio' && isNet ? 0 : Math.max(0, Math.floor(input.startSec ?? 0));
    this.startSec = start;

    const ffArgs = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
    if (!viaYtdlp && isNet) {
      // Keep radio alive across network blips, and never let a stream playlist reach local files.
      ffArgs.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5', '-protocol_whitelist', 'http,https,tcp,tls,crypto');
    }
    // A file can be jumped into directly. A stream from yt-dlp cannot be seeked, so ffmpeg reads and drops the first part instead.
    if (start > 0 && !viaYtdlp) ffArgs.push('-ss', String(start));
    ffArgs.push('-i', viaYtdlp ? 'pipe:0' : input.url);
    if (start > 0 && viaYtdlp) ffArgs.push('-ss', String(start));
    ffArgs.push('-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1');

    try {
      const ff = spawn(o.ffmpegPath, ffArgs, { stdio: [viaYtdlp ? 'pipe' : 'ignore', 'pipe', 'pipe'], windowsHide: true });
      this.#ff = ff;
      ff.on('error', (e) => this.finish('error', (e as NodeJS.ErrnoException).code === 'ENOENT' ? `ffmpeg was not found (looked for "${o.ffmpegPath}")` : e.message));
      ff.stderr!.setEncoding('utf8').on('data', (d: string) => (this.#ffErr = tail(this.#ffErr + d)));
      ff.stdout!.pipe(this.#pcm);
      ff.stdout!.on('error', () => {});

      if (viaYtdlp) {
        ff.stdin!.on('error', () => {}); // EPIPE when we stop early is expected
        const yt = spawn(
          o.ytdlpPath,
          ['--no-playlist', '--no-warnings', '-q', '-f', 'bestaudio[ext=webm]/bestaudio/best', '--socket-timeout', '15', '-o', '-', ...o.ytdlpExtraArgs, '--', input.url],
          { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
        );
        this.#yt = yt;
        yt.on('error', (e) => this.finish('error', (e as NodeJS.ErrnoException).code === 'ENOENT' ? `yt-dlp was not found (looked for "${o.ytdlpPath}")` : e.message));
        yt.stderr!.setEncoding('utf8').on('data', (d: string) => (this.#ytErr = tail(this.#ytErr + d)));
        yt.stdout!.pipe(ff.stdin!);
        yt.stdout!.on('error', () => {});
      }
    } catch (e) {
      // spawn() can throw synchronously (bad path characters etc.)
      queueMicrotask(() => this.finish('error', (e as Error).message));
      return;
    }

    this.#pcm.on('error', () => {});
    this.#timer = setTimeout(() => this.#tick(), FRAME_MS);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    this.#pauseSignalled = false;
    this.#nextDue = performance.now();
  }

  #schedule(ms: number): void {
    if (!this.#finished) this.#timer = setTimeout(() => this.#tick(), Math.max(1, ms));
  }

  #tick(): void {
    if (this.#finished) return;
    const now = performance.now();

    if (this.paused) {
      if (!this.#pauseSignalled) {
        this.#pauseSignalled = true;
        this.o.send(new Uint8Array(0), this.o.codec); // stop the "talking" indicator
      }
      this.#nextDue = now;
      this.player.kickSpeech(); // speech still goes out while the music is paused
      return this.#schedule(50);
    }

    const pcm = this.#pcm;

    // Before the first frame, wait for a little audio to build up (or for the source to end).
    if (this.frames === 0) {
      if (now - this.#startedAt > START_TIMEOUT_MS) {
        return this.finish('error', summarizeStderr(this.#ytErr) || summarizeStderr(this.#ffErr) || 'timed out waiting for audio');
      }
      if (pcm.readableLength < PREBUFFER_FRAMES * FRAME_BYTES && !pcm.writableFinished) return this.#schedule(FRAME_MS);
      if (this.#nextDue === 0) this.#nextDue = now;
    }

    let sent = 0;
    while (this.#nextDue <= now + LEAD_MS && sent < MAX_BURST) {
      let frame: Buffer | null = null;
      const avail = pcm.readableLength;
      if (avail >= FRAME_BYTES) {
        frame = pcm.read(FRAME_BYTES) as Buffer | null;
      } else if (pcm.writableFinished) {
        if (avail > 0) {
          const rest = pcm.read(avail) as Buffer | null;
          if (rest) {
            frame = Buffer.alloc(FRAME_BYTES);
            rest.copy(frame);
          }
        } else {
          return this.#endOfSource();
        }
      }

      if (!frame) {
        // Underrun: hold the clock, don't burst to catch up afterwards.
        if (performance.now() - this.#lastFrameAt > STALL_TIMEOUT_MS) {
          return this.finish('error', this.frames === 0 ? 'no audio received' : 'the stream stalled');
        }
        break;
      }

      applyGain(frame, this.player.volume);
      const speech = this.player.takeSpeechFrame();
      if (speech) mixSpeech(frame, speech);
      try {
        this.o.send(this.enc.encode(frame), this.o.codec);
      } catch (e) {
        return this.finish('error', `encoder failed: ${(e as Error).message}`);
      }
      this.frames++;
      this.#nextDue += FRAME_MS;
      this.#lastFrameAt = performance.now();
      sent++;
    }

    if (this.#nextDue < now - 100) this.#nextDue = now;
    this.#schedule(this.#nextDue - LEAD_MS - performance.now());
  }

  #endOfSource(): void {
    if (this.frames === 0) {
      return this.finish('error', summarizeStderr(this.#ytErr) || summarizeStderr(this.#ffErr) || 'the source produced no audio');
    }
    this.finish('ended');
  }

  finish(reason: PlayResult['reason'], error?: string): void {
    if (this.#finished) return;
    this.#finished = true;
    if (this.#timer) clearTimeout(this.#timer);
    killTree(this.#yt);
    killTree(this.#ff);
    this.#pcm.destroy();
    if (this.frames > 0 && !this.#pauseSignalled) this.o.send(new Uint8Array(0), this.o.codec);
    if (reason === 'error') this.o.log.warn(`playback failed: ${error ?? 'unknown'}`);
    this.done({ reason, error, seconds: (this.frames * FRAME_MS) / 1000 });
  }
}
