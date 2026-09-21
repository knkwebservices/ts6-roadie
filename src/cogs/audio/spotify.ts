/**
 * Spotify links, without an account or API keys.
 *
 * Spotify's audio is protected and the official developer API has become hard to use for a bot
 * (Premium-only app owners, tight limits, endpoints being withdrawn). So this does the modest thing:
 * a Spotify song page carries its title and artist in its public link-preview tags, the same ones a
 * chat app reads to show a preview. We read those two facts and hand "Artist - Title" to a YouTube
 * search. The audio always comes from YouTube; nothing is fetched from Spotify but that one page.
 *
 * Real example (from a live page):
 *   <meta property="og:title" content="Never Gonna Give You Up"/>
 *   <meta property="og:description" content="Rick Astley · Whenever You Need Somebody · Song · 1987"/>
 */

/** A message that is safe and useful to show to chat users. */
export class SpotifyError extends Error {}

/** The only hosts we will ever contact. This keeps a pasted link from pointing the bot anywhere else. */
const ALLOWED_HOSTS = new Set(['open.spotify.com', 'spotify.link']);
const MAX_REDIRECTS = 4;
const MAX_PAGE_BYTES = 600_000;
const FETCH_TIMEOUT_MS = 8_000;
const USER_AGENT = 'Mozilla/5.0 (compatible; TS6Roadie; +https://github.com/knkwebservices/ts6-roadie)';

export type SpotifyKind = 'track' | 'album' | 'playlist' | 'artist' | 'show' | 'episode' | 'other';

export function isSpotifyUrl(input: string): boolean {
  try {
    const h = new URL(input).hostname.toLowerCase();
    return h === 'spotify.com' || h.endsWith('.spotify.com') || h === 'spotify.link';
  } catch {
    return false;
  }
}

/** What a Spotify link points at. Handles locale prefixes such as /intl-de/track/... and /embed/track/... */
export function spotifyKind(url: string): SpotifyKind {
  let path: string[];
  try {
    path = new URL(url).pathname.toLowerCase().split('/').filter(Boolean);
  } catch {
    return 'other';
  }
  for (const seg of path) {
    if (seg === 'track' || seg === 'album' || seg === 'playlist' || seg === 'artist' || seg === 'show' || seg === 'episode') return seg;
  }
  return 'other';
}

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h: string) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, d: string) => safeCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // last, so "&amp;quot;" stays "&quot;"
}

function safeCodePoint(n: number): string {
  return Number.isInteger(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

/** Collect <meta property="..." content="..."> pairs. Attribute order and quote style do not matter. */
export function parseOgTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<meta\s[^>]*>/gi) ?? []) {
    const attrs: Record<string, string> = {};
    for (const m of tag.matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1]!.toLowerCase()] = m[2] ?? m[3] ?? '';
    const key = attrs['property'] ?? attrs['name'];
    if (key && attrs['content'] !== undefined && !(key in out)) out[key] = decodeEntities(attrs['content']);
  }
  return out;
}

export interface SpotifyTrack {
  title: string;
  artist: string;
}

/**
 * "Song (Feat. X)" reads as a repeat when X is already credited as an artist ("A, X - Song (Feat. X)").
 * Drop that bracketed ending, but only when every featured name really is in the artist list, so a
 * genuine part of a title (or a feature that is NOT credited) is never lost.
 */
export function tidyTrack(t: SpotifyTrack): SpotifyTrack {
  const m = /^(.*?)\s*[(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^)\]]+?)\s*[)\]]\s*$/i.exec(t.title);
  if (!m || !m[1]?.trim()) return t;
  const credited = t.artist.toLowerCase();
  const featured = m[2]!.split(/\s*(?:,|&|\band\b)\s*/i).map((n) => n.trim().toLowerCase()).filter(Boolean);
  return featured.length && featured.every((n) => credited.includes(n)) ? { ...t, title: m[1].trim() } : t;
}

/** Title from og:title; artist is the first "·"-separated part of og:description ("Artist · Album · Song · Year"). */
export function trackFromTags(tags: Record<string, string>): SpotifyTrack | undefined {
  const title = tags['og:title']?.trim();
  const artist = tags['og:description']?.split('·')[0]?.trim();
  return title && artist ? tidyTrack({ title, artist }) : undefined;
}

async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, max);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    text += decoder.decode(value, { stream: true });
    // the tags we want are in <head>, well before the page's bulk
    if (bytes >= max || /<\/head>/i.test(text)) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return text;
}

const NOT_A_SONG: Record<string, string> = {
  album: "Spotify albums can't be played from a link (Spotify doesn't share their track lists). Paste a link to a single song, or search by name.",
  playlist: "Spotify playlists can't be played from a link (Spotify doesn't share their track lists). Paste a link to a single song, or search by name.",
  artist: "That's a Spotify artist page. Paste a link to a single song, or search by name.",
  show: "That's a Spotify podcast. I can only play songs from Spotify links. Search for it by name instead.",
  episode: "That's a Spotify podcast episode. I can only play songs from Spotify links. Search for it by name instead.",
};

/**
 * Look up a Spotify song link. Follows a few redirects (spotify.link short links) but only ever between
 * the allowed Spotify hosts. Throws SpotifyError with a message that is fine to show in chat.
 */
export async function fetchSpotifyTrack(url: string, fetchImpl: typeof fetch = fetch): Promise<SpotifyTrack> {
  const kind = spotifyKind(url);
  if (kind in NOT_A_SONG) throw new SpotifyError(NOT_A_SONG[kind]!);

  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    let u: URL;
    try {
      u = new URL(current);
    } catch {
      throw new SpotifyError("I couldn't read that Spotify link.");
    }
    if (u.protocol !== 'https:' || !ALLOWED_HOSTS.has(u.hostname.toLowerCase())) {
      throw new SpotifyError("I only follow open.spotify.com song links. Paste one of those, or search by name.");
    }

    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: 'manual',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en' },
      });
    } catch {
      throw new SpotifyError("I couldn't reach Spotify to look that song up. Try again, or search by name.");
    }

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) throw new SpotifyError("Spotify sent me somewhere I couldn't follow. Search by name instead.");
      current = new URL(loc, current).toString();
      // a redirect may reveal what the link really is (e.g. a short link to an album)
      const revealed = spotifyKind(current);
      if (revealed in NOT_A_SONG) throw new SpotifyError(NOT_A_SONG[revealed]!);
      continue;
    }
    if (!res.ok) throw new SpotifyError(`Spotify didn't give me that song (error ${res.status}). Search by name instead.`);

    const track = trackFromTags(parseOgTags(await readLimited(res, MAX_PAGE_BYTES)));
    if (!track) throw new SpotifyError("Spotify didn't give me the song's details. Search by name instead.");
    return track;
  }
  throw new SpotifyError('That Spotify link redirected too many times.');
}
