import { existsSync, readFileSync, renameSync } from 'node:fs';
import { writeJsonAtomic } from '../../util/fs.js';

export interface HoursEntry {
  uid: string;
  name: string;
  /** Time counted online, in seconds. */
  seconds: number;
}

/** Never keep more people than this; the ones with least time go first. */
export const MAX_PEOPLE = 20_000;

/** Time each person has spent online, for ranks. Kept in data/ranks.json. `save()` writes only when something changed. */
export class HoursStore {
  readonly #file: string;
  #people = new Map<string, { name: string; seconds: number }>();
  #dirty = false;

  constructor(file: string) {
    this.#file = file;
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { people?: Record<string, { name?: unknown; seconds?: unknown }> };
      for (const [uid, p] of Object.entries(raw.people ?? {})) {
        if (p && typeof p.name === 'string' && typeof p.seconds === 'number' && Number.isFinite(p.seconds) && p.seconds >= 0) this.#people.set(uid, { name: p.name, seconds: p.seconds });
      }
    } catch {
      try {
        renameSync(file, `${file}.broken-${Date.now()}`);
      } catch {
        /* nothing more to do */
      }
    }
  }

  get size(): number {
    return this.#people.size;
  }

  add(uid: string, name: string, seconds: number): void {
    if (!uid || !(seconds > 0)) return;
    const p = this.#people.get(uid) ?? { name, seconds: 0 };
    p.name = name;
    p.seconds += seconds;
    this.#people.set(uid, p);
    this.#dirty = true;
  }

  /** Set someone's total, e.g. to give long-time members their time when ranks are first switched on. */
  set(uid: string, name: string, seconds: number): void {
    this.#people.set(uid, { name, seconds: Math.max(0, seconds) });
    this.#dirty = true;
  }

  get(uid: string): HoursEntry | undefined {
    const p = this.#people.get(uid);
    return p ? { uid, ...p } : undefined;
  }

  /** People whose last known name is exactly this (ignoring case). */
  byName(name: string): HoursEntry[] {
    const q = name.trim().toLowerCase();
    return [...this.#people].filter(([, p]) => p.name.toLowerCase() === q).map(([uid, p]) => ({ uid, ...p }));
  }

  save(): void {
    if (!this.#dirty) return;
    if (this.#people.size > MAX_PEOPLE) {
      const least = [...this.#people].sort((a, b) => a[1].seconds - b[1].seconds).slice(0, this.#people.size - MAX_PEOPLE);
      for (const [uid] of least) this.#people.delete(uid);
    }
    writeJsonAtomic(this.#file, { version: 1, people: Object.fromEntries(this.#people) });
    this.#dirty = false;
  }
}

/** "12.5 hours", "1 hour", "45 minutes". */
export function formatHours(seconds: number): string {
  const h = seconds / 3600;
  if (h < 1) {
    const m = Math.floor(seconds / 60);
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const shown = h >= 100 ? String(Math.floor(h)) : (Math.floor(h * 10) / 10).toString();
  return `${shown} hour${shown === '1' ? '' : 's'}`;
}
