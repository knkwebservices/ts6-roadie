/**
 * Minerva's visits in Fallout 76. She comes at noon US Eastern and leaves at noon US Eastern:
 * Monday to Wednesday at Foundation, the Crater or Fort Atlas, and Thursday to Monday for her
 * Big Sale at the Whitespring. Some weeks she skips, so her dates can't be worked out from a
 * formula: they come from the published schedule below, and admins can add more with !minerva add.
 */

export type Place = 'Foundation' | 'Crater' | 'Fort Atlas' | 'Whitespring';
export const PLACES: Place[] = ['Foundation', 'Crater', 'Fort Atlas', 'Whitespring'];

export interface Visit {
  /** First day, YYYY-MM-DD (she arrives at noon Eastern). */
  start: string;
  place: Place;
  /** Her list (inventory) number, if known. */
  list?: number;
}

/** Published schedule (Nuka Knights / the Fallout wiki), October 2026 to January 2027. */
export const BUILT_IN: Visit[] = [
  { start: '2026-10-08', place: 'Whitespring', list: 4 },
  { start: '2026-10-19', place: 'Foundation', list: 5 },
  { start: '2026-10-26', place: 'Crater', list: 6 },
  { start: '2026-11-02', place: 'Fort Atlas', list: 7 },
  { start: '2026-11-12', place: 'Whitespring', list: 8 },
  { start: '2026-11-23', place: 'Foundation', list: 9 },
  { start: '2026-11-30', place: 'Crater', list: 10 },
  { start: '2026-12-07', place: 'Fort Atlas', list: 11 },
  { start: '2026-12-17', place: 'Whitespring', list: 12 },
  { start: '2026-12-28', place: 'Foundation', list: 13 },
  { start: '2027-01-04', place: 'Crater', list: 14 },
  { start: '2027-01-11', place: 'Fort Atlas', list: 15 },
  { start: '2027-01-21', place: 'Whitespring', list: 16 },
];

/** Long names as players know them. */
export function placeName(p: Place): string {
  if (p === 'Crater') return 'the Crater';
  if (p === 'Whitespring') return 'the Whitespring Resort';
  return p;
}

/** "fort atlas", "atlas", "the crater", "whitespring resort" -> a Place. */
export function parsePlace(s: string): Place | undefined {
  const t = s.toLowerCase().replace(/^the\s+/, '').replace(/[^a-z]/g, '');
  if (t.startsWith('found')) return 'Foundation';
  if (t.startsWith('crater')) return 'Crater';
  if (t.includes('atlas')) return 'Fort Atlas';
  if (t.startsWith('white')) return 'Whitespring';
  return undefined;
}

export const isBigSale = (v: Visit): boolean => v.place === 'Whitespring';

/** Noon US Eastern on a YYYY-MM-DD day, as ms since 1970 (daylight saving handled). */
export function noonEastern(day: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return NaN;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // noon EDT is 16:00 UTC; check what New York's clock says then and correct by the difference
  const guess = Date.UTC(y, mo - 1, d, 16);
  const hourThere = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(guess)));
  return guess + (12 - hourThere) * 3_600_000;
}

/** When a visit starts and ends, ms since 1970. Big Sales last four days, other visits two. */
export function visitTimes(v: Visit): { start: number; end: number } {
  const start = noonEastern(v.start);
  const [y, mo, d] = v.start.split('-').map(Number) as [number, number, number];
  const endDay = new Date(Date.UTC(y, mo - 1, d + (isBigSale(v) ? 4 : 2))).toISOString().slice(0, 10);
  return { start, end: noonEastern(endDay) };
}

/** A real calendar date, YYYY-MM-DD (also accepts M/D/YYYY). */
export function parseDay(s: string): string | undefined {
  let y: number, mo: number, d: number;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s.trim());
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim());
    if (!m) return undefined;
    [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  }
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
  return dt.toISOString().slice(0, 10);
}

/** The built-in schedule plus admin additions, minus admin removals, in date order. */
export function schedule(added: Visit[], removed: string[]): Visit[] {
  const byDay = new Map<string, Visit>();
  for (const v of BUILT_IN) byDay.set(v.start, v);
  for (const v of added) byDay.set(v.start, v);
  for (const r of removed) byDay.delete(r);
  return [...byDay.values()].sort((a, b) => a.start.localeCompare(b.start));
}

/** Where she is now (if anywhere) and her next visits after that. */
export function whereIs(all: Visit[], now: number): { current?: Visit; next: Visit[] } {
  let current: Visit | undefined;
  const next: Visit[] = [];
  for (const v of all) {
    const t = visitTimes(v);
    if (t.start <= now && now < t.end) current = v;
    else if (t.start > now) next.push(v);
  }
  return { current, next };
}
