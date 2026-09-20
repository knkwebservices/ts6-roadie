export type TrackKind = 'media' | 'radio';

export interface Track {
  id: number;
  kind: TrackKind;
  title: string;
  /** Page/stream URL. For "media" it is handed to yt-dlp; for "radio" straight to ffmpeg. */
  url: string;
  durationSec?: number;
  requesterUid: string;
  requesterName: string;
}

/** Play queue: the track currently playing plus an ordered list of what's next. */
export class TrackQueue {
  #upcoming: Track[] = [];
  current?: Track;

  get size(): number {
    return this.#upcoming.length;
  }

  get upcoming(): readonly Track[] {
    return this.#upcoming;
  }

  add(...tracks: Track[]): void {
    this.#upcoming.push(...tracks);
  }

  /** Move the next track into `current` and return it. */
  next(): Track | undefined {
    this.current = this.#upcoming.shift();
    return this.current;
  }

  /** Called when playback stops for good. */
  finish(): void {
    this.current = undefined;
  }

  clear(): number {
    const n = this.#upcoming.length;
    this.#upcoming = [];
    return n;
  }

  /** Remove by 1-based position in the upcoming list. */
  remove(position: number): Track | undefined {
    if (!Number.isInteger(position) || position < 1 || position > this.#upcoming.length) return undefined;
    return this.#upcoming.splice(position - 1, 1)[0];
  }

  shuffle(random: () => number = Math.random): void {
    const a = this.#upcoming;
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
  }
}
