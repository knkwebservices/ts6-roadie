import type { Config } from '../../config.js';
import { runProcess, type Runner } from './proc.js';
import { fetchSpotifyTrack, isSpotifyUrl, SpotifyError } from './spotify.js';

export interface MediaInfo {
  /** Set when the item's kind differs from the request's default (e.g. a playlist mixing tracks and radio). */
  kind?: 'media' | 'radio';
  title: string;
  url: string;
  durationSec?: number;
  live?: boolean;
  /** Who uploaded it (a channel name), when the site says. Shown in search results. */
  by?: string;
}

/** An error whose message is safe and useful to show to chat users. */
export class SourceError extends Error {}

/**
 * Only fetch public http(s) URLs. Chat users control the input, and the bot runs on a
 * server with access to internal services, so refuse localhost / private / link-local
 * targets. This is a best-effort filter (it does not defend against DNS tricks).
 */
export function isPublicHttpUrl(input: string): boolean {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;

  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
  }
  if (host.includes(':')) {
    if (host === '::' || host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('::ffff:')) return false;
  }
  return true;
}

function lastError(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const err = [...lines].reverse().find((l) => /^ERROR:/i.test(l)) ?? lines[lines.length - 1] ?? '';
  return err.replace(/^ERROR:\s*(\[[^\]]+\]\s*)?/i, '').slice(0, 220);
}

function friendlyYtdlpError(stderr: string): string {
  const raw = lastError(stderr);
  if (/sign in to confirm|not a bot|cookies/i.test(stderr)) {
    return 'YouTube is asking the server to prove it is not a bot. The bot admin may need to give yt-dlp a cookies file.';
  }
  if (/unsupported url/i.test(raw)) return "I don't know how to play that link.";
  if (/private video|video unavailable|has been removed|not available/i.test(raw)) return `That video is not available (${raw}).`;
  return raw ? `yt-dlp could not open that (${raw})` : 'yt-dlp could not open that.';
}

interface YtEntry {
  uploader?: string;
  channel?: string;
  title?: string;
  url?: string;
  webpage_url?: string;
  id?: string;
  duration?: number;
  is_live?: boolean;
  live_status?: string;
  ie_key?: string;
  extractor_key?: string;
}

/** Ask yt-dlp about a link or a "ytsearchN:words" target and turn what it says into playable items. */
async function ytdlpItems(target: string, cfg: Config['audio'], run: Runner, playlistEnd: string): Promise<MediaInfo[]> {
  let res;
  try {
    res = await run(
      cfg.ytdlpPath,
      ['--dump-single-json', '--flat-playlist', '--no-playlist', '--no-warnings', '--socket-timeout', '15', '--playlist-end', playlistEnd, ...cfg.ytdlpExtraArgs, '--', target],
      { timeoutMs: 45_000 },
    );
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SourceError(`yt-dlp was not found (looked for "${cfg.ytdlpPath}"). Ask the bot admin to install it.`);
    }
    throw new SourceError((e as Error).message);
  }

  let data: (YtEntry & { _type?: string; entries?: YtEntry[] }) | undefined;
  try {
    data = JSON.parse(res.stdout);
  } catch {
    throw new SourceError(friendlyYtdlpError(res.stderr) || 'Nothing came back for that.');
  }
  if (!data) throw new SourceError('Nothing came back for that.');

  const entries: YtEntry[] = data._type === 'playlist' ? (data.entries ?? []) : [data];
  const out: MediaInfo[] = [];
  for (const e of entries) {
    if (!e) continue;
    let url = e.webpage_url ?? e.url;
    if (!url && e.id && /youtube/i.test(e.ie_key ?? e.extractor_key ?? '')) url = `https://www.youtube.com/watch?v=${e.id}`;
    if (!url || !isPublicHttpUrl(url)) continue;
    const live = e.is_live === true || e.live_status === 'is_live';
    const by = (e.channel ?? e.uploader ?? '').replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, 60);
    out.push({
      title: (e.title ?? url).slice(0, 150),
      url,
      durationSec: !live && typeof e.duration === 'number' ? e.duration : undefined,
      live,
      ...(by ? { by } : {}),
    });
  }
  return out;
}

/**
 * Turn a URL or search text into playable items via yt-dlp. Single videos give one item,
 * playlist URLs give up to `maxPlaylistItems`. Search text picks the top YouTube result.
 * Metadata only - the audio itself is fetched when the track actually plays.
 */
export async function resolveMedia(input: string, cfg: Config['audio'], run: Runner = runProcess, fetchImpl: typeof fetch = fetch): Promise<MediaInfo[]> {
  const q = input.trim();
  let target: string;
  /** Set for Spotify song links: what to call the track once YouTube has supplied the audio. */
  let spotifyTitle: string | undefined;
  if (/^https?:\/\//i.test(q)) {
    if (!isPublicHttpUrl(q)) throw new SourceError("I can't fetch from that address.");
    if (isSpotifyUrl(q)) {
      // Spotify's audio is protected: read the song and artist from the link, then find it on YouTube.
      try {
        const t = await fetchSpotifyTrack(q, fetchImpl);
        spotifyTitle = `${t.artist} - ${t.title}`.slice(0, 150);
      } catch (e) {
        throw e instanceof SpotifyError ? new SourceError(e.message) : e;
      }
      target = `ytsearch1:${spotifyTitle}`;
    } else {
      target = q;
    }
  } else {
    if (q.length > 200 || /[\r\n]/.test(q)) throw new SourceError('That search is too long.');
    target = `ytsearch1:${q}`;
  }

  const out = await ytdlpItems(target, cfg, run, String(cfg.maxPlaylistItems));
  if (!out.length) throw new SourceError('I could not find anything playable for that.');
  // Show the Spotify song's own name rather than whatever the YouTube upload happens to be called.
  if (spotifyTitle) return [{ ...out[0]!, title: spotifyTitle }];
  return out.slice(0, cfg.maxPlaylistItems);
}

/**
 * Look up several YouTube results for some words, so a person can choose one.
 * Metadata only, like resolveMedia. Links are not searches: use resolveMedia for those.
 */
export async function searchMedia(query: string, cfg: Config['audio'], count = 5, run: Runner = runProcess): Promise<MediaInfo[]> {
  const q = query.trim();
  if (!q) throw new SourceError('Tell me what to search for.');
  if (/^https?:\/\//i.test(q)) throw new SourceError('That is a link: use the play command for links, and search for words.');
  if (q.length > 200 || /[\r\n]/.test(q)) throw new SourceError('That search is too long.');
  const n = Math.max(1, Math.min(10, Math.floor(count)));
  const out = await ytdlpItems(`ytsearch${n}:${q}`, cfg, run, String(n));
  if (!out.length) throw new SourceError('I could not find anything for that.');
  return out.slice(0, n);
}

/** The first video ever uploaded to YouTube: short, stable, and never going away. */
export const HEALTH_CHECK_URL = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';

export interface HealthResult {
  ok: boolean;
  /** What was found, or why it failed, in words safe to show. */
  message: string;
  ms: number;
}

/** Can yt-dlp still get information about a YouTube video? (Most breakages, like new blocks or a stale yt-dlp, show up here.) */
export async function checkYoutube(cfg: Config['audio'], run: Runner = runProcess): Promise<HealthResult> {
  const t0 = Date.now();
  try {
    const [hit] = await resolveMedia(HEALTH_CHECK_URL, { ...cfg, maxPlaylistItems: 1 }, run);
    return { ok: true, message: `YouTube works (found "${hit!.title}")`, ms: Date.now() - t0 };
  } catch (e) {
    const message = e instanceof SourceError ? e.message : `Could not run the check (${(e as Error).message})`;
    const hint = /not a bot|cookies/i.test(message)
      ? ' Fix: give yt-dlp a cookies file with audio.ytdlpExtraArgs.'
      : /javascript runtime/i.test(message)
        ? ' Fix: add "--js-runtimes", "node" to audio.ytdlpExtraArgs.'
        : ' Updating yt-dlp often fixes this.';
    return { ok: false, message: message + hint, ms: Date.now() - t0 };
  }
}

export interface UpdateResult {
  ok: boolean;
  /** The last lines yt-dlp printed. */
  output: string;
}

/** Run yt-dlp's own updater. Works for the standalone yt-dlp; a pip or package-manager install will say to update that way. */
export async function updateYtdlp(cfg: Config['audio'], run: Runner = runProcess): Promise<UpdateResult> {
  try {
    const r = await run(cfg.ytdlpPath, ['-U'], { timeoutMs: 180_000 });
    const text = `${r.stdout}\n${r.stderr}`
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(-6)
      .join('\n')
      .slice(-600);
    return { ok: r.code === 0, output: text || (r.code === 0 ? 'Done.' : 'yt-dlp printed nothing.') };
  } catch (e) {
    return { ok: false, output: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `yt-dlp was not found (looked for "${cfg.ytdlpPath}").` : (e as Error).message };
  }
}

// ---- radio ------------------------------------------------------------------------------

export interface Station {
  key: string;
  name: string;
  url: string;
}

export function listStations(cfg: Config['audio']): Station[] {
  return Object.entries(cfg.radioStations).map(([key, s]) => ({ key, name: s.name, url: s.url }));
}

/** Match by number, key, name, unique partial name, or accept a direct stream URL. */
export function resolveRadio(arg: string, cfg: Config['audio']): MediaInfo | undefined {
  const a = arg.trim();
  if (!a) return undefined;
  if (/^https?:\/\//i.test(a)) {
    return isPublicHttpUrl(a) ? { title: `Radio stream (${new URL(a).hostname})`, url: a, live: true } : undefined;
  }
  const stations = listStations(cfg);
  let hit: Station | undefined;
  if (/^\d+$/.test(a)) hit = stations[Number(a) - 1];
  const lower = a.toLowerCase();
  hit ??= stations.find((s) => s.key.toLowerCase() === lower || s.name.toLowerCase() === lower);
  if (!hit) {
    const partial = stations.filter((s) => s.key.toLowerCase().includes(lower) || s.name.toLowerCase().includes(lower));
    if (partial.length === 1) hit = partial[0];
  }
  return hit ? { title: hit.name, url: hit.url, live: true } : undefined;
}

// ---- tool versions (for !status) ------------------------------------------------------

export async function toolVersion(cmd: string, args: string[], run: Runner = runProcess): Promise<string> {
  try {
    const r = await run(cmd, args, { timeoutMs: 5_000 });
    const first = (r.stdout || r.stderr).split(/\r?\n/)[0]?.trim() ?? '';
    if (!first) return 'unknown';
    const m = /version\s+(\S+)/i.exec(first);
    return m?.[1] ?? first.slice(0, 40);
  } catch {
    return 'not found';
  }
}
