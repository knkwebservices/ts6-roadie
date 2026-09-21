import { existsSync, readFileSync, renameSync } from 'node:fs';
import type { Log } from '../../logger.js';
import { writeJsonAtomic } from '../../util/fs.js';
import { isPublicHttpUrl } from '../audio/sources.js';

export interface StoredTrack {
  kind: 'media' | 'radio';
  title: string;
  url: string;
  durationSec?: number;
}

export interface Playlist {
  /** Display name, as first saved. Lookups ignore case. */
  name: string;
  ownerUid: string;
  ownerName: string;
  createdAt: number;
  updatedAt: number;
  tracks: StoredTrack[];
}

interface FileShape {
  version: 1;
  playlists: Record<string, Playlist>;
}

const NAME_RE = /^[\p{L}\p{N} _.'-]{1,32}$/u;

/** A playlist name is 1-32 letters, digits, spaces or _ . ' - (no brackets: TeamSpeak chat treats those as formatting). */
export function validName(name: string): boolean {
  return NAME_RE.test(name) && name.trim() === name && name.trim().length > 0;
}

const keyOf = (name: string): string => name.toLowerCase();

/** Keep only well-formed tracks with a safe URL: the file can be hand-edited, so never trust it blindly. */
function cleanTracks(raw: unknown): StoredTrack[] {
  if (!Array.isArray(raw)) return [];
  const out: StoredTrack[] = [];
  for (const t of raw as Partial<StoredTrack>[]) {
    if (!t || typeof t.url !== 'string' || !isPublicHttpUrl(t.url)) continue;
    out.push({
      kind: t.kind === 'radio' ? 'radio' : 'media',
      title: typeof t.title === 'string' && t.title ? t.title.replace(/[\r\n\u0000-\u001f]/g, ' ').slice(0, 150) : t.url,
      url: t.url,
      durationSec: typeof t.durationSec === 'number' && Number.isFinite(t.durationSec) ? t.durationSec : undefined,
    });
  }
  return out;
}

/** Saved playlists in one JSON file (data/playlists.json), written atomically. */
export class PlaylistStore {
  #lists = new Map<string, Playlist>();

  constructor(
    private readonly file: string,
    private readonly log: Log,
  ) {
    this.#load();
  }

  #load(): void {
    if (!existsSync(this.file)) return;
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FileShape>;
      for (const pl of Object.values(data.playlists ?? {})) {
        if (!pl || typeof pl.name !== 'string' || !validName(pl.name)) continue;
        this.#lists.set(keyOf(pl.name), {
          name: pl.name,
          ownerUid: String(pl.ownerUid ?? ''),
          ownerName: String(pl.ownerName ?? ''),
          createdAt: Number(pl.createdAt) || 0,
          updatedAt: Number(pl.updatedAt) || 0,
          tracks: cleanTracks(pl.tracks),
        });
      }
    } catch (e) {
      // Don't lose someone's playlists to a hand-edit typo: set the broken file aside before we ever write a new one.
      const aside = `${this.file}.broken-${Date.now()}`;
      try {
        renameSync(this.file, aside);
      } catch {
        /* best effort */
      }
      this.log.error(`playlists file was not valid JSON; moved it to ${aside} and started empty`, e);
    }
  }

  #save(): void {
    const playlists: Record<string, Playlist> = {};
    for (const [k, v] of this.#lists) playlists[k] = v;
    writeJsonAtomic(this.file, { version: 1, playlists } satisfies FileShape);
  }

  get size(): number {
    return this.#lists.size;
  }

  get(name: string): Playlist | undefined {
    return this.#lists.get(keyOf(name));
  }

  list(): Playlist[] {
    return [...this.#lists.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  put(pl: Playlist): void {
    this.#lists.set(keyOf(pl.name), pl);
    this.#save();
  }

  /** Give a playlist a new name. False if the old one is missing or the new name belongs to a different playlist. */
  rename(oldName: string, newName: string): boolean {
    const pl = this.get(oldName);
    if (!pl) return false;
    const to = keyOf(newName);
    if (to !== keyOf(oldName) && this.#lists.has(to)) return false;
    this.#lists.delete(keyOf(oldName));
    this.#lists.set(to, { ...pl, name: newName, updatedAt: Date.now() });
    this.#save();
    return true;
  }

  delete(name: string): boolean {
    const gone = this.#lists.delete(keyOf(name));
    if (gone) this.#save();
    return gone;
  }
}
