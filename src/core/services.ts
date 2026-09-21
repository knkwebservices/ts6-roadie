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
  /** Picked by Auto-DJ rather than requested by a person. */
  auto?: boolean;
}

/** The track playing now. `id` is unique per queued track, so a change of id means a new track. */
export interface NowPlaying extends QueueItem {
  id: number;
  /** For a radio station: the song it is announcing right now, if it announces them. */
  liveTitle?: string;
}

export type RepeatMode = 'off' | 'track' | 'queue';

export interface AutoDjState {
  enabled: boolean;
  /** "radio:<key>" or "playlist:<name>", or empty if none is chosen. */
  source: string;
  /** A readable name for the source, like the station or playlist name. */
  sourceName: string;
}

/** Everything the dashboard needs to draw the player. */
export interface AudioState {
  playing: boolean;
  paused: boolean;
  /** 0-100 */
  volume: number;
  positionSec: number;
  current?: NowPlaying;
  upcoming: QueueItem[];
  repeat?: RepeatMode;
  autoDj?: AutoDjState;
  /** 24/7 mode: the bot stays in its channel. */
  stay?: boolean;
}

/** What is set up to keep trolls from spoiling the music. */
export interface TrollSettings {
  users: { name: string; /** When the block ends, or missing if it never does. */ until?: number }[];
  words: string[];
  /** 0 = no limit. */
  maxQueuePerUser: number;
}

export const PLAYLISTS_SERVICE = 'playlists';

export interface PlaylistsService {
  list(): { name: string; tracks: number; owner: string }[];
  /** The tracks of a saved playlist (names ignore case), or undefined if there is none. */
  tracks(name: string): QueueItem[] | undefined;
}

export interface AudioService {
  /** A read-only picture of the player for display. */
  state(): AudioState;
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
  /** Is this person blocked from using the music commands? (Bot admins never are.) */
  blocked(uid: string): boolean;
  /** The current troll-control settings, for the dashboard. */
  troll(): TrollSettings;
}
