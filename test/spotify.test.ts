import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildConfig } from '../src/config.js';
import type { Runner } from '../src/cogs/audio/proc.js';
import { resolveMedia, SourceError } from '../src/cogs/audio/sources.js';
import { fetchSpotifyTrack, isSpotifyUrl, parseOgTags, SpotifyError, spotifyKind, trackFromTags } from '../src/cogs/audio/spotify.js';

const audio = buildConfig({}).audio;
const TRACK = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc123';

/** The two tags exactly as a live Spotify song page returned them (captured on the bot's own server). */
const REAL_TAGS =
  '<meta property="og:title" content="Never Gonna Give You Up"/>' +
  '<meta property="og:description" content="Rick Astley · Whenever You Need Somebody · Song · 1987"/>';
const page = (tags = REAL_TAGS) => `<!doctype html><html><head><title>x</title>${tags}</head><body>${'<div>filler</div>'.repeat(50)}</body></html>`;

/** A fake fetch that serves scripted responses and records every URL it was asked for. */
function fakeFetch(responses: Record<string, () => Response>) {
  const asked: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    const make = responses[url] ?? responses['*'];
    if (!make) throw new Error(`unexpected fetch of ${url}`);
    return make();
  }) as typeof fetch;
  return { impl, asked };
}
const html = (body: string, status = 200) => () => new Response(body, { status, headers: { 'content-type': 'text/html' } });
const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });

test('parseOgTags reads the real page tags, whatever the attribute order or quoting', () => {
  const t = parseOgTags(page());
  assert.equal(t['og:title'], 'Never Gonna Give You Up');
  assert.equal(t['og:description'], 'Rick Astley · Whenever You Need Somebody · Song · 1987');

  const odd = parseOgTags(`<meta content='A &amp; B &quot;live&quot; &#39;90s &#x27;x&#x27;' property='og:title'><meta name="description" content="plain"><meta charset="utf-8">`);
  assert.equal(odd['og:title'], 'A & B "live" \'90s \'x\'');
  assert.equal(odd['description'], 'plain');
  assert.equal(Object.keys(odd).length, 2, 'meta tags without content are ignored');
});

test('trackFromTags: artist is the first part of the description; missing pieces give nothing', () => {
  assert.deepEqual(trackFromTags(parseOgTags(REAL_TAGS)), { title: 'Never Gonna Give You Up', artist: 'Rick Astley' });
  assert.deepEqual(trackFromTags({ 'og:title': 'Song', 'og:description': 'Artist One, Artist Two · Album · Song · 2020' }), { title: 'Song', artist: 'Artist One, Artist Two' });
  assert.equal(trackFromTags({ 'og:title': 'Song' }), undefined);
  assert.equal(trackFromTags({ 'og:description': 'Artist · Song' }), undefined);
});

test('spotifyKind and isSpotifyUrl', () => {
  assert.equal(spotifyKind('https://open.spotify.com/track/abc'), 'track');
  assert.equal(spotifyKind('https://open.spotify.com/intl-de/track/abc?si=x'), 'track');
  assert.equal(spotifyKind('https://open.spotify.com/embed/track/abc'), 'track');
  assert.equal(spotifyKind('https://open.spotify.com/album/abc'), 'album');
  assert.equal(spotifyKind('https://open.spotify.com/playlist/abc'), 'playlist');
  assert.equal(spotifyKind('https://open.spotify.com/artist/abc'), 'artist');
  assert.equal(spotifyKind('https://open.spotify.com/show/abc'), 'show');
  assert.equal(spotifyKind('https://open.spotify.com/episode/abc'), 'episode');
  assert.equal(spotifyKind('https://spotify.link/AbC123'), 'other');
  for (const yes of ['https://open.spotify.com/track/x', 'https://spotify.link/x', 'https://play.spotify.com/x']) assert.equal(isSpotifyUrl(yes), true, yes);
  for (const no of ['https://youtube.com/watch?v=x', 'https://notspotify.com/track/x', 'https://spotify.com.evil.example/track/x', 'nonsense']) assert.equal(isSpotifyUrl(no), false, no);
});

test('a song link is looked up on its own page and gives title + artist', async () => {
  const f = fakeFetch({ '*': html(page()) });
  assert.deepEqual(await fetchSpotifyTrack(TRACK, f.impl), { title: 'Never Gonna Give You Up', artist: 'Rick Astley' });
  assert.deepEqual(f.asked, [TRACK], 'exactly one request, to the page that was pasted');
});

test('albums, playlists, artists and podcasts get a clear explanation WITHOUT any request being made', async () => {
  for (const [path, words] of [['album/x', /albums can't be played/], ['playlist/x', /playlists can't be played/], ['artist/x', /artist page/], ['show/x', /podcast/], ['episode/x', /podcast episode/]] as const) {
    const f = fakeFetch({});
    await assert.rejects(fetchSpotifyTrack(`https://open.spotify.com/${path}`, f.impl), (e: Error) => e instanceof SpotifyError && words.test(e.message), path);
    assert.deepEqual(f.asked, [], `${path}: nothing should be fetched`);
  }
});

test('SAFETY: only Spotify hosts are ever contacted, including via redirects', async () => {
  for (const bad of ['https://evil.example/track/x', 'http://open.spotify.com/track/x', 'https://play.spotify.com/track/x', 'https://127.0.0.1/track/x', 'https://spotify.com.evil.example/track/x']) {
    const f = fakeFetch({});
    await assert.rejects(fetchSpotifyTrack(bad, f.impl), SpotifyError, bad);
    assert.deepEqual(f.asked, [], `${bad}: must not be fetched`);
  }
  // a spotify.link short link that tries to send us somewhere else
  const f = fakeFetch({ 'https://spotify.link/x': redirect('http://169.254.169.254/latest/meta-data/') });
  await assert.rejects(fetchSpotifyTrack('https://spotify.link/x', f.impl), /only follow open\.spotify\.com/);
  assert.deepEqual(f.asked, ['https://spotify.link/x'], 'the redirect target must not be requested');
});

test('short links: follows a redirect to the song page; reveals an album; gives up on loops', async () => {
  const ok = fakeFetch({ 'https://spotify.link/x': redirect('https://open.spotify.com/track/abc'), 'https://open.spotify.com/track/abc': html(page()) });
  assert.equal((await fetchSpotifyTrack('https://spotify.link/x', ok.impl)).artist, 'Rick Astley');

  const album = fakeFetch({ 'https://spotify.link/y': redirect('https://open.spotify.com/album/abc') });
  await assert.rejects(fetchSpotifyTrack('https://spotify.link/y', album.impl), /albums can't be played/);

  const loop = fakeFetch({ '*': redirect('https://spotify.link/again') });
  await assert.rejects(fetchSpotifyTrack('https://spotify.link/again', loop.impl), /too many times/);
});

test('failures are explained: server errors, no tags, no network', async () => {
  await assert.rejects(fetchSpotifyTrack(TRACK, fakeFetch({ '*': html('nope', 404) }).impl), /error 404/);
  await assert.rejects(fetchSpotifyTrack(TRACK, fakeFetch({ '*': html(page('<meta property="og:image" content="x"/>')) }).impl), /didn't give me the song's details/);
  const dead = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  await assert.rejects(fetchSpotifyTrack(TRACK, dead), /couldn't reach Spotify/);
});

test('end to end: a Spotify link becomes a YouTube search for "Artist - Title", named after the Spotify song', async () => {
  const f = fakeFetch({ '*': html(page()) });
  let args: string[] = [];
  const run: Runner = async (_cmd, a) => {
    args = a;
    return {
      stdout: JSON.stringify({ _type: 'playlist', entries: [{ title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', duration: 213 }] }),
      stderr: '',
      code: 0,
    };
  };
  const out = await resolveMedia(TRACK, audio, run, f.impl);
  assert.equal(args.at(-1), 'ytsearch1:Rick Astley - Never Gonna Give You Up', 'searches YouTube by artist and title, after "--"');
  assert.equal(args.at(-2), '--');
  assert.deepEqual(out, [{ title: 'Rick Astley - Never Gonna Give You Up', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', durationSec: 213, live: false }]);
});

test('end to end: a Spotify album never reaches yt-dlp, and its explanation is a SourceError for chat', async () => {
  let called = false;
  const run: Runner = async () => {
    called = true;
    return { stdout: '', stderr: '', code: 0 };
  };
  await assert.rejects(resolveMedia('https://open.spotify.com/album/abc', audio, run, fakeFetch({}).impl), (e: Error) => e instanceof SourceError && /albums can't be played/.test(e.message));
  assert.equal(called, false);
});
