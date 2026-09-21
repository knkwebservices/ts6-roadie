import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConfig } from '../src/config.js';
import { TrackQueue, type Track } from '../src/cogs/audio/queue.js';
import { isPublicHttpUrl, listStations, resolveMedia, resolveRadio, SourceError } from '../src/cogs/audio/sources.js';
import type { Runner } from '../src/cogs/audio/proc.js';

const audio = buildConfig({}).audio;
const track = (id: number): Track => ({ id, kind: 'media', title: `t${id}`, url: `https://x.test/${id}`, requesterUid: 'u', requesterName: 'n' });

test('queue basics', () => {
  const q = new TrackQueue();
  q.add(track(1), track(2), track(3));
  assert.equal(q.next()?.id, 1);
  assert.equal(q.current?.id, 1);
  assert.equal(q.size, 2);
  assert.equal(q.remove(2)?.id, 3);
  assert.equal(q.remove(9), undefined);
  assert.equal(q.remove(0), undefined);
  assert.equal(q.clear(), 1);
  assert.equal(q.next(), undefined);
});

test('queue shuffle keeps the same tracks', () => {
  const q = new TrackQueue();
  q.add(...[1, 2, 3, 4, 5, 6].map(track));
  q.shuffle(() => 0.3);
  assert.deepEqual([...q.upcoming].map((t) => t.id).sort(), [1, 2, 3, 4, 5, 6]);
});

test('isPublicHttpUrl blocks local and private targets', () => {
  for (const ok of ['https://www.youtube.com/watch?v=abc', 'http://example.com/a.mp3', 'https://8.8.8.8/x']) assert.equal(isPublicHttpUrl(ok), true, ok);
  for (const bad of [
    'file:///etc/passwd',
    'ftp://example.com/x',
    'http://localhost:8080/',
    'http://127.0.0.1/',
    'http://2130706433/', // decimal form of 127.0.0.1
    'http://10.1.2.3/',
    'http://192.168.1.10/',
    'http://172.20.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://printer.local/',
    'javascript:alert(1)',
    'not a url',
  ])
    assert.equal(isPublicHttpUrl(bad), false, bad);
});

const fakeRun = (stdout: string, stderr = '', code = 0): Runner => async () => ({ stdout, stderr, code });

test('resolveMedia: single video', async () => {
  const json = JSON.stringify({ title: 'Song', webpage_url: 'https://www.youtube.com/watch?v=abc', duration: 200 });
  const [m] = await resolveMedia('https://www.youtube.com/watch?v=abc', audio, fakeRun(json));
  assert.deepEqual(m, { title: 'Song', url: 'https://www.youtube.com/watch?v=abc', durationSec: 200, live: false });
});

test('resolveMedia: search text becomes ytsearch1 and arguments cannot be injected', async () => {
  let seen: string[] = [];
  const run: Runner = async (_c, args) => {
    seen = args;
    return { stdout: JSON.stringify({ _type: 'playlist', entries: [{ title: 'Hit', url: 'https://www.youtube.com/watch?v=zzz', duration: 10 }] }), stderr: '', code: 0 };
  };
  const out = await resolveMedia('--exec calc.exe', audio, run);
  assert.equal(out[0]!.url, 'https://www.youtube.com/watch?v=zzz');
  const sep = seen.indexOf('--');
  assert.ok(sep > 0 && seen[sep + 1] === 'ytsearch1:--exec calc.exe', 'target must come after "--" as a single argument');
});

test('resolveMedia: playlists are capped and unsafe entries dropped', async () => {
  const entries = Array.from({ length: 40 }, (_, i) => ({ title: `s${i}`, url: `https://example.com/${i}` }));
  entries.push({ title: 'evil', url: 'http://127.0.0.1/x' });
  const out = await resolveMedia('https://example.com/list', { ...audio, maxPlaylistItems: 25 }, fakeRun(JSON.stringify({ _type: 'playlist', entries })));
  assert.equal(out.length, 25);
  assert.ok(out.every((m) => !m.url.includes('127.0.0.1')));
});

test('resolveMedia: live streams have no duration', async () => {
  const json = JSON.stringify({ title: 'Live', webpage_url: 'https://www.youtube.com/watch?v=l', is_live: true, duration: 0 });
  const [m] = await resolveMedia('https://www.youtube.com/watch?v=l', audio, fakeRun(json));
  assert.equal(m!.live, true);
  assert.equal(m!.durationSec, undefined);
});

test('resolveMedia: Spotify links get a helpful explanation instead of a failed lookup', async () => {
  let called = false;
  const run: Runner = async () => {
    called = true;
    return { stdout: '', stderr: '', code: 0 };
  };
  await assert.rejects(resolveMedia('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC', audio, run), /Spotify.*Search for the song by name/);
  assert.equal(called, false, 'no point asking yt-dlp about a link it cannot play');
});

test('resolveMedia: SoundCloud sets and Bandcamp albums (playlist results) queue their tracks', async () => {
  const entries = [1, 2, 3].map((i) => ({ title: `Track ${i}`, url: `https://artist.bandcamp.com/track/t${i}`, duration: 100 + i }));
  const out = await resolveMedia('https://artist.bandcamp.com/album/some-album', audio, fakeRun(JSON.stringify({ _type: 'playlist', entries })));
  assert.deepEqual(out.map((m) => m.title), ['Track 1', 'Track 2', 'Track 3']);
});

test('resolveMedia: errors are turned into friendly SourceErrors', async () => {
  await assert.rejects(resolveMedia('http://localhost/x', audio, fakeRun('')), SourceError);
  await assert.rejects(resolveMedia('x'.repeat(300), audio, fakeRun('')), /too long/);
  await assert.rejects(
    resolveMedia('https://www.youtube.com/watch?v=x', audio, fakeRun('', "ERROR: [youtube] x: Sign in to confirm you're not a bot", 1)),
    /cookies/,
  );
  await assert.rejects(resolveMedia('https://x.test/a', audio, fakeRun('', 'ERROR: Unsupported URL: https://x.test/a', 1)), /how to play/);
  const enoent: Runner = async () => {
    throw Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' });
  };
  await assert.rejects(resolveMedia('hello', audio, enoent), /yt-dlp was not found/);
});

test('radio lookup by number, key, name, partial name and URL', () => {
  const st = listStations(audio);
  assert.ok(st.length >= 3);
  assert.equal(resolveRadio('1', audio)?.url, st[0]!.url);
  assert.equal(resolveRadio('groovesalad', audio)?.title, 'SomaFM Groove Salad');
  assert.equal(resolveRadio('SOMAFM DEF CON RADIO', audio)?.url, audio.radioStations.defcon!.url);
  assert.equal(resolveRadio('space', audio)?.title, 'SomaFM Space Station');
  assert.equal(resolveRadio('soma', audio), undefined, 'ambiguous partial match must not guess');
  assert.equal(resolveRadio('https://radio.example.com/live', audio)?.live, true);
  assert.equal(resolveRadio('http://192.168.0.5/stream', audio), undefined);
  assert.equal(resolveRadio('nonsense', audio), undefined);
  assert.equal(resolveRadio('999', audio), undefined);
});
