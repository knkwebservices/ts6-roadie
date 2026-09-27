/**
 * Steam's player-summaries lookup, read-only. One API key from https://steamcommunity.com/dev/apikey
 * (free, no app review) plus each tracked person's SteamID64 is all this needs.
 */

const ENDPOINT = 'https://api.steampowered.com/ISteamUser/GetPlayerSummaries/v0002/';
/** The API accepts up to 100 IDs per call. */
const BATCH_SIZE = 100;
const FETCH_TIMEOUT_MS = 8_000;

export class SteamError extends Error {}

/** A SteamID64: a 17-digit number. (Steam's own account range starts at 76561197960265728.) */
export function isSteamId64(s: string): boolean {
  return /^\d{17}$/.test(s.trim());
}

export interface SteamPlayer {
  steamId: string;
  name: string;
  /** 0 offline, 1 online, 2 busy, 3 away, 4 snooze, 5 looking to trade, 6 looking to play. */
  state: number;
  /** The game's name, only present while playing one. */
  game?: string;
  /** The game's Steam app ID, only present while playing one (some free/unlisted games have no app ID even so). */
  appId?: string;
}

interface RawPlayer {
  steamid?: unknown;
  personaname?: unknown;
  personastate?: unknown;
  gameextrainfo?: unknown;
  gameid?: unknown;
}

function parsePlayer(p: RawPlayer): SteamPlayer | undefined {
  if (typeof p.steamid !== 'string') return undefined;
  return {
    steamId: p.steamid,
    name: typeof p.personaname === 'string' && p.personaname ? p.personaname : p.steamid,
    state: typeof p.personastate === 'number' ? p.personastate : 0,
    game: typeof p.gameextrainfo === 'string' ? p.gameextrainfo : undefined,
    appId: typeof p.gameid === 'string' ? p.gameid : undefined,
  };
}

/**
 * Look up the current game/online status of a batch of SteamID64s. Throws SteamError with a
 * message that is safe to show to chat users (the key is never included in it).
 */
export async function fetchPlayerSummaries(apiKey: string, steamIds: string[], fetchImpl: typeof fetch = fetch): Promise<SteamPlayer[]> {
  if (!apiKey.trim()) throw new SteamError('No Steam API key is set (steam.apiKey in config.json).');
  const ids = [...new Set(steamIds.map((s) => s.trim()).filter(Boolean))];
  if (ids.length === 0) return [];

  const out: SteamPlayer[] = [];
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const url = `${ENDPOINT}?key=${encodeURIComponent(apiKey)}&steamids=${batch.map(encodeURIComponent).join(',')}&format=json`;
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch (e) {
      throw new SteamError(`Could not reach the Steam API: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (res.status === 403) throw new SteamError('Steam rejected the API key (steam.apiKey). Get a fresh one at https://steamcommunity.com/dev/apikey.');
    if (!res.ok) throw new SteamError(`Steam's API returned an error (${res.status}).`);
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new SteamError("Steam's API sent something that wasn't valid JSON.");
    }
    const players = (body as { response?: { players?: unknown } })?.response?.players;
    if (!Array.isArray(players)) throw new SteamError("Steam's API response didn't look like a player list.");
    for (const p of players) {
      const parsed = parsePlayer(p as RawPlayer);
      if (parsed) out.push(parsed);
    }
  }
  return out;
}
