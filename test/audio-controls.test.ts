import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TrackQueue, type Track } from '../src/cogs/audio/queue.js';
import { parseSeek } from '../src/cogs/audio/seek.js';
import type { TsUser } from '../src/adapter/types.js';
import type { PlaylistsService } from '../src/core/services.js';
import { makeRig, sentTexts, type Rig } from './audio-helpers.js';
import { CH, until } from './helpers.js';

/** Send a command and wait for the bot's (first) answer to it. */
async function say(r: Rig, user: TsUser, text: string): Promise<string> {
  const n = r.adapter.sent.length;
  r.adapter.say(user, text);
  await until(() => r.adapter.sent.length > n, 2000, `an answer to ${text}`);
  return r.adapter.sent[n]!.text;
}
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));
const track = (n: number): Track => ({ id: n, kind: 'media', title: `T${n}`, url: `https://x.test/${n}`, requesterUid: 'u', requesterName: 'U' });

// ---- pure pieces ----------------------------------------------------------------------

test('the queue can move a track to another place', () => {
  const q = new TrackQueue();
  q.add(track(1), track(2), track(3), track(4));
  const order = () => q.upcoming.map((t) => t.id).join('');
  assert.equal(q.move(1, 3)?.id, 1);
  assert.equal(order(), '2314');
  q.move(4, 1);
  assert.equal(order(), '4231');
  q.move(2, 2);
  assert.equal(order(), '4231', 'moving to the same place changes nothing');
  for (const bad of [[0, 1], [1, 5], [5, 1], [1.5, 2], [Number.NaN, 2]] as const) {
    assert.equal(q.move(bad[0], bad[1]), undefined, String(bad));
    assert.equal(order(), '4231');
  }
});

test('seek times: 90, 1:30, 1:02:03, +30, -30, and nonsense', () => {
  assert.equal(parseSeek('90', 5), 90);
  assert.equal(parseSeek('1:30', 5), 90);
  assert.equal(parseSeek('1:02:03', 5), 3723);
  assert.equal(parseSeek('+30', 45.9), 75);
  assert.equal(parseSeek('-30', 45), 15);
  assert.equal(parseSeek('-30', 10), 0, 'never before the start');
  assert.equal(parseSeek('0', 99), 0);
  for (const bad of [undefined, '', 'abc', '1:75', '1:2:3:4', '1.5', '--5', '+', '99999:00', '1e3', '90s']) assert.equal(parseSeek(bad, 0), undefined, String(bad));
});

// ---- move, repeat, seek ---------------------------------------------------------------

test('!move puts a queued track somewhere else, and says what is wrong when it cannot', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    for (const q of ['one', 'two', 'three', 'four']) r.adapter.say(alice, `!play ${q}`);
    await until(() => r.player.played.length === 1 && sentTexts(r).filter((t) => /Queued/.test(t)).length === 4, 3000, 'four tracks');
    assert.match(await say(r, alice, '!move 3 1'), /Moved .*four.* to position 1/);
    assert.match(await say(r, alice, '!queue'), /1\. Song for "four".*\n2\. Song for "two"/s);
    assert.match(await say(r, alice, '!move 9 1'), /Usage/);
    assert.match(await say(r, alice, '!move'), /Usage/);
  } finally {
    r.cleanup();
  }
});

test('repeat track: it plays again when it ends, but a skip moves on', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    r.adapter.say(alice, '!play one');
    await until(() => r.player.played.length === 1);
    r.adapter.say(alice, '!play two');
    await until(() => sentTexts(r).some((t) => /position 1/.test(t)));

    assert.match(await say(r, alice, '!repeat'), /Repeat is off/);
    assert.match(await say(r, alice, '!repeat track'), /Repeating the current track/);
    const before = sentTexts(r).filter((t) => /Now playing/.test(t)).length;
    r.player.endTrack();
    await until(() => r.player.played.length === 2, 2000, 'the same track again');
    assert.equal(r.player.played[1]!.url, r.player.played[0]!.url);
    assert.equal(sentTexts(r).filter((t) => /Now playing/.test(t)).length, before, 'a repeat is not announced again');

    await say(r, alice, '!skip');
    await until(() => r.player.played.length === 3, 2000, 'the next track');
    assert.match(r.player.played[2]!.url, /two/);

    assert.match(await say(r, alice, '!repeat off'), /off/);
    r.player.endTrack();
    await until(() => !r.player.playing, 2000, 'the end');
    assert.equal(r.player.played.length, 3, 'nothing repeats once it is off');
    assert.match(await say(r, alice, '!repeat sideways'), /Usage/);
  } finally {
    r.cleanup();
  }
});

test('repeat queue: every track goes to the back after it plays, skipped ones too, and stop ends it', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    r.adapter.say(alice, '!play one');
    await until(() => r.player.played.length === 1);
    r.adapter.say(alice, '!play two');
    await until(() => sentTexts(r).some((t) => /position 1/.test(t)));
    await say(r, alice, '!repeat queue');
    const urls = () => r.player.played.map((p) => p.url.replace(/.*=/, ''));

    r.player.endTrack();
    await until(() => r.player.played.length === 2);
    r.player.endTrack();
    await until(() => r.player.played.length === 3);
    await say(r, alice, '!skip');
    await until(() => r.player.played.length === 4);
    assert.deepEqual(urls(), ['one', 'two', 'one', 'two'], 'the two tracks go round and round');
    assert.match(await say(r, alice, '!queue'), /Repeat: queue/);

    await say(r, alice, '!stop');
    await until(() => !r.player.playing, 2000, 'the stop');
    await pause(100);
    assert.equal(r.player.played.length, 4, 'stop does not start the queue again');
    assert.match(await say(r, alice, '!queue'), /Nothing is playing/);
  } finally {
    r.cleanup();
  }
});

test('live radio and failed tracks are never repeated', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    await say(r, alice, '!repeat track');
    r.adapter.say(alice, '!radio 1');
    await until(() => r.player.played.length === 1);
    r.player.endTrack();
    await until(() => !r.player.playing);
    await pause(60);
    assert.equal(r.player.played.length, 1, 'radio is not repeated');

    r.player.failNext = 'boom';
    r.adapter.say(alice, '!play broken');
    await until(() => sentTexts(r).some((t) => /Couldn't play .*boom/.test(t)), 2000, 'the error message');
    await pause(60);
    assert.equal(r.player.played.length, 2, 'a track that failed is not played again');
  } finally {
    r.cleanup();
  }
});

test('!seek jumps within the same track, keeps the queue, and refuses what makes no sense', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    const far = r.adapter.addUser(6, 'Far', CH.a);
    assert.match(await say(r, alice, '!seek 30'), /Nothing is playing/);

    r.adapter.say(alice, '!play one');
    await until(() => r.player.played.length === 1);
    r.adapter.say(alice, '!play two');
    await until(() => sentTexts(r).some((t) => /position 1/.test(t)));

    assert.match(await say(r, alice, '!seek 1:30'), /Jumping to 1:30/);
    await until(() => r.player.played.length === 2, 2000, 'the track to start again');
    assert.equal(r.player.played[1]!.url, r.player.played[0]!.url, 'the same track');
    assert.equal(r.player.played[1]!.startSec, 90);
    assert.match(await say(r, alice, '!queue'), /Now: Song for "one".*\nUp next \(1\):\n1\. Song for "two"/s);

    r.player.positionSec = 90;
    await say(r, alice, '!seek -30');
    await until(() => r.player.played.length === 3);
    assert.equal(r.player.played[2]!.startSec, 60);

    assert.match(await say(r, alice, '!seek 9:59'), /past the end/);
    assert.match(await say(r, alice, '!seek soon'), /Usage/);
    assert.match(await say(r, far, '!seek 10'), /need to be in my channel/);
    assert.equal(r.player.played.length, 3, 'none of those moved anything');

    // a seek does not carry over into the next track
    r.player.endTrack();
    await until(() => r.player.played.length === 4);
    assert.match(r.player.played[3]!.url, /two/);
    assert.equal(r.player.played[3]!.startSec ?? 0, 0);

    r.adapter.say(alice, '!radio 1');
    await until(() => sentTexts(r).some((t) => /Queued: .*radio/.test(t)));
    await say(r, alice, '!skip');
    await until(() => r.player.played.length === 5);
    assert.match(await say(r, alice, '!seek 10'), /Live radio/);
  } finally {
    r.cleanup();
  }
});

// ---- Auto-DJ and 24/7 --------------------------------------------------------------------

test('Auto-DJ plays a station when someone is listening, but not to an empty room, and only admins run it', async () => {
  const r = await makeRig();
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.a, 'uid-Admin'); // in another channel
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    assert.match(await say(r, alice, '!autodj'), /admins only/i);

    assert.match(await say(r, admin, '!autodj'), /Auto-DJ is off.*none chosen/);
    assert.match(await say(r, admin, '!autodj on'), /Choose a source first/);
    assert.match(await say(r, admin, '!autodj source radio nowhere'), /don't know that station/);
    assert.match(await say(r, admin, '!autodj source radio 3'), /source is now SomaFM DEF CON Radio/);
    assert.deepEqual(r.bot.state.get('audio.autodj', null), { enabled: false, source: 'radio:defcon' }, 'a station is remembered by its key');

    // nobody is with the bot yet: it stays quiet
    r.adapter.userList.splice(r.adapter.userList.indexOf(alice), 1);
    assert.match(await say(r, admin, '!autodj on'), /Auto-DJ is on/);
    await pause(80);
    assert.equal(r.player.played.length, 0, 'nobody is listening');

    r.adapter.userList.push(alice);
    await say(r, admin, '!autodj on');
    await until(() => r.player.played.length === 1, 2000, 'Auto-DJ to start');
    assert.equal(r.player.played[0]!.kind, 'radio');
    assert.match(r.player.played[0]!.url, /defcon/);
    assert.ok(!r.adapter.sent.some((s) => s.kind === 'channel' && /Now playing/.test(s.text)), 'Auto-DJ does not announce itself in chat');
    assert.match(await say(r, alice, '!queue'), /Now: SomaFM DEF CON Radio \[radio\] - Auto-DJ/);
    assert.equal(r.bot.services.get<{ state(): { autoDj: { enabled: boolean; sourceName: string } } }>('audio')!.state().autoDj.sourceName, 'SomaFM DEF CON Radio');
  } finally {
    r.cleanup();
  }
});

test('a request goes ahead of Auto-DJ, Auto-DJ comes back afterwards, and a stop keeps it quiet for a while', async () => {
  const r = await makeRig();
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    await say(r, admin, '!autodj source radio groovesalad');
    await say(r, admin, '!autodj on');
    await until(() => r.player.played.length === 1, 2000, 'Auto-DJ to start');

    r.adapter.say(alice, '!play my song');
    await until(() => r.player.played.length === 2, 2000, 'the request to start at once');
    assert.equal(r.player.played[1]!.kind, 'media');
    assert.ok(sentTexts(r).some((t) => /Queued: .*starting now/.test(t)), 'told it starts now, not "position 1"');

    r.player.endTrack();
    await until(() => r.player.played.length === 3, 2000, 'Auto-DJ to come back');
    assert.equal(r.player.played[2]!.kind, 'radio');

    await say(r, alice, '!stop');
    await until(() => !r.player.playing, 2000, 'the stop');
    await pause(150);
    assert.equal(r.player.played.length, 3, 'stop keeps Auto-DJ quiet');

    await say(r, admin, '!autodj on'); // turning it on again lifts the pause
    await until(() => r.player.played.length === 4, 2000, 'Auto-DJ after being asked again');
    await say(r, admin, '!autodj off');
    await until(() => !r.player.playing, 2000, 'turning it off stops its music');
  } finally {
    r.cleanup();
  }
});

test('Auto-DJ from a playlist picks tracks at random without playing the same one twice in a row', async () => {
  const r = await makeRig();
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    r.adapter.addUser(5, 'Alice', CH.home);
    assert.match(await say(r, admin, '!autodj source playlist Mix'), /playlists cog is not loaded/);

    const tracks = ['a', 'b', 'c'].map((x) => ({ kind: 'media' as const, title: `Song ${x}`, url: `https://x.test/${x}` }));
    r.bot.services.provide<PlaylistsService>('playlists', {
      list: () => [{ name: 'Friday Mix', tracks: 3, owner: 'x' }, { name: 'Empty', tracks: 0, owner: 'x' }],
      tracks: (name) => (name.toLowerCase() === 'friday mix' ? tracks : undefined),
    });
    assert.match(await say(r, admin, '!autodj source playlist nothing'), /no playlist called/);
    assert.match(await say(r, admin, '!autodj source playlist empty'), /no tracks yet/);
    assert.match(await say(r, admin, '!autodj source playlist friday mix'), /source is now Friday Mix/);
    assert.deepEqual(r.bot.state.get<{ source: string }>('audio.autodj', { source: '' }).source, 'playlist:Friday Mix', 'the playlist keeps its own spelling');

    await say(r, admin, '!autodj on');
    await until(() => r.player.played.length === 1, 2000, 'the first pick');
    for (let i = 2; i <= 8; i++) {
      r.player.endTrack();
      await until(() => r.player.played.length === i, 2000, `pick ${i}`);
      assert.notEqual(r.player.played[i - 1]!.url, r.player.played[i - 2]!.url, 'never the same song twice in a row');
    }
    assert.ok(new Set(r.player.played.map((p) => p.url)).size >= 2, 'it does vary');
  } finally {
    r.cleanup();
  }
});

test('when Auto-DJ cannot play, it says nothing in chat and waits before trying again', async () => {
  const r = await makeRig({ audio: { autoDj: { enabled: true, source: 'radio:groovesalad' } } });
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    r.player.failNext = 'no route to host';
    assert.match(await say(r, admin, '!autodj'), /Auto-DJ is on/, 'the setting from config.json is used');
    await say(r, admin, '!autodj on');
    await until(() => r.player.played.length === 1, 2000, 'the first try');
    await pause(150);
    assert.equal(r.player.played.length, 1, 'no second try straight away');
    assert.ok(!sentTexts(r).some((t) => /Couldn't play/.test(t)), 'no complaint in chat');
  } finally {
    r.cleanup();
  }
});

test('Auto-DJ to an empty room gives way to a person who asks from another channel', async () => {
  const r = await makeRig();
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    await say(r, admin, '!autodj source radio groovesalad');
    await say(r, admin, '!autodj on');
    await until(() => r.player.played.length === 1, 2000, 'Auto-DJ to start');
    r.adapter.userList.splice(r.adapter.userList.indexOf(admin), 1); // the room empties

    const bob = r.adapter.addUser(7, 'Bob', CH.a);
    r.adapter.say(bob, '!play bob song');
    await until(() => r.player.played.length === 2, 2000, 'the request');
    assert.equal(r.adapter.chan, CH.a, 'the bot followed Bob');
    assert.equal(r.player.played[1]!.kind, 'media');
  } finally {
    r.cleanup();
  }
});

test('24/7 mode keeps the bot where it is instead of going home', async () => {
  const r = await makeRig(); // the test bot normally goes home 50 ms after it goes quiet
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.a, 'uid-Admin');
    const alice = r.adapter.addUser(5, 'Alice', CH.a);
    assert.match(await say(r, alice, '!stay on'), /admins only/i);
    assert.match(await say(r, admin, '!stay'), /24\/7 mode is off/);
    assert.match(await say(r, admin, '!stay on'), /24\/7 mode is on/);
    assert.equal(r.bot.state.get('audio.stay', false), true);

    r.adapter.say(alice, '!play one');
    await until(() => r.player.played.length === 1);
    assert.equal(r.adapter.chan, CH.a);
    r.player.endTrack();
    await until(() => !r.player.playing);
    await pause(300);
    assert.equal(r.adapter.chan, CH.a, 'it stayed');

    assert.match(await say(r, admin, '!247 off'), /24\/7 mode is off/);
    await until(() => r.adapter.chan === CH.home, 2000, 'going home once 24/7 is off');
    assert.match(await say(r, admin, '!stay maybe'), /Usage/);
  } finally {
    r.cleanup();
  }
});

test('in 24/7 mode Auto-DJ stops streaming to an empty room, starts when someone joins, and the bot stays put', { timeout: 30_000 }, async () => {
  // the bot checks its channel every 5 s, so this test takes a moment
  const r = await makeRig({ follow: { idleReturnSeconds: 0.05, aloneLeaveSeconds: 0.01 } });
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.a, 'uid-Admin');
    const alice = r.adapter.addUser(5, 'Alice', CH.a);
    await say(r, admin, '!stay on');
    await say(r, admin, '!autodj source radio groovesalad');
    await say(r, admin, '!goto Gaming A');
    await say(r, admin, '!autodj on');
    await until(() => r.player.played.length === 1, 2000, 'Auto-DJ to start for Alice and Admin');
    assert.equal(r.adapter.chan, CH.a);

    r.adapter.userList.length = 0; // everybody leaves
    await until(() => !r.player.playing, 15_000, 'Auto-DJ to stop for an empty room');
    assert.equal(r.adapter.chan, CH.a, '24/7: it does not go home');
    await pause(300);
    assert.equal(r.adapter.chan, CH.a);

    r.adapter.userList.push(alice); // someone comes back
    await until(() => r.player.played.length === 2, 15_000, 'Auto-DJ to start again');
  } finally {
    r.cleanup();
  }
});

// ---- keeping trolls out ----------------------------------------------------------------

test('a blocked person cannot use the music commands, and an admin can lift it', async () => {
  const r = await makeRig({ cogs: ['core', 'audiotest', 'voteskip'] });
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    const bob = r.adapter.addUser(7, 'Bob', CH.home);
    r.adapter.say(alice, '!play one');
    await until(() => r.player.played.length === 1);

    assert.match(await say(r, bob, '!block Alice'), /admins only/i);
    assert.match(await say(r, admin, '!block Admin'), /cannot be blocked/);
    assert.match(await say(r, admin, '!block Nobody'), /nobody is called/);
    assert.match(await say(r, admin, '!block Alice'), /Alice is blocked from the music commands until you use !unblock/);

    for (const cmd of ['!play two', '!radio 1', '!skip', '!stop', '!pause', '!seek 10', '!repeat track', '!move 1 2', '!volume 20', '!summon', '!clear', '!shuffle', '!voteskip']) {
      assert.match(await say(r, alice, cmd), /blocked/, cmd);
    }
    assert.equal(r.player.played.length, 1);
    assert.equal(r.player.playing, true, 'nothing she tried had any effect');
    assert.match(await say(r, alice, '!queue'), /Now:/, 'she can still look');
    assert.match(await say(r, alice, '!volume'), /Volume is/, 'and ask');
    assert.match(await say(r, bob, '!repeat'), /Repeat is off/, 'others are not affected');

    assert.match(await say(r, admin, '!blocklist'), /1\. Alice/);
    assert.match(await say(r, admin, '!unblock 1'), /Alice can use the music commands again/);
    assert.match(await say(r, admin, '!unblock 1'), /Nobody blocked matches/);
    assert.match(await say(r, alice, '!pause'), /Paused/);
  } finally {
    r.cleanup();
  }
});

test('a block can be for a set time, is found by #number, and survives a restart of the cog', async () => {
  const r = await makeRig();
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    r.adapter.addUser(5, 'Alice', CH.home, 'uid-alice');
    r.adapter.addUser(7, 'Al', CH.home, 'uid-al');
    r.adapter.addUser(8, 'Some One', CH.home, 'uid-some');

    assert.match(await say(r, admin, '!block Al'), /Al is blocked/, 'an exact name wins over a longer one that contains it');
    await say(r, admin, '!unblock Al');
    assert.match(await say(r, admin, '!block ali'), /Alice is blocked/, 'part of a name will do if it fits one person');
    await say(r, admin, '!unblock Alice');
    assert.match(await say(r, admin, '!block A'), /More than one person fits: .*#5.*#7/, 'and it asks for the number when it does not');
    assert.match(await say(r, admin, '!block #999'), /Nobody with the number 999/);
    assert.match(await say(r, admin, '!block #5 30'), /Alice is blocked .* for 30 minute/);
    assert.match(await say(r, admin, '!block Some One 15'), /Some One is blocked .* for 15 minute/, 'a name with a space, then minutes');
    assert.match(await say(r, admin, '!block #7 0'), /Minutes must be from 1/);
    assert.match(await say(r, admin, '!blocklist'), /1\. Alice \(30 min left\)\n2\. Some One \(15 min left\)/);
    assert.match(await say(r, r.adapter.userList.find((u) => u.id === 5)!, '!play x'), /blocked .* for another 30 minute/);

    // a block that has run out is gone the next time anyone looks
    r.bot.state.set('audio.blocked', [{ uid: 'uid-alice', name: 'Alice', until: Date.now() - 1000 }]);
    assert.match(await say(r, admin, '!blocklist'), /Nobody is blocked/);
    assert.deepEqual(r.bot.state.get('audio.blocked', null), []);
  } finally {
    r.cleanup();
  }
});

test('one person cannot fill the queue: the per-person limit, with admins exempt', async () => {
  const r = await makeRig({ audio: { maxQueuePerUser: 2 } });
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    const bob = r.adapter.addUser(7, 'Bob', CH.home);
    for (const q of ['a1', 'a2']) r.adapter.say(alice, `!play ${q}`);
    await until(() => sentTexts(r).filter((t) => /Queued/.test(t)).length === 2);
    assert.match(await say(r, alice, '!play a3'), /as many tracks queued as you are allowed \(2\)/);
    assert.match(await say(r, bob, '!play b1'), /Queued/, 'somebody else is unaffected');
    for (const q of ['x1', 'x2', 'x3']) r.adapter.say(admin, `!play ${q}`);
    await until(() => sentTexts(r).filter((t) => /Queued/.test(t)).length === 6, 2000, 'the admin to queue three');

    r.player.endTrack(); // Alice's first track ends, so she has room again
    await until(() => r.player.played.length === 2);
    assert.match(await say(r, alice, '!play a3'), /Queued/);
    assert.match(await say(r, admin, '!blocklist'), /Each person may have 2 tracks queued/);
  } finally {
    r.cleanup();
  }
});

test('blocked words keep tracks out of the queue, for everyone but admins', async () => {
  const r = await makeRig({ audio: { blockedWords: ['Loud Noise'] } });
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    assert.match(await say(r, alice, '!blockword spam'), /admins only/i);
    assert.match(await say(r, alice, '!play LOUD NOISE compilation'), /isn't allowed here/, 'words from config.json, any capitals');
    assert.match(await say(r, admin, '!blockword Earrape'), /now kept out of the queue/);
    assert.match(await say(r, admin, '!blockword earrape'), /already blocked/);
    assert.match(await say(r, alice, '!play best earrape ever'), /isn't allowed here/);
    assert.equal(r.player.played.length, 0);
    assert.match(await say(r, admin, '!blocklist'), /Blocked words: loud noise, earrape/);

    r.adapter.say(admin, '!play earrape for testing');
    await until(() => r.player.played.length === 1, 2000, 'the admin to get through');

    assert.match(await say(r, admin, '!unblockword earrape'), /allowed again/);
    assert.match(await say(r, admin, '!unblockword loud noise'), /comes from config\.json/);
    assert.match(await say(r, admin, '!unblockword banana'), /not on the list/);
    r.adapter.say(alice, '!play best earrape ever');
    await until(() => sentTexts(r).filter((t) => /Queued/.test(t)).length === 2, 2000, 'the word to work again');
  } finally {
    r.cleanup();
  }
});

test('the new settings are checked when the config is read', async () => {
  const { buildConfig } = await import('../src/config.js');
  assert.deepEqual(buildConfig({}).audio.autoDj, { enabled: false, source: '' });
  assert.equal(buildConfig({}).audio.maxQueuePerUser, 0);
  assert.equal(buildConfig({}).audio.stayInChannel, false);
  assert.throws(() => buildConfig({ audio: { maxQueuePerUser: -1 } }), /maxQueuePerUser/);
  assert.throws(() => buildConfig({ audio: { maxQueuePerUser: 1.5 } }), /maxQueuePerUser/);
  assert.throws(() => buildConfig({ audio: { blockedWords: ['ok', ''] } }), /blockedWords/);
  assert.throws(() => buildConfig({ audio: { blockedWords: 'nope' } }), /blockedWords/);
  assert.throws(() => buildConfig({ audio: { autoDj: { enabled: 'yes', source: '' } } }), /autoDj/);
  assert.throws(() => buildConfig({ audio: { stayInChannel: 1 } }), /stayInChannel/);
  assert.doesNotThrow(() => buildConfig({ audio: { maxQueuePerUser: 5, blockedWords: ['x'], autoDj: { enabled: true, source: 'radio:defcon' }, stayInChannel: true } }));
});
