const TOKEN_ENDPOINT = 'https://id.twitch.tv/oauth2/token';
const STREAMS_ENDPOINT = 'https://api.twitch.tv/helix/streams';
const BATCH_SIZE = 100;
const FETCH_TIMEOUT_MS = 8_000;
/** Ask for a new app token this long before the old one actually expires, so a poll never starts with a stale one. */
const TOKEN_SAFETY_MS = 60_000;

export class TwitchError extends Error {}
/** The app token was rejected (expired, revoked, or wrong credentials): the caller should get a new one and retry once. */
export class TwitchAuthError extends TwitchError {}

/** A Twitch login (the part of the URL after twitch.tv/, not the display name): 4-25 letters, digits or underscores. */
export function isTwitchLogin(s: string): boolean {
  return /^[a-zA-Z0-9_]{4,25}$/.test(s.trim());
}

export interface AppToken {
  token: string;
  /** ms since 1970. */
  expiresAt: number;
}

export interface TwitchStream {
  login: string;
  /** Display name, as Twitch has it capitalized/accented. */
  name: string;
  game?: string;
  title?: string;
  viewerCount?: number;
  /** ms since 1970. */
  startedAt: number;
}

async function withTimeout(fetchImpl: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetchImpl(url, { ...init, signal: ac.signal });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new TwitchError('Twitch did not answer in time. Try again in a moment.');
    throw e;
  } finally {
    clearTimeout(t);
  }
}

/** Client-credentials app token: proves who the bot is, not any particular streamer's account. */
export async function fetchAppToken(clientId: string, clientSecret: string, fetchImpl: typeof fetch = fetch): Promise<AppToken> {
  if (!clientId.trim() || !clientSecret.trim()) throw new TwitchError('No Twitch client ID/secret is set (twitch.clientId / twitch.clientSecret in config.json).');
  const body = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' });
  const res = await withTimeout(fetchImpl, TOKEN_ENDPOINT, { method: 'POST', body });
  if (res.status === 403 || res.status === 401) throw new TwitchAuthError('Twitch rejected the client ID/secret (twitch.clientId / twitch.clientSecret). Check them at https://dev.twitch.tv/console/apps.');
  if (!res.ok) throw new TwitchError(`Twitch would not issue a token (HTTP ${res.status}).`);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new TwitchError("Twitch's token reply didn't look like JSON.");
  }
  const d = data as { access_token?: unknown; expires_in?: unknown };
  if (typeof d.access_token !== 'string' || !d.access_token) throw new TwitchError("Twitch's token reply didn't include a token.");
  const ttlMs = (typeof d.expires_in === 'number' ? d.expires_in : 3600) * 1000;
  return { token: d.access_token, expiresAt: Date.now() + Math.max(0, ttlMs - TOKEN_SAFETY_MS) };
}

interface RawStream {
  user_login?: unknown;
  user_name?: unknown;
  game_name?: unknown;
  title?: unknown;
  viewer_count?: unknown;
  started_at?: unknown;
}

function parseStream(s: RawStream): TwitchStream | undefined {
  if (typeof s.user_login !== 'string' || !s.user_login) return undefined;
  const startedAt = typeof s.started_at === 'string' ? Date.parse(s.started_at) : NaN;
  return {
    login: s.user_login,
    name: typeof s.user_name === 'string' && s.user_name ? s.user_name : s.user_login,
    game: typeof s.game_name === 'string' && s.game_name ? s.game_name : undefined,
    title: typeof s.title === 'string' && s.title.trim() ? s.title.trim() : undefined,
    viewerCount: typeof s.viewer_count === 'number' ? s.viewer_count : undefined,
    startedAt: Number.isFinite(startedAt) ? startedAt : Date.now(),
  };
}

/** Only currently-live channels come back; anyone offline is simply absent from the result. */
export async function fetchLiveStreams(clientId: string, appToken: string, logins: string[], fetchImpl: typeof fetch = fetch): Promise<TwitchStream[]> {
  const names = [...new Set(logins.map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (names.length === 0) return [];
  const out: TwitchStream[] = [];
  for (let i = 0; i < names.length; i += BATCH_SIZE) {
    const batch = names.slice(i, i + BATCH_SIZE);
    const qs = batch.map((n) => `user_login=${encodeURIComponent(n)}`).join('&');
    const res = await withTimeout(fetchImpl, `${STREAMS_ENDPOINT}?first=100&${qs}`, {
      headers: { 'Client-Id': clientId, Authorization: `Bearer ${appToken}` },
    });
    if (res.status === 401) throw new TwitchAuthError('Twitch says the app token has expired or was revoked.');
    if (!res.ok) throw new TwitchError(`Twitch would not list streams (HTTP ${res.status}).`);
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new TwitchError("Twitch's stream reply didn't look like JSON.");
    }
    const list = (data as { data?: unknown }).data;
    if (!Array.isArray(list)) throw new TwitchError("Twitch's stream reply didn't look like a stream list.");
    for (const raw of list as RawStream[]) {
      const s = parseStream(raw);
      if (s) out.push(s);
    }
  }
  return out;
}
