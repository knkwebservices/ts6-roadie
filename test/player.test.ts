import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import OpusScript from 'opusscript';
import { silentLog } from '../src/logger.js';
import { FRAME_MS, Player } from '../src/cogs/audio/player.js';

let dir: string;
let wav1s: string;
let wav10s: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'tsbot-audio-'));
  wav1s = join(dir, 'tone1.wav');
  wav10s = join(dir, 'tone10.wav');
  for (const [file, secs] of [[wav1s, 1], [wav10s, 10]] as const) {
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${secs}`, '-ar', '48000', '-ac', '2', file]);
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

interface Sent {
  at: number;
  frame: Uint8Array;
  codec: number;
}
function makePlayer(over: Partial<ConstructorParameters<typeof Player>[0]> = {}) {
  const sent: Sent[] = [];
  const player = new Player({
    ffmpegPath: 'ffmpeg',
    ytdlpPath: 'yt-dlp',
    ytdlpExtraArgs: [],
    bitrate: 64_000,
    codec: 5,
    send: (frame, codec) => sent.push({ at: performance.now(), frame, codec }),
    log: silentLog,
    ...over,
  });
  return { player, sent };
}
const audioFrames = (s: Sent[]) => s.filter((x) => x.frame.length > 0);
const rms = (pcm: Buffer) => {
  let sum = 0;
  for (let i = 0; i < pcm.length; i += 2) sum += pcm.readInt16LE(i) ** 2;
  return Math.sqrt(sum / (pcm.length / 2));
};

test('plays a file: right frame count, real-time pacing, codec, and an end-of-transmission packet', async () => {
  const { player, sent } = makePlayer();
  player.volume = 1;
  const t0 = performance.now();
  const r = await player.play({ kind: 'radio', url: wav1s });
  const elapsed = performance.now() - t0;
  player.dispose();

  assert.equal(r.reason, 'ended', r.error);
  const frames = audioFrames(sent);
  assert.ok(frames.length >= 49 && frames.length <= 52, `expected ~50 frames for 1s, got ${frames.length}`);
  assert.ok(sent.every((s) => s.codec === 5));
  assert.equal(sent.at(-1)!.frame.length, 0, 'last packet must be empty (end of transmission)');
  // It must take about one second of wall time: real-time pacing, not a burst.
  assert.ok(elapsed > 900 && elapsed < 1600, `playback took ${Math.round(elapsed)}ms`);
  // Average spacing between packets should be ~20ms.
  const span = frames.at(-1)!.at - frames[0]!.at;
  const avg = span / (frames.length - 1);
  assert.ok(avg > FRAME_MS - 3 && avg < FRAME_MS + 3, `average packet spacing ${avg.toFixed(1)}ms`);
});

test('the Opus packets decode back to the source level, and volume scales it', async () => {
  // Level of the source, measured independently of the player.
  const src = execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', wav1s, '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], { maxBuffer: 1 << 26 });
  const srcRms = rms(src);
  assert.ok(srcRms > 1000, `test tone should not be silent (${srcRms.toFixed(0)})`);

  // Decode sequentially from the first packet (a decoder started mid-stream reads low), then
  // measure the steady state after the decoder has warmed up.
  const decodedRms = (sent: Sent[]) => {
    const dec = new OpusScript(48000, 2, OpusScript.Application.AUDIO);
    const pcm = Buffer.concat(audioFrames(sent).map((s) => dec.decode(Buffer.from(s.frame))));
    dec.delete();
    return rms(pcm.subarray(10 * 3840));
  };

  const full = makePlayer();
  full.player.volume = 1;
  await full.player.play({ kind: 'radio', url: wav1s });
  full.player.dispose();

  const quarter = makePlayer();
  quarter.player.volume = 0.25;
  await quarter.player.play({ kind: 'radio', url: wav1s });
  quarter.player.dispose();

  const f = decodedRms(full.sent);
  const q = decodedRms(quarter.sent);
  assert.ok(f / srcRms > 0.9 && f / srcRms < 1.1, `full volume should match the source, got ${(f / srcRms).toFixed(2)}x`);
  assert.ok(q / srcRms > 0.22 && q / srcRms < 0.28, `quarter volume should be ~0.25x the source, got ${(q / srcRms).toFixed(2)}x`);
});

test('stop() ends playback promptly and sends the end-of-transmission packet', async () => {
  const { player, sent } = makePlayer();
  const p = player.play({ kind: 'radio', url: wav10s });
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(player.playing, true);
  const t0 = performance.now();
  player.stop();
  const r = await p;
  assert.equal(r.reason, 'stopped');
  assert.ok(performance.now() - t0 < 200);
  assert.equal(player.playing, false);
  assert.equal(sent.at(-1)!.frame.length, 0);
  const n = sent.length;
  await new Promise((res) => setTimeout(res, 150));
  assert.equal(sent.length, n, 'nothing may be sent after stop');
  player.dispose();
});

test('pause stops the packets, resume continues without a burst', async () => {
  const { player, sent } = makePlayer();
  const p = player.play({ kind: 'radio', url: wav10s });
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(player.pause(), true);
  await new Promise((r) => setTimeout(r, 100));
  const atPause = audioFrames(sent).length;
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(audioFrames(sent).length, atPause, 'no audio while paused');
  assert.equal(player.paused, true);

  const resumedAt = performance.now();
  player.resume();
  await new Promise((r) => setTimeout(r, 500));
  const after = audioFrames(sent).filter((s) => s.at >= resumedAt);
  // ~500ms of audio at 20ms/frame is ~25 frames; a burst would be far more.
  assert.ok(after.length > 15 && after.length < 32, `after resume: ${after.length} frames in 500ms`);
  player.stop();
  await p;
  player.dispose();
});

test('a missing input file is reported as an error, not a hang', async () => {
  const { player } = makePlayer();
  const r = await player.play({ kind: 'radio', url: join(dir, 'does-not-exist.wav') });
  assert.equal(r.reason, 'error');
  assert.ok(r.error && r.error.length > 0);
  player.dispose();
});

test('a missing ffmpeg / yt-dlp binary gives a clear message', async () => {
  const a = makePlayer({ ffmpegPath: 'definitely-not-ffmpeg' });
  const ra = await a.player.play({ kind: 'radio', url: wav1s });
  assert.equal(ra.reason, 'error');
  assert.match(ra.error!, /ffmpeg was not found/);
  a.player.dispose();

  const b = makePlayer({ ytdlpPath: 'definitely-not-yt-dlp' });
  const rb = await b.player.play({ kind: 'media', url: 'https://www.youtube.com/watch?v=x' });
  assert.equal(rb.reason, 'error');
  assert.match(rb.error!, /yt-dlp was not found/);
  b.player.dispose();
});

test('the player is reusable for back-to-back tracks', async () => {
  const { player, sent } = makePlayer();
  const a = await player.play({ kind: 'radio', url: wav1s });
  const b = await player.play({ kind: 'radio', url: wav1s });
  assert.equal(a.reason, 'ended');
  assert.equal(b.reason, 'ended');
  assert.ok(audioFrames(sent).length >= 98);
  player.dispose();
});

test('no ffmpeg processes are left behind after stop', async () => {
  const { player } = makePlayer();
  const p = player.play({ kind: 'radio', url: wav10s });
  await new Promise((r) => setTimeout(r, 300));
  player.stop();
  await p;
  await new Promise((r) => setTimeout(r, 300));
  let leftover = '';
  try {
    leftover = execFileSync('pgrep', ['-af', `ffmpeg.*${wav10s}`]).toString();
  } catch {
    /* pgrep exits 1 when nothing matches - that's what we want */
  }
  assert.equal(leftover.trim(), '', `leftover ffmpeg: ${leftover}`);
  player.dispose();
});

test('startSec begins part-way into a file, and the position counts from the track\'s start', async () => {
  const { player, sent } = makePlayer();
  const run = player.play({ kind: 'radio', url: wav10s, startSec: 6 });
  await new Promise((r) => setTimeout(r, 400));
  assert.ok(player.positionSec >= 6 && player.positionSec < 7, `position ${player.positionSec}`);
  const res = await run;
  assert.equal(res.reason, 'ended');
  const frames = audioFrames(sent).length;
  // 10 s file, starting at 6 s: about 4 s = 200 frames (not the full 500)
  assert.ok(frames >= 190 && frames <= 215, `${frames} frames`);
  assert.equal(player.positionSec, 0, 'nothing playing: no position');
});

test('a startSec of zero plays the whole file', async () => {
  const a = makePlayer();
  const run = a.player.play({ kind: 'radio', url: wav1s, startSec: 0 });
  assert.equal((await run).reason, 'ended');
  assert.ok(audioFrames(a.sent).length >= 45, 'the whole 1 s file');
});

test('startSec also works for a stream piped in from yt-dlp (which cannot be seeked)', { skip: process.platform === 'win32' }, async () => {
  // A stand-in for yt-dlp that just writes a 10 s file to its output, like a download would.
  const fake = join(dir, 'fake-ytdlp.sh');
  writeFileSync(fake, `#!/bin/sh\ncat "${wav10s}"\n`);
  chmodSync(fake, 0o755);
  const { player, sent } = makePlayer({ ytdlpPath: fake });
  const res = await player.play({ kind: 'media', url: 'https://example.com/video', startSec: 6 });
  assert.equal(res.reason, 'ended');
  const frames = audioFrames(sent).length;
  assert.ok(frames >= 190 && frames <= 215, `${frames} frames (about 4 s were expected)`);
});
