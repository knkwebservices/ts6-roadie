import type { CommandContext } from './types.js';

/**
 * A tiny registry that lets one cog offer something to other cogs without importing them.
 * A cog calls `provide()` when it loads (and the returned function when it unloads);
 * other cogs call `get()` at the moment they need it, and must cope with `undefined`
 * (the providing cog might not be loaded).
 */
export class ServiceRegistry {
  readonly #services = new Map<string, unknown>();

  provide<T>(name: string, service: T): () => void {
    if (this.#services.has(name)) throw new Error(`a service named "${name}" is already provided`);
    this.#services.set(name, service);
    return () => {
      // only remove our own registration, never a newer one under the same name
      if (this.#services.get(name) === service) this.#services.delete(name);
    };
  }

  get<T>(name: string): T | undefined {
    return this.#services.get(name) as T | undefined;
  }
}

// ---- the audio cog's service ---------------------------------------------------------------

export const AUDIO_SERVICE = 'audio';

export interface QueueItem {
  kind: 'media' | 'radio';
  title: string;
  url: string;
  durationSec?: number;
}

/** The track playing now. `id` is unique per queued track, so a change of id means a new track. */
export interface NowPlaying extends QueueItem {
  id: number;
}

export interface AudioService {
  /** What is playing and queued right now. `current` is set only while a track is actually playing. */
  snapshot(): { current?: NowPlaying; upcoming: QueueItem[] };
  /**
   * Queue items for the caller, exactly as !play would: the bot follows the caller into their
   * channel if it is idle, refuses politely if it is busy elsewhere, and replies to the caller.
   */
  queue(ctx: CommandContext, items: QueueItem[], opts?: { label?: string }): Promise<void>;
  /** Skip the track that is playing. Returns false if nothing is playing. */
  skip(): boolean;
  /**
   * Look up a link or search words (YouTube, SoundCloud, Bandcamp and other sites yt-dlp knows) without
   * queueing anything. Rejects with an error whose message is safe to show to users.
   */
  resolve(input: string): Promise<QueueItem[]>;
}
