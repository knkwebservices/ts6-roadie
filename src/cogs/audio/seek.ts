/** The longest jump we accept, so a typo cannot ask for something absurd. */
const MAX_SEEK_SEC = 24 * 3600;

/**
 * Turn what someone typed after !seek into a position in seconds.
 * Accepts 90, 1:30 and 1:02:03 (from the start), and +30 or -30 (from where the track is now).
 * Returns undefined if it is not something we understand.
 */
export function parseSeek(input: string | undefined, currentSec: number): number | undefined {
  const m = /^([+-])?(\d{1,5}(?::\d{1,2}){0,2})$/.exec((input ?? '').trim());
  if (!m) return undefined;
  const parts = m[2]!.split(':').map(Number);
  if (parts.slice(1).some((n) => n > 59)) return undefined; // 1:75 is not a time
  const secs = parts.reduce((total, n) => total * 60 + n, 0);
  if (secs > MAX_SEEK_SEC) return undefined;
  if (!m[1]) return secs;
  return Math.max(0, Math.floor(currentSec) + (m[1] === '-' ? -secs : secs));
}
