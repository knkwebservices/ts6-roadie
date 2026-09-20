import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import type { AudioDeps } from '../src/cogs/audio/index.js';
import type { PlayInput, PlayResult, PlayerLike } from '../src/cogs/audio/player.js';
import type { MediaInfo } from '../src/cogs/audio/sources.js';
import { SourceError } from '../src/cogs/audio/sources.js';
import { BOT_VERSION } from '../src/version.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

/** Player whose tracks last until the test says so. */
class FakePlayer implements PlayerLike {
  volume = 0.5;
  playing = false;
  paused = false;
  positionSec = 0;
  played: PlayInput[] = [];
  #finish?: (r: PlayResult) => void;
  play(input: PlayInput) {
    this.playing = true;
    this.played.push(input);
    return new Promise<PlayResult>((res) => {
      this.#finish = (r) => {
        this.playing = false;
        this.paused = false;
        res(r);
      };
    });
  }
  stop() {
    this.#finish?.({ reason: 'stopped', seconds: 0 });
  }
  endTrack() {
    this.#finish?.({ reason: 'ended', seconds: 1 });
  }
  pause() {
    this.paused = true;
    return true;
  }
  resume() {
    const was = this.paused;
    this.paused = false;
    return was;
  }
  dispose() {}
}

interface Rig extends Harness {
  player: FakePlayer;
  resolveCalls: string[];
  setResolver(fn: (q: string) => Promise<MediaInfo[]>): void;
}

const audioEntry = resolve(import.meta.dirname, '../src/cogs/audio/index.ts');

async function makeRig(configOver: Record<string, unknown> = {}): Promise<Rig> {
  const player = new FakePlayer();
  const resolveCalls: string[] = [];
  let resolver: (q: string) => Promise<MediaInfo[]> = async (q) => [{ title: `Song for "${q}"`, url: `https://www.youtube.com/watch?v=${encodeURIComponent(q)}`, durationSec: 200 }];
  const deps: AudioDeps = {
    resolveMedia: async (q) => {
      resolveCalls.push(q);
      return resolver(q);
    },
    createPlayer: () => player,
    toolVersion: async () => 'test',
  };
  (globalThis as Record<string, unknown>).__audioDeps = deps;
  // A drop-in cog that wires the real audio cog to the fake dependencies.
  const h = await makeBot({
    config: makeConfig({ cogs: ['core', 'audiotest'], ...configOver }),
    customCogs: {
      audiotest: `
        import { createAudioCog } from ${JSON.stringify('file://' + audioEntry)};
        export const manifest = { name: 'audiotest', version: '1', description: 'audio with fakes' };
        export default (bot) => createAudioCog(bot, globalThis.__audioDeps);`,
    },
  });
  return { ...h, player, resolveCalls, setResolver: (fn) => (resolver = fn) };
}

const sentTexts = (r: Rig) => r.adapter.sent.map((s) => s.text);

test('idle bot follows the caller into their channel and starts playing', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.a);
    r.adapter.addUser(6, 'Someone', CH.home); // somebody at home; irrelevant
    assert.equal(r.adapter.chan, CH.home);

    r.adapter.say(alice, '!play never gonna give you up');
    await until(() => r.player.played.length === 1, 2000, 'playback to start');

    assert.deepEqual(r.adapter.moves, [CH.a], 'bot moved to Alice\'s channel');
    assert.equal(r.adapter.chan, CH.a);
    assert.match(r.player.played[0]!.url, /youtube\.com/);
    assert.equal(r.player.played[0]!.kind, 'media');
    assert.ok(sentTexts(r).some((t) => /Queued: .*starting now/.test(t)), 'user gets a confirmation');
    assert.ok(r.adapter.sent.some((s) => s.kind === 'channel' && /Now playing/.test(s.text)), 'announced in the channel');
    assert.equal(r.resolveCalls[0], 'never gonna give you up');
  } finally {
    r.cleanup();
  }
});

test('a caller who is already with the bot does not cause a move, and tracks queue up', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    r.adapter.say(alice, '!play one');
    await until(() => r.player.played.length === 1);
    r.adapter.say(alice, '!play two');
    await until(() => sentTexts(r).some((t) => /position 1/.test(t)), 2000, 'second track queued');
    assert.deepEqual(r.adapter.moves, []);
    r.player.endTrack();
    await until(() => r.player.played.length === 2, 2000, 'next track to start');
  } finally {
    r.cleanup();
  }
});

test('a busy bot refuses to be pulled away from people who are listening', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.a);
    const bob = r.adapter.addUser(6, 'Bob', CH.b);
    r.adapter.say(alice, '!play alice song');
    await until(() => r.player.played.length === 1);

    r.adapter.say(bob, '!play bob song');
    await until(() => r.adapter.sent.some((s) => s.kind === 'private' && s.to === 6 && /playing in "Gaming A"/.test(s.text)));
    assert.equal(r.adapter.chan, CH.a, 'still with Alice');
    assert.equal(r.player.played.length, 1);
    assert.equal(r.resolveCalls.length, 1, 'no work wasted resolving Bob\'s request');
  } finally {
    r.cleanup();
  }
});

test('two people calling at the same moment: first claim wins, second is told the bot is taken', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.a);
    const bob = r.adapter.addUser(6, 'Bob', CH.b);
    // Alice's lookup is slow, so at the time Bob asks the queue is still empty.
    let release!: () => void;
    r.setResolver(
      (q) =>
        new Promise((res) => {
          release = () => res([{ title: q, url: 'https://www.youtube.com/watch?v=x', durationSec: 60 }]);
        }),
    );
    r.adapter.say(alice, '!play slow one');
    await until(() => r.resolveCalls.length === 1, 2000, 'Alice lookup to start');
    r.adapter.say(bob, '!play impatient');
    await until(() => r.adapter.sent.some((s) => s.to === 6 && /playing in/.test(s.text)), 2000, 'Bob to be refused');
    assert.deepEqual(r.adapter.moves, [CH.a], 'the bot only ever moved for Alice');
    release();
    await until(() => r.player.played.length === 1);
    assert.equal(r.adapter.chan, CH.a);
  } finally {
    r.cleanup();
  }
});

test('playback controls need you to be in the bot\'s channel (admins excepted)', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.a);
    const troll = r.adapter.addUser(6, 'Troll', CH.b);
    const admin = r.adapter.addUser(7, 'Admin', CH.staff, 'uid-Admin');
    r.adapter.say(alice, '!play song');
    await until(() => r.player.played.length === 1);

    r.adapter.say(troll, '!skip');
    await until(() => r.adapter.sent.some((s) => s.to === 6 && /need to be in my channel/.test(s.text)));
    assert.equal(r.player.playing, true, 'a drive-by user cannot stop the music');

    r.adapter.say(alice, '!volume 20');
    await until(() => sentTexts(r).some((t) => /Volume set to 20/.test(t)));
    assert.equal(r.player.volume, 0.2);

    r.adapter.say(admin, '!skip');
    await until(() => sentTexts(r).some((t) => /Skipped/.test(t)), 2000, 'admin skip');
    assert.equal(r.player.playing, false);
  } finally {
    r.cleanup();
  }
});

test('after the queue empties the bot returns to the home channel', async () => {
  const r = await makeRig({ follow: { idleReturnSeconds: 0.05, aloneLeaveSeconds: 60 } });
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.a);
    r.adapter.say(alice, '!play song');
    await until(() => r.player.played.length === 1);
    assert.equal(r.adapter.chan, CH.a);
    r.player.endTrack();
    await until(() => r.adapter.chan === CH.home, 2000, 'bot to go home');
    assert.deepEqual(r.adapter.moves, [CH.a, CH.home]);
  } finally {
    r.cleanup();
  }
});

test('failures: a channel the bot cannot join, and a lookup that fails, both leave the bot usable', async () => {
  const r = await makeRig();
  try {
    const officer = r.adapter.addUser(5, 'Officer', CH.staff);
    r.adapter.failMove = new Error('insufficient client permissions');
    r.adapter.say(officer, '!play song');
    await until(() => r.adapter.sent.some((s) => /couldn't join your channel/.test(s.text)));
    assert.equal(r.player.played.length, 0);

    r.adapter.failMove = undefined;
    r.setResolver(async () => {
      throw new SourceError('That video is not available.');
    });
    r.adapter.say(officer, '!play broken');
    await until(() => r.adapter.sent.some((s) => /not available/.test(s.text)));
    assert.equal(r.player.played.length, 0);

    // The failed attempts must not have left the bot "busy": a good request still works.
    r.setResolver(async (q) => [{ title: q, url: 'https://www.youtube.com/watch?v=ok' }]);
    r.adapter.say(officer, '!play works');
    await until(() => r.player.played.length === 1, 2000, 'a later request to succeed');
    assert.equal(r.adapter.chan, CH.staff);
  } finally {
    r.cleanup();
  }
});

test('radio: listing, playing by name, queueing as a live track', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    r.adapter.say(alice, '!radio');
    await until(() => r.adapter.sent.length === 1);
    assert.match(r.adapter.lastReply(), /1\. SomaFM Groove Salad \(groovesalad\)/);

    r.adapter.say(alice, '!radio groovesalad');
    await until(() => r.player.played.length === 1);
    assert.equal(r.player.played[0]!.kind, 'radio');
    assert.match(r.player.played[0]!.url, /somafm\.com/);
    assert.equal(r.resolveCalls.length, 0, 'radio never touches yt-dlp');

    r.adapter.say(alice, '!radio nonsense-station');
    await until(() => r.adapter.sent.some((s) => /don't know that station/.test(s.text)));
  } finally {
    r.cleanup();
  }
});

test('queue management: !queue, !remove, !shuffle, !clear, !stop', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    for (const s of ['a', 'b', 'c', 'd']) r.adapter.say(alice, `!play ${s}`);
    await until(() => r.player.played.length === 1 && sentTexts(r).filter((t) => /^Queued/.test(t)).length === 4, 3000, 'four tracks queued');

    r.adapter.say(alice, '!queue');
    await until(() => sentTexts(r).some((t) => /Up next \(3\)/.test(t)));

    r.adapter.say(alice, '!remove 2');
    await until(() => sentTexts(r).some((t) => /^Removed:/.test(t)));
    r.adapter.say(alice, '!remove 99');
    await until(() => sentTexts(r).some((t) => /Give me a position/.test(t)));

    r.adapter.say(alice, '!stop');
    await until(() => sentTexts(r).some((t) => /Stopped and cleared 2 queued tracks/.test(t)));
    await until(() => !r.player.playing, 2000, 'player to stop');
  } finally {
    r.cleanup();
  }
});

test('the queue length limit is enforced', async () => {
  const r = await makeRig({ audio: { maxQueue: 2 } });
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    for (const s of ['a', 'b', 'c', 'd']) {
      r.adapter.say(alice, `!play ${s}`);
      await new Promise((res) => setTimeout(res, 30));
    }
    await until(() => sentTexts(r).some((t) => /queue is full/.test(t)), 2000, 'full-queue message');
  } finally {
    r.cleanup();
  }
});

test('losing the TeamSpeak connection stops playback and clears the queue', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    r.adapter.say(alice, '!play a');
    r.adapter.say(alice, '!play b');
    await until(() => r.player.playing);
    r.adapter.connected = false;
    r.adapter.events.emit('disconnected', 'network');
    await until(() => !r.player.playing, 2000, 'playback to stop');
  } finally {
    r.cleanup();
  }
});

test('volume is remembered across a reload of the cog', async () => {
  const r = await makeRig();
  try {
    const admin = r.adapter.addUser(5, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!volume 33');
    await until(() => sentTexts(r).some((t) => /Volume set to 33/.test(t)));
    r.player.volume = 0.5; // pretend a fresh player
    await r.bot.reloadCog('audiotest');
    assert.equal(r.player.volume, 0.33);
  } finally {
    r.cleanup();
  }
});

test('!status (admin) shows playback and tool versions', async () => {
  const r = await makeRig();
  try {
    const admin = r.adapter.addUser(5, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!status');
    await until(() => r.adapter.sent.length === 1);
    assert.ok(r.adapter.lastReply().includes(`Bot ${BOT_VERSION}`), `status should show the real version ${BOT_VERSION}`);
    assert.match(r.adapter.lastReply(), /audiotest: idle \| queue 0 \| volume 50 \| yt-dlp test \| ffmpeg test/);
  } finally {
    r.cleanup();
  }
});
