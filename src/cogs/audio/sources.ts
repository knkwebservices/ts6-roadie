import type { Config } from '../../config.js';
import { runProcess, type Runner } from './proc.js';

export interface MediaInfo {
  /** Set when the item's kind differs from the request's default (e.g. a playlist mixing tracks and radio). */
  kind?: 'media' | 'radio';
  title: string;
  url: string;
  durationSec?: number;
  live?: boolean;
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

/**
 * Turn a URL or search text into playable items via yt-dlp. Single videos give one item,
 * playlist URLs give up to `maxPlaylistItems`. Search text picks the top YouTube result.
 * Metadata only - the audio itself is fetched when the track actually plays.
 */
export async function resolveMedia(input: string, cfg: Config['audio'], run: Runner = runProcess): Promise<MediaInfo[]> {
  const q = input.trim();
  let target: string;
  if (/^https?:\/\//i.test(q)) {
    if (!isPublicHttpUrl(q)) throw new SourceError("I can't fetch from that address.");
    if (/(^|\.)spotify\.com$/i.test(new URL(q).hostname)) {
      throw new SourceError("Spotify links can't be played (Spotify's audio is protected). Search for the song by name instead, e.g. !play artist - title");
    }
    target = q;
  } else {
    if (q.length > 200 || /[\r\n]/.test(q)) throw new SourceError('That search is too long.');
    target = `ytsearch1:${q}`;
  }

  let res;
  try {
    res = await run(
      cfg.ytdlpPath,
      [
        '--dump-single-json',
        '--flat-playlist',
        '--no-playlist',
        '--no-warnings',
        '--socket-timeout',
        '15',
        '--playlist-end',
        String(cfg.maxPlaylistItems),
        ...cfg.ytdlpExtraArgs,
        '--',
        target,
      ],
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
    out.push({
      title: (e.title ?? url).slice(0, 150),
      url,
      durationSec: !live && typeof e.duration === 'number' ? e.duration : undefined,
      live,
    });
  }
  if (!out.length) throw new SourceError('I could not find anything playable for that.');
  return out.slice(0, cfg.maxPlaylistItems);
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
