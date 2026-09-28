import { existsSync, readFileSync, renameSync } from 'node:fs';
import { writeJsonAtomic } from '../../util/fs.js';

/** One person the bot has seen online, kept by unique ID so a new nickname does not make a new person. */
export interface SeenEntry {
  uid: string;
  /** The nickname they last had. */
  name: string;
  /** When the bot first saw them, in ms since 1970. */
  first: number;
  /** When the bot last saw them online. */
  last: number;
}

interface SeenFile {
  version: 1;
  people: Record<string, Omit<SeenEntry, 'uid'>>;
}

/** Never keep more people than this; the ones not seen for longest go first. */
export const MAX_PEOPLE = 20_000;

/**
 * Who has been online, and when they were last seen. Kept in data/seen.json.
 * Updates are cheap (in memory); `save()` writes the file only when something changed.
 */
export class SeenStore {
  readonly #file: string;
  #people = new Map<string, Omit<SeenEntry, 'uid'>>();
  #dirty = false;

  constructor(file: string) {
    this.#file = file;
    if (!existsSync(file)) return;
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<SeenFile>;
      for (const [uid, p] of Object.entries(raw.people ?? {})) {
        if (p && typeof p.name === 'string' && Number.isFinite(p.first) && Number.isFinite(p.last)) this.#people.set(uid, { name: p.name, first: p.first, last: p.last });
      }
    } catch {
      // Keep the damaged file for a person to look at, and start empty rather than refuse to load.
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

  /** They are online right now. */
  saw(uid: string, name: string, at = Date.now()): void {
    if (!uid) return;
    const p = this.#people.get(uid);
    if (p) {
      if (p.name !== name || at - p.last >= 1000) this.#dirty = true;
      p.name = name;
      p.last = Math.max(p.last, at);
    } else {
      this.#people.set(uid, { name, first: at, last: at });
      this.#dirty = true;
    }
  }

  get(uid: string): SeenEntry | undefined {
    const p = this.#people.get(uid);
    return p ? { uid, ...p } : undefined;
  }

  /**
   * People whose name matches: an exact match (ignoring case) wins outright, otherwise everyone whose
   * name contains the words. Most recently seen first.
   */
  find(query: string): SeenEntry[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const all = [...this.#people].map(([uid, p]) => ({ uid, ...p }));
    const exact = all.filter((p) => p.name.toLowerCase() === q);
    const hits = exact.length ? exact : all.filter((p) => p.name.toLowerCase().includes(q));
    return hits.sort((a, b) => b.last - a.last);
  }

  /** Forget people not seen within `keepDays`, and the oldest beyond MAX_PEOPLE. */
  prune(keepDays: number, now = Date.now()): void {
    const cutoff = now - keepDays * 86_400_000;
    for (const [uid, p] of this.#people) {
      if (p.last < cutoff) {
        this.#people.delete(uid);
        this.#dirty = true;
      }
    }
    if (this.#people.size > MAX_PEOPLE) {
      const oldest = [...this.#people].sort((a, b) => a[1].last - b[1].last).slice(0, this.#people.size - MAX_PEOPLE);
      for (const [uid] of oldest) this.#people.delete(uid);
      this.#dirty = true;
    }
  }

  /** Write the file if anything changed since the last save. */
  save(): void {
    if (!this.#dirty) return;
    const out: SeenFile = { version: 1, people: Object.fromEntries(this.#people) };
    writeJsonAtomic(this.#file, out);
    this.#dirty = false;
  }
}
