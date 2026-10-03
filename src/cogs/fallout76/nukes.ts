/** Fallout 76 nuke codes, as decoded each week by NukaCrypt (https://nukacrypt.com). */
export const NUKACRYPT_URL = 'https://api.nukacrypt.com/api/codes';
const FETCH_TIMEOUT_MS = 8_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;

export class NukesError extends Error {}

export interface NukeCodes {
  alpha: string;
  bravo: string;
  charlie: string;
  /** When these codes started, ms since 1970. */
  from: number;
  /** When the game changes them (one week after `from`), ms since 1970. */
  until: number;
}

const isCode = (v: unknown): v is string => typeof v === 'string' && /^\d{8}$/.test(v.trim());

/** NukaCrypt's dates look like "2026-10-02 00:00:00Z". */
function parseDate(v: unknown): number {
  if (typeof v !== 'string') return NaN;
  return Date.parse(v.trim().replace(' ', 'T'));
}

/** Turn NukaCrypt's reply into codes, or explain what was wrong with it. */
export function parseCodes(data: unknown): NukeCodes {
  if (typeof data !== 'object' || data === null) throw new NukesError("NukaCrypt's reply didn't look like nuke codes.");
  const d = data as Record<string, unknown>;
  if (!isCode(d.ALPHA) || !isCode(d.BRAVO) || !isCode(d.CHARLIE)) throw new NukesError("NukaCrypt's reply didn't include all three codes.");
  let from = parseDate(d.date);
  if (!Number.isFinite(from) && typeof d.since_epoch === 'number') from = d.since_epoch * 1000;
  if (!Number.isFinite(from)) throw new NukesError("NukaCrypt's reply didn't say which week the codes are for.");
  return { alpha: d.ALPHA.trim(), bravo: d.BRAVO.trim(), charlie: d.CHARLIE.trim(), from, until: from + WEEK_MS };
}

export async function fetchNukeCodes(fetchImpl: typeof fetch = fetch): Promise<NukeCodes> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(NUKACRYPT_URL, { signal: ac.signal, // no Accept header: NukaCrypt answers 406 Not Acceptable to "Accept: application/json"
    headers: { 'User-Agent': 'TS6-Roadie (https://github.com/knkwebservices/ts6-roadie)' } });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new NukesError('NukaCrypt did not answer in time.');
    throw new NukesError(`Could not reach NukaCrypt (${e instanceof Error ? e.message : String(e)}).`);
  } finally {
    clearTimeout(t);
  }
  if (!res.ok) throw new NukesError(`NukaCrypt would not give the codes (HTTP ${res.status}).`);
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new NukesError("NukaCrypt's reply didn't look like JSON.");
  }
  return parseCodes(data);
}
