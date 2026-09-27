import { existsSync, readFileSync } from 'node:fs';
import type { HistoryEntry } from '../../core/services.js';
import { writeJsonAtomic } from '../../util/fs.js';

/** Keep at most this many restart sessions (each is a couple of numbers, so this stays tiny). */
const MAX_SESSIONS = 200;

interface SongTally {
  title: string;
  url: string;
  plays: number;
  lastAt: number;
}

interface Session {
  start: number;
  /** Updated on every sample tick, and finalized on a clean shutdown, so a crash still leaves a close estimate. */
  end: number;
}

interface FileShape {
  version: 1;
  /** When this file's data started (ms since 1970). Survives resets so "since" is still meaningful. */
  since: number;
  samples: number;
  /** Sum of concurrent-user counts seen at each hour (0-23, server local time), for an average. */
  hourlyUsers: number[];
  hourlySamples: number[];
  /** Seconds each channel (by name) has had at least one person in it, at sample time. */
  channelSeconds: Record<string, number>;
  songs: Record<string, SongTally>;
  /** The newest audio-history entry id already counted, so a restart never double-counts a play. */
  lastHistoryId: number;
  sessions: Session[];
}

function emptyFile(now: number): FileShape {
  return {
    version: 1,
    since: now,
    samples: 0,
    hourlyUsers: new Array(24).fill(0),
    hourlySamples: new Array(24).fill(0),
    channelSeconds: {},
    songs: {},
    lastHistoryId: 0,
    sessions: [],
  };
}

/** What a sample tick observed. */
export interface Sample {
  at: number;
  totalUsers: number;
  /** Channel name -> how many people are in it right now. */
  channelUsers: Record<string, number>;
}

export interface ChannelActivity {
  name: string;
  seconds: number;
}

export interface HourlyAverage {
  hour: number;
  avgUsers: number;
  samples: number;
}

/** Server-usage aggregates (data/analytics.json), built up one sample at a time, written atomically. */
export class AnalyticsStore {
  #data: FileShape;

  constructor(private readonly file: string) {
    this.#data = existsSync(file) ? this.#load() : emptyFile(Date.now());
  }

  #load(): FileShape {
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<FileShape>;
      const base = emptyFile(typeof raw.since === 'number' ? raw.since : Date.now());
      return {
        ...base,
        samples: typeof raw.samples === 'number' ? raw.samples : 0,
        hourlyUsers: Array.isArray(raw.hourlyUsers) && raw.hourlyUsers.length === 24 ? raw.hourlyUsers.map(Number) : base.hourlyUsers,
        hourlySamples: Array.isArray(raw.hourlySamples) && raw.hourlySamples.length === 24 ? raw.hourlySamples.map(Number) : base.hourlySamples,
        channelSeconds: typeof raw.channelSeconds === 'object' && raw.channelSeconds ? raw.channelSeconds : {},
        songs: typeof raw.songs === 'object' && raw.songs ? raw.songs : {},
        lastHistoryId: typeof raw.lastHistoryId === 'number' ? raw.lastHistoryId : 0,
        sessions: Array.isArray(raw.sessions) ? raw.sessions.filter((s) => s && typeof s.start === 'number' && typeof s.end === 'number').slice(-MAX_SESSIONS) : [],
      };
    } catch {
      // a damaged file is not worth refusing to start over
      return emptyFile(Date.now());
    }
  }

  #save(): void {
    try {
      writeJsonAtomic(this.file, this.#data);
    } catch {
      // analytics is nice to have; never let it stop the bot
    }
  }

  // ---- occupancy sampling -----------------------------------------------------------------

  addSample(s: Sample, intervalSeconds: number): void {
    const hour = new Date(s.at).getHours();
    this.#data.hourlyUsers[hour] = (this.#data.hourlyUsers[hour] ?? 0) + s.totalUsers;
    this.#data.hourlySamples[hour] = (this.#data.hourlySamples[hour] ?? 0) + 1;
    this.#data.samples += 1;
    for (const [name, count] of Object.entries(s.channelUsers)) {
      if (count <= 0) continue;
      this.#data.channelSeconds[name] = (this.#data.channelSeconds[name] ?? 0) + intervalSeconds;
    }
    this.#save();
  }

  hourly(): HourlyAverage[] {
    return this.#data.hourlyUsers.map((sum, hour) => {
      const n = this.#data.hourlySamples[hour] ?? 0;
      return { hour, avgUsers: n > 0 ? sum / n : 0, samples: n };
    });
  }

  topChannels(n: number): ChannelActivity[] {
    return Object.entries(this.#data.channelSeconds)
      .map(([name, seconds]) => ({ name, seconds }))
      .sort((a, b) => b.seconds - a.seconds)
      .slice(0, n);
  }

  // ---- songs -------------------------------------------------------------------------------

  get lastHistoryId(): number {
    return this.#data.lastHistoryId;
  }

  /** Merge newly-seen history entries (never entries already counted) into the play tally. */
  addSongs(entries: HistoryEntry[]): void {
    let changed = false;
    for (const e of entries) {
      if (e.id <= this.#data.lastHistoryId) continue;
      const key = e.url;
      const t = this.#data.songs[key] ?? { title: e.title, url: e.url, plays: 0, lastAt: 0 };
      t.plays += 1;
      t.title = e.title; // keep the latest title, in case it was re-fetched with a better one
      t.lastAt = e.at;
      this.#data.songs[key] = t;
      changed = true;
    }
    const newest = entries.reduce((m, e) => Math.max(m, e.id), this.#data.lastHistoryId);
    if (newest !== this.#data.lastHistoryId) {
      this.#data.lastHistoryId = newest;
      changed = true;
    }
    if (changed) this.#save();
  }

  topSongs(n: number): SongTally[] {
    return Object.values(this.#data.songs)
      .sort((a, b) => b.plays - a.plays)
      .slice(0, n);
  }

  // ---- uptime sessions -----------------------------------------------------------------------

  startSession(now: number): void {
    this.#data.sessions.push({ start: now, end: now });
    if (this.#data.sessions.length > MAX_SESSIONS) this.#data.sessions = this.#data.sessions.slice(-MAX_SESSIONS);
    this.#save();
  }

  /** Called on every sample tick and on a clean shutdown, so a crash still leaves a close estimate. */
  touchSession(now: number): void {
    const last = this.#data.sessions.at(-1);
    if (!last) return;
    last.end = now;
    this.#save();
  }

  totalUptimeMs(): number {
    return this.#data.sessions.reduce((sum, s) => sum + Math.max(0, s.end - s.start), 0);
  }

  get sessionCount(): number {
    return this.#data.sessions.length;
  }

  get since(): number {
    return this.#data.since;
  }

  get samples(): number {
    return this.#data.samples;
  }

  /** Clear the usage aggregates (hours, channels, songs). Uptime history is kept, since it isn't clutter. */
  reset(): void {
    const now = Date.now();
    this.#data.since = now;
    this.#data.samples = 0;
    this.#data.hourlyUsers = new Array(24).fill(0);
    this.#data.hourlySamples = new Array(24).fill(0);
    this.#data.channelSeconds = {};
    this.#data.songs = {};
    // lastHistoryId is kept: it is about not double-counting already-played tracks, not about the report.
    this.#save();
  }
}
