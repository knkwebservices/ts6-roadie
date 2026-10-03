/**
 * VPN and proxy lookups through proxycheck.io (free: about 100 checks a day without a key, 1,000 with a
 * free account key). Answers are cached, so each address is asked about at most once a day.
 */

const FETCH_TIMEOUT_MS = 8_000;

export class LookupError extends Error {}

export interface IpVerdict {
  /** A VPN, proxy, Tor exit or hosting/data-centre address. */
  flagged: boolean;
  /** What it is, as proxycheck.io calls it ("VPN", "Residential", "Hosting"...). */
  type?: string;
  provider?: string;
}

/** Addresses on the same home or company network (and loopback) are never looked up. */
export function isPrivateIp(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (!v) return true;
  if (v.includes(':')) return v === '::1' || v.startsWith('fe80') || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('::ffff:127.') || v.startsWith('::ffff:10.') || v.startsWith('::ffff:192.168.');
  const p = v.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p as [number, number, number, number];
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127);
}

const yes = (v: unknown): boolean => v === true || (typeof v === 'string' && /^(yes|true|1)$/i.test(v.trim()));

/**
 * Read proxycheck.io's answer. The v2 shape is { status, "<ip>": { proxy: "yes", type: "VPN", provider } };
 * newer answers may use booleans (proxy/vpn) and nest them, so the record for the address is searched loosely.
 */
export function parseVerdict(data: unknown, ip: string): IpVerdict {
  if (typeof data !== 'object' || data === null) throw new LookupError("proxycheck.io's answer didn't look like JSON.");
  const d = data as Record<string, unknown>;
  const status = typeof d.status === 'string' ? d.status.toLowerCase() : '';
  if (status === 'denied' || status === 'error') throw new LookupError(`proxycheck.io said: ${typeof d.message === 'string' ? d.message : status}`);
  const rec = (d[ip] ?? d[ip.toLowerCase()]) as Record<string, unknown> | undefined;
  if (!rec || typeof rec !== 'object') throw new LookupError("proxycheck.io's answer didn't include that address.");
  const det = (typeof rec.detections === 'object' && rec.detections !== null ? rec.detections : {}) as Record<string, unknown>;
  const net = (typeof rec.network === 'object' && rec.network !== null ? rec.network : {}) as Record<string, unknown>;
  const type = [rec.type, net.type, det.type].find((t): t is string => typeof t === 'string' && t.trim() !== '');
  const flagged =
    yes(rec.proxy) || yes(rec.vpn) || yes(rec.tor) || yes(det.proxy) || yes(det.vpn) || yes(det.tor) || yes(det.hosting) || (!!type && /vpn|proxy|tor|hosting|data ?cent/i.test(type));
  const provider = [rec.provider, net.provider, rec.operator, net.organisation].find((t): t is string => typeof t === 'string' && t.trim() !== '');
  return { flagged, ...(type ? { type } : {}), ...(provider ? { provider } : {}) };
}

export async function lookupIp(ip: string, apiKey: string, fetchImpl: typeof fetch = fetch): Promise<IpVerdict> {
  const url = `https://proxycheck.io/v2/${encodeURIComponent(ip)}?vpn=1&asn=1${apiKey ? `&key=${encodeURIComponent(apiKey)}` : ''}`;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: ac.signal, headers: { 'User-Agent': 'TS6-Roadie (https://github.com/knkwebservices/ts6-roadie)' } });
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw new LookupError('proxycheck.io did not answer in time.');
    throw new LookupError('Could not reach proxycheck.io.');
  } finally {
    clearTimeout(t);
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new LookupError(`proxycheck.io answered HTTP ${res.status} without JSON.`);
  }
  if (!res.ok && (data as { status?: string })?.status !== 'denied') throw new LookupError(`proxycheck.io answered HTTP ${res.status}.`);
  return parseVerdict(data, ip);
}
