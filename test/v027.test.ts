import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import { FRAME_BYTES, mixSpeech, Player } from '../src/cogs/audio/player.js';
import { normalizePcm } from '../src/cogs/tts/engine.js';
import { speakable, type TtsDeps } from '../src/cogs/tts/index.js';
import { silentLog } from '../src/logger.js';
import { makeRig, type Rig } from './audio-helpers.js';
import { CH, until } from './helpers.js';

async function say(h: Rig, user: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  const mine = () => h.adapter.sent.slice(n).find((s) => s.kind === 'private' && s.to === user.id);
  h.adapter.say(user, text);
  await until(() => !!mine(), 10000, `an answer to ${text}`);
  return mine()!.text;
}

const ttsEntry = resolve(import.meta.dirname, '../src/cogs/tts/index.ts');

interface TtsRig extends Rig {
  said: string[];
}

async function ttsRig(tts: Record<string, unknown> = {}): Promise<TtsRig> {
  const said: string[] = [];
  const deps: TtsDeps = {
    synthesize: async (text) => {
      said.push(text);
      return Buffer.alloc(FRAME_BYTES * 3, 1);
    },
    voices: async () => ['Microsoft David Desktop', 'Microsoft Zira Desktop'],
  };
  (globalThis as Record<string, unknown>).__ttsDeps = deps;
  const h = await makeRig(
    { cogs: ['core', 'audiotest', 'ttstest'], tts: { cooldownSeconds: 0, ...tts } },
    {
      ttstest: `
        import { createTtsCog } from ${JSON.stringify('file://' + ttsEntry)};
        export const manifest = { name: 'ttstest', version: '1', description: 'tts with fakes' };
        export default (bot) => createTtsCog(bot, globalThis.__ttsDeps);`,
    },
  );
  return { ...h, said };
}

test('tts settings are checked', () => {
  const c = buildConfig({});
  assert.equal(c.tts.engine, 'windows');
  assert.equal(c.tts.maxChars, 250);
  assert.throws(() => buildConfig({ tts: { engine: 'robot' } }), /tts\.engine/);
  assert.throws(() => buildConfig({ tts: { rate: 11 } }), /tts\.rate/);
});

test('speakable drops BBCode and links, flattens lines and shortens long text', () => {
  assert.equal(speakable('[b]hi[/b] look [URL]https://x.y/z[/URL] ok', 100), 'hi look a link ok');
  assert.equal(speakable('go to https://example.com/page\nnow', 100), 'go to a link now');
  assert.equal(speakable('one two three four five', 12), 'one two...');
  assert.equal(speakable('   ', 100), '');
});

test('mixSpeech turns the music down under the speech', () => {
  const music = Buffer.alloc(4);
  music.writeInt16LE(1000, 0);
  music.writeInt16LE(-1000, 2);
  const speech = Buffer.alloc(4);
  speech.writeInt16LE(100, 0);
  speech.writeInt16LE(32767, 2);
  mixSpeech(music, speech, 0.25);
  assert.equal(music.readInt16LE(0), 350);
  assert.equal(music.readInt16LE(2), 32517);
});

test('the player says speech on its own when nothing is playing, then ends the transmission', async () => {
  const sent: Uint8Array[] = [];
  const player = new Player({
    ffmpegPath: 'ffmpeg',
    ytdlpPath: 'yt-dlp',
    ytdlpExtraArgs: [],
    bitrate: 64000,
    codec: 5,
    send: (frame) => sent.push(frame),
    log: silentLog,
    createEncoder: () => ({ encode: () => new Uint8Array([7]), destroy: () => {} }),
  });
  await player.speak(Buffer.alloc(FRAME_BYTES * 2 + 10, 1));
  await until(() => sent.length === 4, 2000, 'three frames and the end marker');
  assert.deepEqual(sent.map((f) => f.length), [1, 1, 1, 0]);
  assert.equal(player.hasSpeech, false);
  player.dispose();
});

test('!say reads a message aloud in your channel, moving the bot there when it is free', async () => {
  const h = await ttsRig();
  try {
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    h.adapter.say(ann, '!say hello [b]there[/b]');
    await until(() => h.player.spoken.length === 1, 5000, 'speech');
    assert.deepEqual(h.said, ['Ann says: hello there']);
    assert.equal(h.adapter.chan, CH.a, 'the bot came to Ann');
    // the same speaker again soon: no name this time
    h.adapter.say(ann, '!say again');
    await until(() => h.player.spoken.length === 2, 5000, 'second speech');
    assert.equal(h.said[1], 'again');
    assert.match(await say(h, ann, '!say'), /Usage: !say <text>/);
  } finally {
    h.cleanup();
  }
});

test('!tts on reads plain messages (not commands); off stops it', async () => {
  const h = await ttsRig();
  try {
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    assert.match(await say(h, ann, '!tts on'), /Read-out is on/);
    h.adapter.say(ann, 'how is everyone');
    await until(() => h.said.length === 1, 5000, 'read-out');
    assert.equal(h.said[0], 'Ann says: how is everyone');
    await say(h, ann, '!tts');
    assert.equal(h.said.length, 1, 'commands are not read out');
    assert.match(await say(h, ann, '!tts off'), /off/);
    h.adapter.say(ann, 'not read');
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.said.length, 1);
  } finally {
    h.cleanup();
  }
});

test('the bot will not leave music elsewhere to speak; groups and admin voice settings', async () => {
  const h = await ttsRig({ allowedGroups: [9] });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.a, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.b, 'uid-Ann', [9]);
    const bob = h.adapter.addUser(11, 'Bob', CH.b);
    assert.match(await say(h, bob, '!say hi'), /isn't switched on for your server group/);
    h.player.playing = true; // music in the home channel
    h.adapter.addUser(12, 'Listener', CH.home);
    assert.match(await say(h, ann, '!say hi'), /I'm busy in "Lobby"/);
    h.player.playing = false;
    assert.match(await say(h, ann, '!tts voices'), /Only bot admins/);
    assert.match(await say(h, admin, '!tts voices'), /Microsoft David Desktop, Microsoft Zira Desktop/);
    assert.match(await say(h, admin, '!tts voice zira'), /The voice is now Microsoft Zira Desktop/);
    assert.match(await say(h, admin, '!tts speed 11'), /from -10/);
    assert.match(await say(h, admin, '!tts'), /Windows voices \(Microsoft Zira Desktop, speed 0\)/);
  } finally {
    h.cleanup();
  }
});

test('normalizePcm brings quiet speech up, but not by more than six times', () => {
  const quiet = Buffer.alloc(4);
  quiet.writeInt16LE(10000, 0);
  quiet.writeInt16LE(-5000, 2);
  normalizePcm(quiet);
  assert.equal(quiet.readInt16LE(0), 29500);
  assert.equal(quiet.readInt16LE(2), -14750);
  const whisper = Buffer.alloc(2);
  whisper.writeInt16LE(100, 0);
  assert.equal(normalizePcm(whisper).readInt16LE(0), 600);
});

test('music in the same channel pauses while the bot speaks (or is turned down with !tts music duck)', async () => {
  const h = await ttsRig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    h.player.playing = true;
    let pauses = 0;
    let pausedWhileSpeaking: boolean | undefined;
    const realPause = h.player.pause.bind(h.player);
    h.player.pause = () => {
      pauses++;
      return realPause();
    };
    const realSpeak = h.player.speak.bind(h.player);
    h.player.speak = (pcm: Buffer) => {
      pausedWhileSpeaking = h.player.paused;
      return realSpeak(pcm);
    };
    h.adapter.say(admin, '!say first');
    await until(() => h.player.spoken.length === 1, 5000, 'speech');
    await until(() => !h.player.paused, 2000, 'music back on');
    assert.equal(pauses, 1);
    assert.equal(pausedWhileSpeaking, true);
    assert.match(await say(h, admin, '!tts music duck'), /turned right down/);
    h.adapter.say(admin, '!say second');
    await until(() => h.player.spoken.length === 2, 5000, 'second speech');
    assert.equal(pauses, 1, 'duck mode does not pause');
    assert.equal(pausedWhileSpeaking, false);
  } finally {
    h.cleanup();
  }
});
