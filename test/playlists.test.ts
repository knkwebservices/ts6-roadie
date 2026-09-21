import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { AUDIO_SERVICE, type AudioService, type QueueItem } from '../src/core/services.js';
import { PlaylistStore, validName } from '../src/cogs/playlists/store.js';
import { silentLog } from '../src/logger.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const song = (n: number, kind: QueueItem['kind'] = 'media'): QueueItem => ({
  kind,
  title: `Song ${n}`,
  url: `https://www.youtube.com/watch?v=song${n}`,
  durationSec: kind === 'radio' ? undefined : 100 + n,
});

/** A stand-in for the audio cog's service: we set what is "playing", and record what gets queued or looked up. */
function fakeAudio(snapshot: { current?: QueueItem; upcoming: QueueItem[] }) {
  const queued: { items: QueueItem[]; label?: string; by: string }[] = [];
  const lookups: string[] = [];
  const svc: AudioService = {
    snapshot: () => ({ current: snapshot.current ? { ...snapshot.current, id: 1 } : undefined, upcoming: snapshot.upcoming }),
    queue: async (ctx, items, opts) => {
      queued.push({ items, label: opts?.label, by: ctx.msg.senderName });
      await ctx.reply(`(fake) queued ${items.length}`);
    },
    skip: () => true,
    resolve: async (input) => {
      lookups.push(input);
      if (input === 'boom') throw new Error('yt-dlp could not open that (Video unavailable)');
      if (input === 'album') return [song(21), song(22), song(23)];
      return [song(20)];
    },
  };
  return { svc, queued, lookups, snapshot };
}

async function setup(playlistsCfg: Record<string, unknown> = {}, withAudio = true) {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'playlists'], playlists: playlistsCfg }) });
  const audio = fakeAudio({ current: song(1), upcoming: [song(2), song(3, 'radio')] });
  if (withAudio) h.bot.services.provide<AudioService>(AUDIO_SERVICE, audio.svc);
  const alice = h.adapter.addUser(5, 'Alice', CH.home, 'uid-Alice');
  const bob = h.adapter.addUser(6, 'Bob', CH.home, 'uid-Bob');
  const admin = h.adapter.addUser(7, 'Admin', CH.home, 'uid-Admin');
  return { h, audio, alice, bob, admin };
}

async function ask(h: Harness, u: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  h.adapter.say(u, text);
  await until(() => h.adapter.sent.length > n, 10000, `a reply to "${text}"`);
  return h.adapter.lastReply();
}

test('save, list, show and load a playlist (names ignore case; current track comes first)', async () => {
  const { h, audio, alice, bob } = await setup();
  try {
    assert.match(await ask(h, alice, '!playlist save Friday Night'), /Saved "Friday Night" with 3 tracks/);
    assert.match(await ask(h, bob, '!playlist list'), /Friday Night \(3 tracks, by Alice\)/);
    const shown = await ask(h, bob, '!pl show friday night');
    assert.match(shown, /1\. Song 1 \[1:41\]/);
    assert.match(shown, /3\. Song 3 \[radio\]/);

    await ask(h, bob, '!playlist load FRIDAY NIGHT');
    assert.equal(audio.queued.length, 1);
    assert.deepEqual(audio.queued[0]!.items.map((t) => t.title), ['Song 1', 'Song 2', 'Song 3']);
    assert.equal(audio.queued[0]!.items[2]!.kind, 'radio', 'kinds are preserved');
    assert.equal(audio.queued[0]!.label, 'Friday Night');
    assert.equal(audio.queued[0]!.by, 'Bob', 'the requester is whoever loads it, not who saved it');
  } finally {
    h.cleanup();
  }
});

test('playlists are written to disk and survive the cog being reloaded', async () => {
  const { h, alice } = await setup();
  try {
    await ask(h, alice, '!playlist save keep me');
    const file = join(h.dir, 'playlists.json');
    assert.ok(existsSync(file));
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).version, 1);

    await h.bot.reloadCog('playlists');
    assert.match(await ask(h, alice, '!playlist list'), /keep me \(3 tracks, by Alice\)/);
  } finally {
    h.cleanup();
  }
});

test('nothing to save, and bad names, are explained rather than saved', async () => {
  const { h, audio, alice } = await setup();
  try {
    audio.snapshot.current = undefined;
    audio.snapshot.upcoming = [];
    assert.match(await ask(h, alice, '!playlist save empty'), /Nothing is playing or queued/);
    audio.snapshot.upcoming = [song(2)];
    // (brackets never reach the cog from chat: the dispatcher strips anything that looks like a formatting tag; validName covers them)
    for (const bad of ['', 'x'.repeat(33), 'semi;colon']) {
      assert.match(await ask(h, alice, `!playlist save ${bad}`), /1-32 letters, numbers, spaces/, `"${bad}" should be refused`);
    }
    assert.match(await ask(h, alice, '!playlist list'), /No playlists yet/);
  } finally {
    h.cleanup();
  }
});

test('other people cannot overwrite or delete your playlist; an admin can', async () => {
  const { h, alice, bob, admin } = await setup();
  try {
    await ask(h, alice, '!playlist save mine');
    assert.match(await ask(h, bob, '!playlist save mine'), /belongs to Alice/);
    assert.match(await ask(h, bob, '!playlist delete mine'), /Only its owner or a bot admin/);

    assert.match(await ask(h, admin, '!playlist save mine'), /Updated "mine"/);
    assert.match(await ask(h, bob, '!playlist list'), /mine \(3 tracks, by Alice\)/, 'an admin overwrite keeps the original owner');

    assert.match(await ask(h, alice, '!playlist delete MINE'), /Deleted "mine"/);
    assert.match(await ask(h, bob, '!playlist load mine'), /No playlist called "mine"/);

    await ask(h, alice, '!playlist save again');
    assert.match(await ask(h, admin, '!playlist delete again'), /Deleted "again"/);
  } finally {
    h.cleanup();
  }
});

test('limits: number of playlists, and tracks per playlist', async () => {
  const { h, alice } = await setup({ maxPlaylists: 1, maxTracks: 2 });
  try {
    assert.match(await ask(h, alice, '!playlist save first'), /Saved "first" with 2 tracks.*1 more were left out/);
    assert.match(await ask(h, alice, '!playlist save second'), /already has 1 playlists/);
    assert.match(await ask(h, alice, '!playlist save first'), /Updated "first"/, 'overwriting an existing one is still allowed at the limit');
  } finally {
    h.cleanup();
  }
});

test('without the audio cog, save and load say so instead of failing', async () => {
  const { h, alice } = await setup({}, false);
  try {
    assert.match(await ask(h, alice, '!playlist save x'), /audio cog is not loaded/);
    // put one in the store by hand, then try to load it with no audio service
    await h.bot.unloadCog('playlists');
    writeFileSync(join(h.dir, 'playlists.json'), JSON.stringify({ version: 1, playlists: { x: { name: 'x', ownerUid: 'u', ownerName: 'U', createdAt: 1, updatedAt: 1, tracks: [song(1)] } } }));
    await h.bot.loadCog('playlists');
    assert.match(await ask(h, alice, '!playlist load x'), /audio cog is not loaded/);
  } finally {
    h.cleanup();
  }
});

test('an unknown subcommand shows the usage', async () => {
  const { h, alice } = await setup();
  try {
    const r = await ask(h, alice, '!playlist frobnicate');
    assert.match(r, /!playlist save <name>/);
    assert.match(r, /!playlist load <name>/);
  } finally {
    h.cleanup();
  }
});

// ---- the store: never lose data, never trust the file blindly ---------------------------------------

test('store: a corrupt file is set aside (not overwritten) and we start empty', async () => {
  const { h, alice } = await setup();
  try {
    await h.bot.unloadCog('playlists');
    const file = join(h.dir, 'playlists.json');
    writeFileSync(file, '{ this is not json');
    await h.bot.loadCog('playlists');
    assert.match(await ask(h, alice, '!playlist list'), /No playlists yet/);
    const aside = readdirSync(h.dir).filter((f) => f.startsWith('playlists.json.broken-'));
    assert.equal(aside.length, 1, 'the broken file must be kept for recovery');
    assert.equal(readFileSync(join(h.dir, aside[0]!), 'utf8'), '{ this is not json');
    assert.match(await ask(h, alice, '!playlist save fresh'), /Saved "fresh"/);
  } finally {
    h.cleanup();
  }
});

test('store: hand-edited unsafe URLs and junk are dropped on load', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsbot-pl-'));
  try {
    const file = join(dir, 'playlists.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        playlists: {
          ok: {
            name: 'ok',
            ownerUid: 'u',
            ownerName: 'U',
            createdAt: 1,
            updatedAt: 1,
            tracks: [
              { kind: 'media', title: 'good', url: 'https://www.youtube.com/watch?v=good', durationSec: 5 },
              { kind: 'media', title: 'local', url: 'http://127.0.0.1/secret' },
              { kind: 'media', title: 'file', url: 'file:///etc/passwd' },
              { kind: 'media', title: 'lan', url: 'http://192.168.1.5/x.mp3' },
              { title: 'no url' },
              'not even an object',
            ],
          },
          'bad[name]': { name: 'bad[name]', tracks: [] },
        },
      }),
    );
    const store = new PlaylistStore(file, silentLog);
    assert.deepEqual(store.list().map((p) => p.name), ['ok'], 'invalid playlist names are ignored');
    assert.deepEqual(store.get('ok')!.tracks.map((t) => t.title), ['good'], 'only the safe track survives');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('validName', () => {
  for (const ok of ['friday', 'Friday Night', "rock 'n' roll", 'Ünïcode ok', 'a-b_c.d', '90s']) assert.equal(validName(ok), true, ok);
  for (const bad of ['', ' lead', 'trail ', 'a[b]', 'x'.repeat(33), 'semi;colon', 'new\nline']) assert.equal(validName(bad), false, JSON.stringify(bad));
});

// ---- editing ---------------------------------------------------------------------------------------

test('add: creates a playlist from a lookup, appends to it, and says what it added', async () => {
  const { h, audio, alice } = await setup();
  try {
    assert.match(await ask(h, alice, '!playlist add road trip | some search words'), /Added "Song 20" to "road trip" \(1 track now\)/);
    assert.deepEqual(audio.lookups, ['some search words']);
    assert.match(await ask(h, alice, '!pl add road trip | album'), /Added 3 tracks to "road trip" \(4 tracks now\)/);
    assert.match(await ask(h, alice, '!playlist list'), /road trip \(4 tracks, by Alice\)/);
  } finally {
    h.cleanup();
  }
});

test('add: usage, bad names, lookup errors and other people\'s playlists are handled before anything is saved', async () => {
  const { h, audio, alice, bob } = await setup();
  try {
    assert.match(await ask(h, alice, '!playlist add just a name'), /Usage: !playlist add <name> \| <link/);
    assert.match(await ask(h, alice, '!playlist add | nothing'), /Usage/);
    assert.match(await ask(h, alice, `!playlist add ${'x'.repeat(40)} | song`), /1-32 letters/);
    assert.equal(audio.lookups.length, 0, 'no lookup for a request that is malformed');

    assert.match(await ask(h, alice, '!playlist add broken | boom'), /Video unavailable/);
    assert.match(await ask(h, alice, '!playlist list'), /No playlists yet/, 'a failed lookup must not create anything');

    await ask(h, alice, '!playlist add mine | song');
    const lookups = audio.lookups.length;
    assert.match(await ask(h, bob, '!playlist add mine | song'), /belongs to Alice/);
    assert.equal(audio.lookups.length, lookups, 'refused before wasting a lookup');
  } finally {
    h.cleanup();
  }
});

test('add respects the per-playlist limit', async () => {
  const { h, alice } = await setup({ maxTracks: 2 });
  try {
    assert.match(await ask(h, alice, '!playlist add tiny | album'), /Added 2 tracks to "tiny".*1 left out/);
    assert.match(await ask(h, alice, '!playlist add tiny | song'), /already has 2 tracks/);
  } finally {
    h.cleanup();
  }
});

test('remove and move edit the order, and show renumbers', async () => {
  const { h, alice } = await setup();
  try {
    await ask(h, alice, '!playlist save mix'); // Song 1, Song 2, Song 3
    assert.match(await ask(h, alice, '!playlist move mix 3 1'), /Moved "Song 3" from 3 to 1/);
    let shown = await ask(h, alice, '!playlist show mix');
    assert.match(shown, /1\. Song 3 \[radio\][\s\S]*2\. Song 1[\s\S]*3\. Song 2/);

    assert.match(await ask(h, alice, '!playlist remove mix 2'), /Removed "Song 1" from "mix" \(2 tracks left\)/);
    shown = await ask(h, alice, '!playlist show mix');
    assert.match(shown, /1\. Song 3[\s\S]*2\. Song 2/);
    assert.doesNotMatch(shown, /Song 1/);
  } finally {
    h.cleanup();
  }
});

test('remove and move validate positions and usage', async () => {
  const { h, alice } = await setup();
  try {
    await ask(h, alice, '!playlist save mix');
    assert.match(await ask(h, alice, '!playlist remove mix 0'), /Give a position from 1 to 3/);
    assert.match(await ask(h, alice, '!playlist remove mix 9'), /Give a position from 1 to 3/);
    assert.match(await ask(h, alice, '!playlist remove mix'), /Usage: !playlist remove <name> <position>/);
    assert.match(await ask(h, alice, '!playlist move mix 1 9'), /Positions go from 1 to 3/);
    assert.match(await ask(h, alice, '!playlist move mix 1'), /Usage: !playlist move/);
    assert.match(await ask(h, alice, '!playlist remove nothere 1'), /No playlist called "nothere"/);
  } finally {
    h.cleanup();
  }
});

test('rename: works, keeps the tracks and owner, refuses clashes and bad names, and allows a case-only change', async () => {
  const { h, alice, bob } = await setup();
  try {
    await ask(h, alice, '!playlist save old name');
    await ask(h, alice, '!playlist add other | song');

    assert.match(await ask(h, alice, '!playlist rename old name > new name'), /Renamed "old name" to "new name"/);
    assert.match(await ask(h, bob, '!playlist list'), /new name \(3 tracks, by Alice\)/);
    assert.match(await ask(h, bob, '!playlist load old name'), /No playlist called "old name"/);

    assert.match(await ask(h, alice, '!playlist rename new name > other'), /already a playlist called "other"/);
    assert.match(await ask(h, alice, '!playlist rename new name > bad;name'), /1-32 letters/);
    assert.match(await ask(h, alice, '!playlist rename new name'), /Usage: !playlist rename/);
    assert.match(await ask(h, alice, '!playlist rename new name > New Name'), /Renamed "new name" to "New Name"/);
    assert.match(await ask(h, bob, '!playlist rename New Name > stolen'), /belongs to Alice/);
  } finally {
    h.cleanup();
  }
});

test('non-owners cannot edit; admins can', async () => {
  const { h, alice, bob, admin } = await setup();
  try {
    await ask(h, alice, '!playlist save mix');
    for (const cmd of ['remove mix 1', 'move mix 1 2', 'add mix | song']) {
      assert.match(await ask(h, bob, `!playlist ${cmd}`), /belongs to Alice/, cmd);
    }
    assert.match(await ask(h, admin, '!playlist remove mix 1'), /Removed "Song 1"/);
  } finally {
    h.cleanup();
  }
});
