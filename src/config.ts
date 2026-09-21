import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Level } from './logger.js';
import { writeJsonAtomic } from './util/fs.js';

/** Bump when the shape of config.json changes, and add a migration below. */
export const CONFIG_VERSION = 1;

export interface RadioStation {
  name: string;
  url: string;
}

/** Who may use one command, beyond the bot admins (who can always use everything). */
export interface CommandRule {
  /** Server-group IDs allowed to use the command. */
  groups?: number[];
  /** TeamSpeak unique IDs allowed to use the command. */
  uids?: string[];
}

export interface Config {
  configVersion: number;
  server: {
    /** host or host:port (default port 9987) */
    address: string;
    password: string;
    /** Shown in the client list. Pick something users won't also use. */
    nickname: string;
    /** Channel the bot joins on connect and returns to when idle. */
    homeChannel: string;
    homeChannelPassword: string;
    /** Identity security level to generate. Some servers require a minimum. */
    identityLevel: number;
  };
  prefix: string;
  /** TeamSpeak unique IDs allowed to use admin commands. */
  admins: string[];
  /** One-time privilege key that gives the bot its server group on first connect. */
  privilegeKey: string;
  /** Cogs to load at start-up, in order. */
  cogs: string[];
  logLevel: Level;
  avatar: {
    /** Image to use as the bot's avatar. Empty = the bundled Roadie icon. A relative path is relative to the data folder. */
    file: string;
    /** Set the avatar automatically each time the bot connects (skipped if the server already shows it). */
    applyOnConnect: boolean;
  };
  permissions: {
    /**
     * Per-command access rules, keyed by command name (aliases share their command's rule).
     * A command with a rule is limited to bot admins plus the listed groups and users. This can
     * restrict an everyday command (e.g. play) or delegate an admin one. No rule = the default.
     */
    commands: Record<string, CommandRule>;
  };
  web: {
    /** Where the dashboard listens. For now only this machine (127.0.0.1, ::1 or localhost) is allowed. */
    host: string;
    /** 0 picks a free port. */
    port: number;
    /** How long a !weblogin code works, in minutes. */
    codeMinutes: number;
    /** How long a signed-in browser stays signed in, in hours. */
    sessionHours: number;
    /**
     * The https address people use when a reverse proxy (such as Caddy) forwards to the dashboard,
     * for example "https://ts6.example.com". Empty (the default) means the dashboard is only for this machine.
     */
    publicUrl: string;
  };
  voteskip: {
    /** A skip needs MORE than this fraction of the people listening (0.5 = a majority). */
    threshold: number;
  };
  playlists: {
    /** How many saved playlists the server may hold. */
    maxPlaylists: number;
    /** Longest playlist, in tracks. */
    maxTracks: number;
  };
  follow: {
    /** After the queue empties, return to the home channel after this many seconds. */
    idleReturnSeconds: number;
    /** If nobody else is in the bot's channel for this long, stop and go home. */
    aloneLeaveSeconds: number;
  };
  audio: {
    defaultVolume: number;
    /** Opus bitrate in bits per second. */
    bitrate: number;
    /** 5 = Opus Music (stereo), 4 = Opus Voice (mono-ish). */
    codec: 4 | 5;
    maxQueue: number;
    maxPlaylistItems: number;
    maxTrackMinutes: number;
    announceNowPlaying: boolean;
    /** While a radio station plays, keep a second small connection open to read the current song's title (shown by !np). */
    radioNowPlaying: boolean;
    /** Also post each new radio song title in the channel (default off: stations change songs every few minutes). */
    announceRadioTitles: boolean;
    ffmpegPath: string;
    ytdlpPath: string;
    /** Extra yt-dlp arguments, e.g. ["--cookies", "C:\\tsbot\\data\\cookies.txt"]. */
    ytdlpExtraArgs: string[];
    radioStations: Record<string, RadioStation>;
    /** How many tracks one person may have queued at once. Bot admins are exempt. 0 = no limit. */
    maxQueuePerUser: number;
    /** Words that keep a track out of the queue when they appear in its title or address. Bot admins are exempt. */
    blockedWords: string[];
    /** Play something by itself when the queue is empty and someone is listening. */
    autoDj: {
      enabled: boolean;
      /** "radio:<station key or number>" or "playlist:<name>". Empty = nothing chosen yet. */
      source: string;
    };
    /** 24/7 mode: stay in whatever channel the bot is in instead of going home when idle or leaving when alone. */
    stayInChannel: boolean;
  };
}

export const DEFAULT_CONFIG: Config = {
  configVersion: CONFIG_VERSION,
  server: {
    address: 'localhost:9987',
    password: '',
    nickname: 'Roadie',
    homeChannel: '',
    homeChannelPassword: '',
    identityLevel: 10,
  },
  prefix: '!',
  admins: [],
  privilegeKey: '',
  cogs: ['core', 'audio', 'avatar', 'playlists', 'voteskip'],
  logLevel: 'info',
  avatar: { file: '', applyOnConnect: true },
  playlists: { maxPlaylists: 50, maxTracks: 100 },
  permissions: { commands: {} },
  voteskip: { threshold: 0.5 },
  web: { host: '127.0.0.1', port: 8787, codeMinutes: 5, sessionHours: 12, publicUrl: '' },
  follow: { idleReturnSeconds: 120, aloneLeaveSeconds: 60 },
  audio: {
    defaultVolume: 50,
    bitrate: 64_000,
    codec: 5,
    maxQueue: 50,
    maxPlaylistItems: 25,
    maxTrackMinutes: 180,
    announceNowPlaying: true,
    radioNowPlaying: true,
    announceRadioTitles: false,
    ffmpegPath: 'ffmpeg',
    ytdlpPath: 'yt-dlp',
    ytdlpExtraArgs: [],
    maxQueuePerUser: 0,
    blockedWords: [],
    autoDj: { enabled: false, source: '' },
    stayInChannel: false,
    radioStations: {
      groovesalad: { name: 'SomaFM Groove Salad', url: 'https://ice1.somafm.com/groovesalad-128-mp3' },
      spacestation: { name: 'SomaFM Space Station', url: 'https://ice1.somafm.com/spacestation-128-mp3' },
      defcon: { name: 'SomaFM DEF CON Radio', url: 'https://ice1.somafm.com/defcon-128-mp3' },
      secretagent: { name: 'SomaFM Secret Agent', url: 'https://ice1.somafm.com/secretagent-128-mp3' },
      metal: { name: 'SomaFM Metal Detector', url: 'https://ice1.somafm.com/metal-128-mp3' },
    },
  },
};

/**
 * Migrations upgrade an older config.json one version at a time.
 * `migrations[n]` converts a version-n config into version n+1.
 * (Empty for now: version 1 is the first schema. Add entries here when the shape changes.)
 */
export const migrations: Record<number, (c: Record<string, unknown>) => Record<string, unknown>> = {};

export class ConfigError extends Error {}

/** An https address with a host and nothing else: no login details, path, query or fragment. */
function isPublicUrl(v: string): boolean {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.hostname !== '' && u.username === '' && u.password === '' && u.pathname === '/' && u.search === '' && u.hash === '' && !v.includes('?') && !v.includes('#');
  } catch {
    return false;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Deep-merge `over` onto `base`. Arrays and radioStations are replaced, not merged. */
function merge<T>(base: T, over: unknown): T {
  if (!isObject(base) || !isObject(over)) return (over === undefined ? base : over) as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isObject(out[k]) && isObject(v) && k !== 'radioStations' ? merge(out[k], v) : v;
  }
  return out as T;
}

export function migrateConfig(raw: Record<string, unknown>): Record<string, unknown> {
  let version = typeof raw.configVersion === 'number' ? raw.configVersion : 1;
  if (version > CONFIG_VERSION) {
    throw new ConfigError(
      `config.json is version ${version} but this bot only understands up to version ${CONFIG_VERSION}. ` +
        'You are probably running an older release against a newer config - update the bot or roll the config back.',
    );
  }
  let cur = raw;
  while (version < CONFIG_VERSION) {
    const step = migrations[version];
    if (!step) throw new ConfigError(`No migration from config version ${version}.`);
    cur = step(cur);
    version += 1;
    cur.configVersion = version;
  }
  return cur;
}

export function validateConfig(c: Config): Config {
  const problems: string[] = [];
  const need = (ok: boolean, msg: string) => ok || problems.push(msg);

  need(typeof c.server.address === 'string' && c.server.address.trim() !== '', 'server.address is required');
  need(
    typeof c.server.nickname === 'string' && c.server.nickname.length >= 3 && c.server.nickname.length <= 30,
    'server.nickname must be 3-30 characters',
  );
  need(Number.isInteger(c.server.identityLevel) && c.server.identityLevel >= 0 && c.server.identityLevel <= 30, 'server.identityLevel must be 0-30');
  need(typeof c.prefix === 'string' && /^\S{1,3}$/.test(c.prefix), 'prefix must be 1-3 characters with no spaces');
  need(Array.isArray(c.admins) && c.admins.every((a) => typeof a === 'string'), 'admins must be an array of unique-ID strings');
  need(Array.isArray(c.cogs) && c.cogs.includes('core'), 'cogs must include "core"');
  need(['debug', 'info', 'warn', 'error'].includes(c.logLevel), 'logLevel must be debug, info, warn or error');
  need(['127.0.0.1', '::1', 'localhost'].includes(c.web.host), 'web.host must be 127.0.0.1, ::1 or localhost (the dashboard is local-only for now)');
  need(Number.isInteger(c.web.port) && c.web.port >= 0 && c.web.port <= 65535, 'web.port must be a whole number from 0 to 65535 (0 = pick a free port)');
  need(typeof c.web.codeMinutes === 'number' && c.web.codeMinutes > 0 && c.web.codeMinutes <= 60, 'web.codeMinutes must be more than 0 and at most 60');
  need(typeof c.web.sessionHours === 'number' && c.web.sessionHours > 0 && c.web.sessionHours <= 168, 'web.sessionHours must be more than 0 and at most 168');
  need(
    typeof c.web.publicUrl === 'string' && (c.web.publicUrl === '' || isPublicUrl(c.web.publicUrl)),
    'web.publicUrl must be empty, or an https address with no path such as "https://ts6.example.com"',
  );
  need(typeof c.voteskip.threshold === 'number' && c.voteskip.threshold >= 0 && c.voteskip.threshold < 1, 'voteskip.threshold must be a number from 0 up to (not including) 1');
  need(isObject(c.permissions.commands), 'permissions.commands must be an object of command name -> rule');
  if (isObject(c.permissions.commands)) {
    for (const [name, rule] of Object.entries(c.permissions.commands)) {
      const at = `permissions.commands.${name}`;
      if (!isObject(rule)) {
        problems.push(`${at} must be an object like { "groups": [12], "uids": ["..."] }`);
        continue;
      }
      const r = rule as Record<string, unknown>;
      need(r.groups === undefined || (Array.isArray(r.groups) && r.groups.every((g) => Number.isInteger(g) && (g as number) >= 0)), `${at}.groups must be an array of server-group ID numbers`);
      need(r.uids === undefined || (Array.isArray(r.uids) && r.uids.every((u) => typeof u === 'string')), `${at}.uids must be an array of unique-ID strings`);
    }
  }
  need(Number.isInteger(c.playlists.maxPlaylists) && c.playlists.maxPlaylists >= 1, 'playlists.maxPlaylists must be a whole number, at least 1');
  need(Number.isInteger(c.playlists.maxTracks) && c.playlists.maxTracks >= 1, 'playlists.maxTracks must be a whole number, at least 1');
  need(typeof c.avatar.file === 'string', 'avatar.file must be a string (a path, or empty for the bundled icon)');
  need(typeof c.avatar.applyOnConnect === 'boolean', 'avatar.applyOnConnect must be true or false');
  need(c.audio.defaultVolume >= 0 && c.audio.defaultVolume <= 100, 'audio.defaultVolume must be 0-100');
  need(c.audio.bitrate >= 8000 && c.audio.bitrate <= 256_000, 'audio.bitrate must be 8000-256000');
  need(c.audio.codec === 4 || c.audio.codec === 5, 'audio.codec must be 4 or 5');
  need(c.audio.maxQueue >= 1, 'audio.maxQueue must be at least 1');
  need(typeof c.audio.radioNowPlaying === 'boolean', 'audio.radioNowPlaying must be true or false');
  need(typeof c.audio.announceRadioTitles === 'boolean', 'audio.announceRadioTitles must be true or false');
  need(Array.isArray(c.audio.ytdlpExtraArgs), 'audio.ytdlpExtraArgs must be an array');
  need(Number.isInteger(c.audio.maxQueuePerUser) && c.audio.maxQueuePerUser >= 0 && c.audio.maxQueuePerUser <= 1000, 'audio.maxQueuePerUser must be a whole number from 0 (no limit) to 1000');
  need(Array.isArray(c.audio.blockedWords) && c.audio.blockedWords.every((w) => typeof w === 'string' && w.trim().length > 0 && w.length <= 64), 'audio.blockedWords must be a list of words, each 1 to 64 characters');
  need(isObject(c.audio.autoDj) && typeof c.audio.autoDj.enabled === 'boolean' && typeof c.audio.autoDj.source === 'string' && c.audio.autoDj.source.length <= 100, 'audio.autoDj must look like { \"enabled\": false, \"source\": \"radio:groovesalad\" }');
  need(typeof c.audio.stayInChannel === 'boolean', 'audio.stayInChannel must be true or false');
  for (const [key, st] of Object.entries(c.audio.radioStations)) {
    need(isObject(st) && typeof st.name === 'string' && /^https?:\/\//i.test(String(st.url)), `audio.radioStations.${key} needs a name and an http(s) url`);
  }
  if (problems.length) throw new ConfigError('Invalid config.json:\n - ' + problems.join('\n - '));
  return c;
}

/** Parse + migrate + validate config from an already-parsed JSON object. */
export function buildConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new ConfigError('config.json must contain a JSON object');
  const migrated = migrateConfig(raw);
  // A copy, so changing one loaded config (the dashboard edits the radio stations) can never alter the defaults or another config.
  return validateConfig(merge(structuredClone(DEFAULT_CONFIG), migrated));
}

export function loadConfig(dataDir: string): Config {
  const file = join(dataDir, 'config.json');
  if (!existsSync(file)) {
    throw new ConfigError(
      `No config found at ${file}.\nCopy config.example.json to that location, edit it, and start the bot again.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ConfigError(`${file} is not valid JSON: ${(e as Error).message}`);
  }
  const before = isObject(raw) && typeof raw.configVersion === 'number' ? raw.configVersion : 1;
  const cfg = buildConfig(raw);
  if (before < CONFIG_VERSION) {
    // Keep a copy of the pre-migration file, then persist the upgraded one.
    writeJsonAtomic(`${file}.v${before}.bak`, raw);
    writeJsonAtomic(file, cfg);
  }
  return cfg;
}
