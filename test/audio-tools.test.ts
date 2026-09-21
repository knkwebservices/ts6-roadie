import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MAX_AUTO, MAX_REQUESTED, PlayHistory } from '../src/cogs/audio/history.js';
import { checkYoutube, HEALTH_CHECK_URL, searchMedia, SourceError, updateYtdlp } from '../src/cogs/audio/sources.js';
import type { Runner } from '../src/cogs/audio/proc.js';
import { buildConfig } from '../src/config.js';
import { formatAgo } from '../src/util/text.js';
import type { TsUser } from '../src/adapter/types.js';
import { makeRig, sentTexts, type Rig } from './audio-helpers.js';
import { CH, until } from './helpers.js';

async function say(r: Rig, user: TsUser, text: string): Promise<string> {
  const n = r.adapter.sent.length;
  r.adapter.say(user, text);
  await until(() => r.adapter.sent.length > n, 10000, `an answer to ${text}`);
  return r.adapter.sent[n]!.text;
}
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));
const cfg = buildConfig({}).audio;
/** A yt-dlp stand-in that answers with this JSON (and records what it was asked). */
const yt = (json: unknown, calls: string[][] = [], code = 0, stderr = ''): Runner => async (_cmd, args) => {
  calls.push(args);
  return { stdout: typeof json === 'string' ? json : JSON.stringify(json), stderr, code };
};

// ---- the lookups behind search, the health check and the updater ------------------------

test('searchMedia asks for several results, shows who uploaded them, and turns away links and rubbish', async () => {
  const calls: string[][] = [];
  const out = await searchMedia(
    'lofi beats',
    cfg,
    5,
    yt({ _type: 'playlist', entries: [{ title: 'One', id: 'a1', ie_key: 'Youtube', duration: 100, channel: 'Chan A' }, { title: 'Two', url: 'https://www.youtube.com/watch?v=b2', duration: 200, uploader: 'Up B' }, { title: 'Live', url: 'https://www.youtube.com/watch?v=c3', is_live: true }, { title: 'Private', url: 'http://192.168.1.5/x' }] }, calls),
  );
  assert.ok(calls[0]!.includes('ytsearch5:lofi beats'), 'asks for five results');
  assert.deepEqual(out.map((o) => [o.title, o.url, o.durationSec, o.by]), [
    ['One', 'https://www.youtube.com/watch?v=a1', 100, 'Chan A'],
    ['Two', 'https://www.youtube.com/watch?v=b2', 200, 'Up B'],
    ['Live', 'https://www.youtube.com/watch?v=c3', undefined, undefined],
  ], 'live streams have no length, and addresses inside a private network are dropped');

  await assert.rejects(searchMedia('', cfg, 5, yt({})), /what to search for/);
  await assert.rejects(searchMedia('https://www.youtube.com/watch?v=x', cfg, 5, yt({})), /link/);
  await assert.rejects(searchMedia('x'.repeat(201), cfg, 5, yt({})), /too long/);
  await assert.rejects(searchMedia('two\nlines', cfg, 5, yt({})), /too long/);
  await assert.rejects(searchMedia('nothing here', cfg, 5, yt({ _type: 'playlist', entries: [] })), (e: unknown) => e instanceof SourceError && /could not find anything/.test(e.message));
  assert.ok((await searchMedia('x', cfg, 99, yt({ _type: 'playlist', entries: [] }, calls)).catch(() => 0)) === 0);
  assert.ok(calls.at(-1)!.includes('ytsearch10:x'), 'never more than ten');
});

test('the YouTube check reports success, and explains the usual failures', async () => {
  const calls: string[][] = [];
  const good = await checkYoutube(cfg, yt({ title: 'Me at the zoo', id: 'jNQXAC9IVRw', webpage_url: HEALTH_CHECK_URL, duration: 19 }, calls));
  assert.equal(good.ok, true);
  assert.match(good.message, /YouTube works \(found "Me at the zoo"\)/);
  assert.ok(calls[0]!.includes(HEALTH_CHECK_URL));

  const bot = await checkYoutube(cfg, yt('not json', [], 1, "ERROR: [youtube] x: Sign in to confirm you're not a bot"));
  assert.equal(bot.ok, false);
  assert.match(bot.message, /not a bot.*cookies file/s);

  const js = await checkYoutube(cfg, yt('not json', [], 1, 'ERROR: No supported JavaScript runtime could be found'));
  assert.match(js.message, /--js-runtimes/);

  const other = await checkYoutube(cfg, yt('not json', [], 1, 'ERROR: something new'));
  assert.match(other.message, /Updating yt-dlp often fixes this/);

  const gone = await checkYoutube(cfg, async () => {
    throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' });
  });
  assert.equal(gone.ok, false);
  assert.match(gone.message, /was not found/);
});

test('the updater reports what yt-dlp said, and copes with it missing', async () => {
  const calls: string[][] = [];
  const ok = await updateYtdlp(cfg, async (_c, args) => (calls.push(args), { stdout: 'Current version: a\nUpdated yt-dlp to b\n', stderr: '', code: 0 }));
  assert.deepEqual(calls[0], ['-U']);
  assert.equal(ok.ok, true);
  assert.match(ok.output, /Updated yt-dlp to b/);

  const pip = await updateYtdlp(cfg, async () => ({ stdout: '', stderr: 'You installed yt-dlp with pip. Use pip to update', code: 1 }));
  assert.equal(pip.ok, false);
  assert.match(pip.output, /pip/);

  const gone = await updateYtdlp(cfg, async () => {
    throw Object.assign(new Error('x'), { code: 'ENOENT' });
  });
  assert.match(gone.output, /was not found/);
  assert.equal(formatAgo(1000, 1000 + 30_000), 'just now');
  assert.equal(formatAgo(0, 5 * 60_000), '5 min ago');
  assert.equal(formatAgo(0, 3 * 3_600_000), '3 h ago');
  assert.equal(formatAgo(0, 2 * 86_400_000), '2 d ago');
});

// ---- the history file ---------------------------------------------------------------------

test('the history keeps entries, gives each a lasting number, caps each kind, and survives restarts and damage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'roadie-hist-'));
  const file = join(dir, 'history.json');
  try {
    const h = new PlayHistory(file);
    const a = h.add({ kind: 'media', title: 'A', url: 'https://x.test/a', durationSec: 10, byName: 'Alice' });
    const b = h.add({ kind: 'radio', title: 'B', url: 'https://x.test/b', byName: 'Bob' });
    assert.deepEqual([a.id, b.id], [1, 2]);
    assert.deepEqual(h.recent(5).map((e) => e.title), ['B', 'A'], 'newest first');
    assert.equal(h.get(1)?.byName, 'Alice');

    // Auto-DJ's picks are kept apart, so a long night of them cannot push out what people asked for
    for (let i = 0; i < MAX_AUTO + 20; i++) h.add({ kind: 'media', title: `auto ${i}`, url: `https://x.test/auto${i}`, byName: 'Auto-DJ', auto: true });
    assert.equal(h.size, 2 + MAX_AUTO);
    assert.ok(h.get(1) && h.get(2), 'the two requested tracks are still there');
    assert.equal(h.recent(1)[0]!.title, `auto ${MAX_AUTO + 19}`);
    for (let i = 0; i < MAX_REQUESTED + 5; i++) h.add({ kind: 'media', title: `req ${i}`, url: `https://x.test/r${i}`, byName: 'P' });
    assert.equal(h.size, MAX_AUTO + MAX_REQUESTED);
    assert.equal(h.get(1), undefined, 'the oldest requested track was dropped');

    // a restart keeps them, and the numbers carry on
    const again = new PlayHistory(file);
    assert.equal(again.size, h.size);
    assert.equal(again.add({ kind: 'media', title: 'next', url: 'https://x.test/n', byName: 'X' }).id, h.recent(1)[0]!.id + 1);

    // a hand-edited file is trusted only where it makes sense
    writeFileSync(file, JSON.stringify({ version: 1, nextId: 5, entries: [{ id: 7, at: 1, kind: 'media', title: 'ok\nline', url: 'https://x.test/ok', byName: 'Z' }, { id: 8, url: 'http://192.168.1.9/private', title: 'no' }, { id: 'x', url: 'https://x.test/y' }, null] }));
    const edited = new PlayHistory(file);
    assert.deepEqual(edited.recent(5).map((e) => [e.id, e.title]), [[7, 'ok line']]);
    assert.equal(edited.add({ kind: 'media', title: 'n', url: 'https://x.test/n', byName: 'X' }).id, 8, 'numbers never reuse an old one');

    writeFileSync(file, '{ broken');
    assert.equal(new PlayHistory(file).size, 0, 'a damaged file is not worth refusing to start');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- search and pick --------------------------------------------------------------------------

test('!search lists results and !pick queues the one you choose, for you alone', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    const bob = r.adapter.addUser(6, 'Bob', CH.home);
    assert.match(await say(r, alice, '!pick 1'), /Search first/);
    assert.match(await say(r, alice, '!search'), /Usage/);

    const found = await say(r, alice, '!search lofi beats');
    assert.match(found, /Results for "lofi beats":\n1\. lofi beats result 1 \[1:40\] - Channel 1\n2\. .* \[3:20\] - Channel 2\n3\. .*Channel 3\nUse !pick <number>/);
    assert.deepEqual(r.yt.searchCalls, ['lofi beats']);

    assert.match(await say(r, bob, '!pick 2'), /Search first/, "Bob has not searched: Alice's results are hers");
    assert.match(await say(r, alice, '!pick 9'), /Pick a number from 1 to 3/);
    assert.match(await say(r, alice, '!pick two'), /Pick a number/);

    r.adapter.say(alice, '!pick 2');
    await until(() => r.player.played.length === 1, 10000, 'the chosen track');
    assert.equal(r.player.played[0]!.url, 'https://www.youtube.com/watch?v=lofi%20beats2');
    assert.ok(!r.yt.searchCalls.includes('2'), 'picking does not search again');
  } finally {
    r.cleanup();
  }
});

test('search results are forgotten after five minutes, errors are explained, and blocked people cannot search', async () => {
  const r = await makeRig();
  const realNow = Date.now;
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    await say(r, alice, '!search song');
    Date.now = () => realNow() + 6 * 60_000; // the clock only ever moves forward from here
    assert.match(await say(r, alice, '!pick 1'), /Search first/, 'too old');

    r.yt.search = async () => {
      throw new SourceError('YouTube is asking the server to prove it is not a bot.');
    };
    assert.match(await say(r, alice, '!search anything'), /not a bot/);
    r.yt.search = async () => {
      throw new Error('spawn exploded');
    };
    assert.match(await say(r, alice, '!search anything'), /That didn't work: spawn exploded/);

    await say(r, admin, '!block Alice');
    assert.match(await say(r, alice, '!search song'), /blocked/);
  } finally {
    Date.now = realNow;
    r.cleanup();
  }
});

// ---- history commands --------------------------------------------------------------------------

test('!history lists what was played, and !again plays one of them once more', async () => {
  const r = await makeRig();
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    assert.match(await say(r, alice, '!history'), /Nothing has been played yet/);

    r.adapter.say(alice, '!play first song');
    await until(() => r.player.played.length === 1);
    r.adapter.say(alice, '!radio 1');
    await until(() => sentTexts(r).some((t) => /Queued: .*radio.*position 1/.test(t)));
    r.player.endTrack();
    await until(() => r.player.played.length === 2, 10000, 'the radio to start');

    const list = await say(r, alice, '!history');
    assert.match(list, /^Recently played:\n#2 SomaFM Groove Salad \[radio\] - Alice, just now\n#1 Song for "first song" \[3:20\] - Alice, just now\nUse !again <#number>/);
    assert.match(await say(r, alice, '!history 1'), /^Recently played:\n#2 /);
    assert.match(await say(r, alice, '!recent'), /Recently played/);

    // playing it again: as a track, with the radio kept as a station
    r.adapter.say(alice, '!again #1');
    await until(() => sentTexts(r).filter((t) => /Queued: Song for "first song"/.test(t)).length === 1, 10000, 'the song to queue');
    r.adapter.say(alice, '!again 2');
    await until(() => sentTexts(r).filter((t) => /Queued: SomaFM Groove Salad \[radio\]/.test(t)).length === 2, 10000, 'the station to queue');
    assert.match(await say(r, alice, '!again 99'), /don't have that one/);
    assert.match(await say(r, alice, '!again'), /don't have that one/);
  } finally {
    r.cleanup();
  }
});

test('a seek or a repeat is not a new entry in the history, and Auto-DJ picks are marked', async () => {
  const r = await makeRig();
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!play one');
    await until(() => r.player.played.length === 1);
    await say(r, admin, '!seek 30');
    await until(() => r.player.played.length === 2);
    await say(r, admin, '!repeat track');
    r.player.endTrack();
    await until(() => r.player.played.length === 3);
    assert.equal(r.bot.services.get<{ history(): unknown[] }>('audio')!.history().length, 1, 'still just the one track');

    await say(r, admin, '!stop');
    await until(() => !r.player.playing);
    await say(r, admin, '!autodj source radio defcon');
    await say(r, admin, '!autodj on');
    await until(() => r.player.played.length === 4, 10000, 'Auto-DJ');
    assert.match(await say(r, admin, '!history'), /#2 SomaFM DEF CON Radio \[radio\] - Auto-DJ, just now/);
    assert.equal(r.bot.services.get<{ history(): { auto?: boolean }[] }>('audio')!.history()[0]!.auto, true);
  } finally {
    r.cleanup();
  }
});

test('!again respects blocks and limits like any other request', async () => {
  const r = await makeRig({ audio: { maxQueuePerUser: 1 } });
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    r.adapter.say(admin, '!play seed');
    await until(() => r.player.played.length === 1);
    r.adapter.say(alice, '!again 1');
    await until(() => sentTexts(r).filter((t) => /Queued: Song for "seed"/.test(t)).length === 2, 10000, 'the first again (the admin\'s own !play made the first match)');
    assert.match(await say(r, alice, '!again 1'), /as many tracks queued as you are allowed/);
    await say(r, admin, '!block Alice');
    assert.match(await say(r, alice, '!again 1'), /blocked/);
  } finally {
    r.cleanup();
  }
});

// ---- tools and the YouTube check --------------------------------------------------------------------

test('!tools, !ytcheck and !ytupdate are for admins, and say what they found', async () => {
  const r = await makeRig();
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    for (const c of ['!tools', '!ytcheck', '!ytupdate']) assert.match(await say(r, alice, c), /admins only/i, c);
    assert.equal(r.yt.healthCalls + r.yt.updateCalls, 0);

    assert.match(await say(r, admin, '!tools'), /^yt-dlp test \| ffmpeg test\nYouTube: not checked yet \(!ytcheck runs it\)/);
    r.adapter.say(admin, '!ytcheck');
    await until(() => r.adapter.sent.length >= 3 && /OK \(1\.2 s\)/.test(r.adapter.lastReply()), 10000, 'the check');
    assert.match(sentTexts(r).join('\n'), /Checking YouTube\.\.\./);
    assert.match(await say(r, admin, '!tools'), /YouTube: OK just now: YouTube works/);

    r.yt.health = { ok: false, message: 'YouTube is asking for a cookies file. Updating yt-dlp often fixes this.' };
    r.adapter.say(admin, '!ytcheck');
    await until(() => /PROBLEM/.test(r.adapter.lastReply()), 10000, 'the failed check');
    assert.match(await say(r, admin, '!tools'), /YouTube: PROBLEM just now: YouTube is asking/);

    r.adapter.say(admin, '!ytupdate');
    await until(() => /Done\. yt-dlp is now 2099\.01\.01\.\nUpdated yt-dlp to 2099\.01\.01\nTip: !ytcheck/.test(r.adapter.lastReply()), 10000, 'the update');
    assert.match(sentTexts(r).join('\n'), /Updating yt-dlp \(this can take a minute\)/);
    assert.equal(r.yt.updateCalls, 1);
    assert.match(await say(r, admin, '!status'), /yt-dlp 2099\.01\.01 \| ffmpeg test/);

    r.yt.update = { ok: false, output: 'You installed yt-dlp with pip.' };
    r.adapter.say(admin, '!ytupdate');
    await until(() => /The update did not work/.test(r.adapter.lastReply()), 10000, 'the failed update');
    assert.doesNotMatch(r.adapter.lastReply(), /Tip:/);
  } finally {
    r.cleanup();
  }
});

test('two updates at once: the second is told to wait, and the tools card shows it is updating', async () => {
  const r = await makeRig();
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const svc = r.bot.services.get<{ tools(): { updating: boolean } }>('audio')!;
    r.yt.updateDelayMs = 300;
    r.adapter.say(admin, '!ytupdate');
    await until(() => svc.tools().updating, 10000, 'the update to start');
    assert.match(await say(r, admin, '!ytupdate'), /already being updated/);
    assert.match(await say(r, admin, '!tools'), /yt-dlp is being updated right now/);
    assert.equal(r.yt.updateCalls, 1);
    await until(() => /Done\. yt-dlp is now/.test(r.adapter.lastReply()), 10000, 'the first to finish');
    assert.equal(svc.tools().updating, false, 'cleared afterwards');
  } finally {
    r.cleanup();
  }
});

test('the YouTube check runs by itself, tells online admins only after a second failure, and says when it recovers', async () => {
  const r = await makeRig({ audio: { healthCheckHours: 0.0003 } }); // every ~1 s (the first check at half that), so the test is quick but not jumpy
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    await until(() => r.yt.healthCalls >= 1, 10000, 'the first automatic check');
    assert.equal(r.adapter.sent.length, 0, 'all is well: nobody is bothered');

    r.yt.health = { ok: false, message: 'YouTube is broken for now.' };
    await until(() => r.adapter.sent.some((s) => /looks broken: YouTube is broken for now\./.test(s.text)), 10_000, 'the warning');
    const warned = r.adapter.sent.filter((s) => /looks broken/.test(s.text));
    assert.equal(warned.length, 1, 'told once, not at every check');
    assert.equal(warned[0]!.kind, 'private');
    assert.equal(warned[0]!.to, admin.id, 'the admin was told');
    assert.ok(!r.adapter.sent.some((s) => s.to === alice.id), 'other people were not');

    r.yt.health = { ok: true, message: 'YouTube works (found "Me at the zoo")' };
    await until(() => r.adapter.sent.some((s) => /working again/.test(s.text)), 10_000, 'the all-clear');
    await pause(1500);
    assert.equal(r.adapter.sent.filter((s) => /working again/.test(s.text)).length, 1);
  } finally {
    r.cleanup();
  }
});

test('one failed check that clears up at the next try does not bother anyone', async () => {
  const r = await makeRig({ audio: { healthCheckHours: 0.0003 } });
  try {
    r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    r.yt.health = { ok: false, message: 'blip' };
    await until(() => r.yt.healthCalls >= 1, 10000, 'the first check');
    r.yt.health = { ok: true, message: 'YouTube works (found "x")' };
    await until(() => r.yt.healthCalls >= 2, 10000, 'the next check');
    await pause(100);
    assert.equal(r.adapter.sent.length, 0, 'a single blip is not worth a message');
  } finally {
    r.cleanup();
  }
});

test('with healthCheckHours at 0 the bot never checks by itself', async () => {
  const r = await makeRig({ audio: { healthCheckHours: 0 } });
  try {
    await pause(300);
    assert.equal(r.yt.healthCalls, 0);
  } finally {
    r.cleanup();
  }
});

// ---- reconnecting a dropped radio station ------------------------------------------------------

const radioRig = (audio: Record<string, unknown> = {}) => makeRig({ audio: { radioRetrySeconds: 0.01, ...audio } });

test('a station that drops is reconnected, and the listeners are told once', async () => {
  const r = await radioRig({ radioRetries: 3 });
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    r.adapter.say(alice, '!radio 1');
    await until(() => r.player.played.length === 1);
    r.player.endTrack(); // the stream dies
    await until(() => r.player.played.length === 2, 10000, 'the reconnect');
    assert.equal(r.player.played[1]!.url, r.player.played[0]!.url, 'the same station');
    r.player.failNext = 'connection reset';
    r.player.endTrack();
    await until(() => r.player.played.length === 4, 10000, 'two more tries');
    assert.equal(sentTexts(r).filter((t) => /dropped - reconnecting/.test(t)).length, 1, 'told once, not at every try');
    assert.equal(r.bot.services.get<{ history(): unknown[] }>('audio')!.history().length, 1, 'still one entry in the history');
  } finally {
    r.cleanup();
  }
});

test('when the tries run out the bot says so; !stop during a reconnect cancels it', async () => {
  const r = await radioRig({ radioRetries: 1, radioRetrySeconds: 0.05 });
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    r.adapter.say(alice, '!radio 2');
    await until(() => r.player.played.length === 1);
    r.player.failNext = 'no route';
    r.player.endTrack();
    await until(() => sentTexts(r).some((t) => /Couldn't play .*no route/.test(t)), 10000, 'to give up');
    await pause(150);
    assert.equal(r.player.played.length, 2, 'one retry, which failed, and then no more');

    // stopping while it waits to reconnect
    const r2 = await radioRig({ radioRetries: 3, radioRetrySeconds: 0.3 });
    try {
      const bob = r2.adapter.addUser(5, 'Bob', CH.home);
      r2.adapter.say(bob, '!radio 1');
      await until(() => r2.player.played.length === 1);
      r2.player.endTrack();
      await pause(50);
      r2.adapter.say(bob, '!stop');
      await pause(600);
      assert.equal(r2.player.played.length, 1, 'stopped for good: no reconnect');
    } finally {
      r2.cleanup();
    }
  } finally {
    r.cleanup();
  }
});

test('a problem that reconnecting cannot fix (the tool is missing) is not retried', async () => {
  const r = await radioRig({ radioRetries: 3 });
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    r.player.failNext = 'ffmpeg was not found (looked for "ffmpeg")';
    r.adapter.say(alice, '!radio 1');
    await until(() => sentTexts(r).some((t) => /Couldn't play .*ffmpeg was not found/.test(t)), 10000, 'the message');
    await pause(150);
    assert.equal(r.player.played.length, 1);
  } finally {
    r.cleanup();
  }
});

test('a station that will not come back is swapped for the fallback, once', async () => {
  const r = await radioRig({ radioRetries: 1, radioFallback: 'defcon' });
  try {
    const alice = r.adapter.addUser(5, 'Alice', CH.home);
    r.adapter.say(alice, '!radio 1');
    await until(() => r.player.played.length === 1);
    r.player.failNext = 'gone';
    r.player.endTrack();
    await until(() => r.player.played.length === 3, 10000, 'the retry and then the fallback');
    assert.match(r.player.played[1]!.url, /groovesalad/, 'the retry was the same station');
    assert.match(r.player.played[2]!.url, /defcon/, 'then the fallback');
    assert.ok(sentTexts(r).some((t) => /isn't working, so I switched to "SomaFM DEF CON Radio"/.test(t)));
    assert.match(await say(r, alice, '!queue'), /Now: SomaFM DEF CON Radio \[radio\]/);

    // the fallback drops too: it gets its own retry but is not swapped again
    r.player.failNext = 'also gone';
    r.player.endTrack();
    await until(() => sentTexts(r).some((t) => /Couldn't play "SomaFM DEF CON Radio": also gone/.test(t)), 10000, 'to give up');
    await pause(150);
    assert.equal(r.player.played.length, 4, 'a retry of the fallback, then nothing more');
  } finally {
    r.cleanup();
  }
});

test('Auto-DJ reconnects a dropped station without a word in chat', async () => {
  const r = await radioRig({ radioRetries: 2 });
  try {
    const admin = r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    await say(r, admin, '!autodj source radio groovesalad');
    await say(r, admin, '!autodj on');
    await until(() => r.player.played.length === 1, 10000, 'Auto-DJ');
    const before = r.adapter.sent.length;
    r.player.endTrack();
    await until(() => r.player.played.length === 2, 10000, 'the silent reconnect');
    assert.equal(r.adapter.sent.length, before, 'nothing said in chat');
  } finally {
    r.cleanup();
  }
});

test('the new settings are checked when the config is read', () => {
  assert.equal(buildConfig({}).audio.radioRetries, 3);
  assert.equal(buildConfig({}).audio.radioRetrySeconds, 2);
  assert.equal(buildConfig({}).audio.radioFallback, '');
  assert.equal(buildConfig({}).audio.healthCheckHours, 12);
  assert.throws(() => buildConfig({ audio: { radioRetries: -1 } }), /radioRetries/);
  assert.throws(() => buildConfig({ audio: { radioRetries: 1.5 } }), /radioRetries/);
  assert.throws(() => buildConfig({ audio: { radioRetrySeconds: 0 } }), /radioRetrySeconds/);
  assert.throws(() => buildConfig({ audio: { radioFallback: 5 } }), /radioFallback/);
  assert.throws(() => buildConfig({ audio: { healthCheckHours: -1 } }), /healthCheckHours/);
  assert.doesNotThrow(() => buildConfig({ audio: { radioRetries: 0, radioFallback: 'defcon', healthCheckHours: 0 } }));
});
