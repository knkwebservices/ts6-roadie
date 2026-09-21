import { existsSync, readFileSync } from 'node:fs';
import type { HistoryEntry } from '../../core/services.js';
import { writeJsonAtomic } from '../../util/fs.js';
import { isPublicHttpUrl } from './sources.js';

/** How many tracks people asked for are kept, and how many of Auto-DJ's own picks (kept apart so they cannot push out the rest). */
export const MAX_REQUESTED = 300;
export const MAX_AUTO = 100;

interface FileShape {
  version: 1;
  nextId: number;
  entries: HistoryEntry[];
}

const clean = (s: unknown, max: number): string => (typeof s === 'string' ? s.replace(/[\r\n\u0000-\u001f]/g, ' ').trim().slice(0, max) : '');

/** What has been played, newest last, in one small file (data/history.json), written atomically. */
export class PlayHistory {
  #entries: HistoryEntry[] = [];
  #nextId = 1;

  constructor(private readonly file: string) {
    if (!existsSync(file)) return;
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<FileShape>;
      for (const e of Array.isArray(data.entries) ? data.entries : []) {
        // The file can be hand-edited, so only keep entries that are well formed and point somewhere safe.
        if (!e || !Number.isInteger(e.id) || typeof e.url !== 'string' || !isPublicHttpUrl(e.url)) continue;
        this.#entries.push({
          id: e.id,
          at: Number(e.at) || 0,
          kind: e.kind === 'radio' ? 'radio' : 'media',
          title: clean(e.title, 150) || e.url,
          url: e.url,
          durationSec: typeof e.durationSec === 'number' && Number.isFinite(e.durationSec) ? e.durationSec : undefined,
          byName: clean(e.byName, 40),
          ...(e.auto ? { auto: true } : {}),
        });
      }
      this.#nextId = Math.max(Number(data.nextId) || 1, ...this.#entries.map((e) => e.id + 1), 1);
    } catch {
      /* a damaged history is not worth refusing to start over */
    }
  }

  add(e: Omit<HistoryEntry, 'id' | 'at'>): HistoryEntry {
    const entry: HistoryEntry = { ...e, id: this.#nextId++, at: Date.now() };
    this.#entries.push(entry);
    // keep the two kinds within their own limits, dropping the oldest of that kind
    const kept = (auto: boolean, max: number) => {
      const n = this.#entries.filter((x) => !!x.auto === auto).length;
      if (n <= max) return;
      let drop = n - max;
      this.#entries = this.#entries.filter((x) => !(!!x.auto === auto && drop-- > 0));
    };
    kept(!!e.auto, e.auto ? MAX_AUTO : MAX_REQUESTED);
    try {
      writeJsonAtomic(this.file, { version: 1, nextId: this.#nextId, entries: this.#entries } satisfies FileShape);
    } catch {
      /* history is nice to have; never let it stop the music */
    }
    return entry;
  }

  /** The latest entries, newest first. */
  recent(n: number): HistoryEntry[] {
    return this.#entries.slice(-Math.max(1, n)).reverse();
  }

  get(id: number): HistoryEntry | undefined {
    return this.#entries.find((e) => e.id === id);
  }

  get size(): number {
    return this.#entries.length;
  }
}
