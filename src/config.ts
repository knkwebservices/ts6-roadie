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
    /** A public page and data feed showing what is playing and who is online (off by default). */
    widget: {
      enabled: boolean;
      /** List people by name and channel. If false, only how many are in each channel. */
      showNames: boolean;
      /** Websites allowed to embed the page or read the data feed, like "https://tgscgaming.com". */
      origins: string[];
    };
    /**
     * The https address people use when a reverse proxy (such as Caddy) forwards to the dashboard,
     * for example "https://ts6.example.com". Empty (the default) means the dashboard is only for this machine.
     */
    publicUrl: string;
  };
  steam: {
    enabled: boolean;
    /** Free, from https://steamcommunity.com/dev/apikey. Never logged or shown in chat. */
    apiKey: string;
    /** How often to check, in seconds. */
    pollSeconds: number;
    /** People to watch, by SteamID64 (17-digit number, e.g. from https://steamid.io). */
    players: { steamId: string; label: string }[];
  };
  analytics: {
    enabled: boolean;
    /** How often to sample who's online and where, in seconds. */
    pollSeconds: number;
  };
  twitch: {
    enabled: boolean;
    /** From a free app at https://dev.twitch.tv/console/apps. Never logged or shown in chat. */
    clientId: string;
    clientSecret: string;
    /** How often to check, in seconds. */
    pollSeconds: number;
    /** Channels to watch, by their Twitch login (from twitch.tv/<login>, not the display name). */
    channels: { login: string; label: string }[];
  };
  community: {
    /** Moves people who have gone AFK to a channel of their own. */
    afk: {
      enabled: boolean;
      /** The channel to move them to. */
      channel: string;
      /** Minutes of being away, muted or idle before someone is moved. */
      minutes: number;
      /** Warn them by private message this many seconds before moving them (0 = no warning). */
      warnSeconds: number;
      /** How often to check, in seconds. */
      checkSeconds: number;
      /** Server groups (by ID) whose members are never moved. Bot admins never are. */
      exemptGroups: number[];
      /** Channels (by name) where nobody is moved. */
      ignoreChannels: string[];
    };
    /** A private message to everyone who joins the server. */
    welcome: {
      enabled: boolean;
      /** The text. {name} is replaced by the person's nickname. */
      message: string;
      /** Don't greet the same person again within this many seconds. */
      cooldownSeconds: number;
    };
  };
  servertools: {
    /** Tell a server group when someone joins a chosen channel (a support room, say). */
    notify: {
      enabled: boolean;
      /** Channel (by name, or "#<id>") and the server groups (by ID) whose online members are told. */
      rules: { channel: string; groups: number[] }[];
      /** What they are told. {name} is the person who joined, {channel} the channel. */
      message: string;
      /** Don't tell anyone again about the same person joining the same channel within this many seconds. */
      cooldownSeconds: number;
    };
    /** Keep channel names up to date with live figures, like "[cspacer]Online: 12". */
    liveNames: {
      enabled: boolean;
      /** Channels by ID, and the name to give each. {online}, {record} and {song} are filled in. */
      channels: { channelId: number; template: string }[];
      /** Rename a channel at most this often, in seconds (TeamSpeak does not like channels renamed constantly). */
      updateSeconds: number;
    };
    /** Remember when people were last online, for !seen. */
    seen: {
      enabled: boolean;
      /** Forget people not seen for this many days. */
      keepDays: number;
    };
  };
  rooms: {
    /** Join the "create a room" channel, get a private temporary channel of your own. */
    enabled: boolean;
    /** The channel people join to get a room (by name, or "#<id>"). */
    creatorChannel: string;
    /** Where rooms are made (by name, or "#<id>"). Empty = as sub-channels of the creator channel. */
    parentChannel: string;
    /** The room's name. {name} is the person's nickname. */
    nameTemplate: string;
    /** The server deletes a room once it has been empty this many seconds. */
    deleteDelaySeconds: number;
    /** Channel group (by ID) the owner gets in their room, so they can rename it or set a password. 0 = none. */
    ownerChannelGroup: number;
    /** One new room per person per this many seconds. */
    cooldownSeconds: number;
    /** At most this many rooms at once, server-wide. */
    maxRooms: number;
  };
  grouptools: {
    /** Give server groups for time spent online ("Regular" after 10 hours, say). */
    ranks: {
      enabled: boolean;
      /** The ladder, lowest first: after `hours` online, someone gets server group `group` (shown as `label`). */
      rules: { hours: number; group: number; label: string }[];
      /** On reaching a rank, take away the lower ranks' groups (so people wear one rank at a time). */
      replaceLower: boolean;
      /** Count time while someone is set to away (default no). */
      countAway: boolean;
      /** Channels (by name) where time is not counted, like the AFK channel. */
      ignoreChannels: string[];
      /** Server groups (by ID) whose members are never given ranks, like staff. */
      exemptGroups: number[];
    };
    /** Only listed people may be in protected server groups. */
    protect: {
      enabled: boolean;
      /** "warn" tells the online bot admins about anyone who should not be in the group; "remove" also takes them out. */
      mode: 'warn' | 'remove';
      /** Each protected group (by ID), and the unique IDs allowed in it. Bot admins are always allowed. */
      groups: { group: number; allowed: string[] }[];
    };
  };
  events: {
    /** Event reminders: !event add Friday 8pm | Nuke run. */
    enabled: boolean;
    /** Who may add events: bot admins only, or everyone. */
    whoCanAdd: 'admins' | 'everyone';
    /** Post a reminder this many minutes before an event starts (0 = no early reminder). */
    remindMinutes: number;
    /** Poke the people who said !going when the event starts. */
    pokeGoing: boolean;
    /** Most events kept at once. */
    maxEvents: number;
    /**
     * Where reminders are posted: "channel" (the bot's channel) or "server" (the server-wide chat).
     * The TeamSpeak 6 client has nowhere to read server-wide chat, so "channel" is the default.
     */
    postTo: 'channel' | 'server';
  };
  announcements: {
    /** Messages posted in the server chat, one at a time, in turn. */
    enabled: boolean;
    /** Minutes between messages. */
    everyMinutes: number;
    /** The messages. Change them with !announce. */
    messages: string[];
    /** Where they are posted: "channel" (the bot's channel) or "server" (the server-wide chat). */
    postTo: 'channel' | 'server';
  };
  nickfilter: {
    /** Watch nicknames for blocked words. */
    enabled: boolean;
    /** Words not allowed in nicknames (matched ignoring case, and with common letter swaps like 4 for a). */
    words: string[];
    /** What happens if they don't rename in time: "warn" only, "move" them to a channel, or "kick" them. */
    action: 'warn' | 'move' | 'kick';
    /** Channel to move them to, for action "move". */
    moveChannel: string;
    /** Seconds they get to change their nickname after the warning. */
    graceSeconds: number;
    /** Server groups (by ID) never checked. Bot admins never are. */
    exemptGroups: number[];
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
    /** When a live radio stream drops, try to reconnect this many times before giving up (0 = don't retry). */
    radioRetries: number;
    /** Seconds before the first reconnect try; later tries wait longer. */
    radioRetrySeconds: number;
    /** A station (key, number or name) to switch to when the one playing cannot be kept going. Empty = none. */
    radioFallback: string;
    /** Every this many hours, check that YouTube playback still works and tell the online admins if it does not. 0 = never. */
    healthCheckHours: number;
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
  web: { host: '127.0.0.1', port: 8787, codeMinutes: 5, sessionHours: 12, publicUrl: '', widget: { enabled: false, showNames: true, origins: [] } },
  steam: { enabled: false, apiKey: '', pollSeconds: 120, players: [] },
  analytics: { enabled: false, pollSeconds: 300 },
  twitch: { enabled: false, clientId: '', clientSecret: '', pollSeconds: 120, channels: [] },
  community: {
    afk: { enabled: false, channel: 'AFK Room', minutes: 30, warnSeconds: 60, checkSeconds: 30, exemptGroups: [], ignoreChannels: [] },
    welcome: { enabled: false, message: "Welcome, {name}! I'm the music bot. Send me a private message saying !help to see what I can do.", cooldownSeconds: 60 },
  },
  servertools: {
    notify: { enabled: false, rules: [], message: 'Heads up: {name} just joined "{channel}".', cooldownSeconds: 120 },
    liveNames: { enabled: false, channels: [], updateSeconds: 60 },
    seen: { enabled: true, keepDays: 365 },
  },
  rooms: {
    enabled: false,
    creatorChannel: 'Create a Room',
    parentChannel: '',
    nameTemplate: "{name}'s Room",
    deleteDelaySeconds: 60,
    ownerChannelGroup: 5,
    cooldownSeconds: 30,
    maxRooms: 25,
  },
  grouptools: {
    ranks: { enabled: false, rules: [], replaceLower: true, countAway: false, ignoreChannels: ['AFK Room'], exemptGroups: [] },
    protect: { enabled: false, mode: 'warn', groups: [] },
  },
  events: { enabled: true, whoCanAdd: 'admins', remindMinutes: 60, pokeGoing: true, maxEvents: 50, postTo: 'channel' },
  announcements: { enabled: false, everyMinutes: 60, messages: [], postTo: 'channel' },
  nickfilter: { enabled: false, words: [], action: 'warn', moveChannel: 'AFK Room', graceSeconds: 60, exemptGroups: [] },
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
    radioRetries: 3,
    radioRetrySeconds: 2,
    radioFallback: '',
    healthCheckHours: 12,
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

/** A website address with nothing after the host, like "https://tgscgaming.com" (a port is fine). */
function isOrigin(v: string): boolean {
  try {
    const u = new URL(v);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname !== '' && u.origin === v && !u.username && !u.password;
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
  need(
    isObject(c.web.widget) &&
      typeof c.web.widget.enabled === 'boolean' &&
      typeof c.web.widget.showNames === 'boolean' &&
      Array.isArray(c.web.widget.origins) &&
      c.web.widget.origins.every((o) => typeof o === 'string' && isOrigin(o)),
    'web.widget must look like { "enabled": false, "showNames": true, "origins": ["https://example.com"] } (each origin is a website address with no path)',
  );
  need(typeof c.steam.enabled === 'boolean', 'steam.enabled must be true or false');
  need(typeof c.steam.apiKey === 'string', 'steam.apiKey must be a string (empty if you have not set one up yet)');
  need(typeof c.steam.pollSeconds === 'number' && c.steam.pollSeconds >= 30 && c.steam.pollSeconds <= 3600, 'steam.pollSeconds must be from 30 to 3600');
  need(
    Array.isArray(c.steam.players) &&
      c.steam.players.every((pl) => isObject(pl) && typeof pl.steamId === 'string' && /^\d{17}$/.test(pl.steamId) && typeof pl.label === 'string' && pl.label.length <= 64),
    'steam.players must be a list of { "steamId": "<17-digit SteamID64>", "label": "<name, up to 64 characters>" }',
  );
  need(typeof c.analytics.enabled === 'boolean', 'analytics.enabled must be true or false');
  need(typeof c.analytics.pollSeconds === 'number' && c.analytics.pollSeconds >= 60 && c.analytics.pollSeconds <= 3600, 'analytics.pollSeconds must be from 60 to 3600');
  need(typeof c.twitch.enabled === 'boolean', 'twitch.enabled must be true or false');
  need(typeof c.twitch.clientId === 'string', 'twitch.clientId must be a string (empty if you have not set one up yet)');
  need(typeof c.twitch.clientSecret === 'string', 'twitch.clientSecret must be a string (empty if you have not set one up yet)');
  need(typeof c.twitch.pollSeconds === 'number' && c.twitch.pollSeconds >= 30 && c.twitch.pollSeconds <= 3600, 'twitch.pollSeconds must be from 30 to 3600');
  need(
    Array.isArray(c.twitch.channels) &&
      c.twitch.channels.every((ch) => isObject(ch) && typeof ch.login === 'string' && /^[a-zA-Z0-9_]{4,25}$/.test(ch.login) && typeof ch.label === 'string' && ch.label.length <= 64),
    'twitch.channels must be a list of { "login": "<twitch channel name>", "label": "<name, up to 64 characters>" }',
  );
  {
    const a = c.community.afk;
    const w = c.community.welcome;
    need(isObject(a) && typeof a.enabled === 'boolean', 'community.afk.enabled must be true or false');
    need(isObject(a) && typeof a.channel === 'string' && a.channel.trim() !== '' && a.channel.length <= 100, 'community.afk.channel must be a channel name');
    need(isObject(a) && typeof a.minutes === 'number' && a.minutes > 0 && a.minutes <= 1440, 'community.afk.minutes must be more than 0 and at most 1440');
    need(isObject(a) && typeof a.warnSeconds === 'number' && a.warnSeconds >= 0 && a.warnSeconds <= 3600, 'community.afk.warnSeconds must be from 0 (no warning) to 3600');
    need(isObject(a) && typeof a.checkSeconds === 'number' && a.checkSeconds > 0 && a.checkSeconds <= 3600, 'community.afk.checkSeconds must be more than 0 and at most 3600');
    need(isObject(a) && Array.isArray(a.exemptGroups) && a.exemptGroups.every((g) => Number.isInteger(g) && g >= 0), 'community.afk.exemptGroups must be a list of server-group ID numbers');
    need(isObject(a) && Array.isArray(a.ignoreChannels) && a.ignoreChannels.every((n) => typeof n === 'string'), 'community.afk.ignoreChannels must be a list of channel names');
    need(isObject(w) && typeof w.enabled === 'boolean', 'community.welcome.enabled must be true or false');
    need(isObject(w) && typeof w.message === 'string' && w.message.trim() !== '' && w.message.length <= 500, 'community.welcome.message must be text of 1 to 500 characters');
    need(isObject(w) && typeof w.cooldownSeconds === 'number' && w.cooldownSeconds >= 0 && w.cooldownSeconds <= 86_400, 'community.welcome.cooldownSeconds must be from 0 to 86400');
  }
  {
    const t = c.servertools;
    const n = isObject(t) ? t.notify : undefined;
    const l = isObject(t) ? t.liveNames : undefined;
    const sn = isObject(t) ? t.seen : undefined;
    need(isObject(n) && typeof n.enabled === 'boolean', 'servertools.notify.enabled must be true or false');
    need(
      isObject(n) &&
        Array.isArray(n.rules) &&
        n.rules.every(
          (r) =>
            isObject(r) &&
            typeof r.channel === 'string' &&
            r.channel.trim() !== '' &&
            r.channel.length <= 100 &&
            Array.isArray(r.groups) &&
            r.groups.length > 0 &&
            r.groups.every((g) => Number.isInteger(g) && g >= 0),
        ),
      'servertools.notify.rules must be a list of { "channel": "<name or #id>", "groups": [<server-group ID>, ...] }',
    );
    need(isObject(n) && typeof n.message === 'string' && n.message.trim() !== '' && n.message.length <= 300, 'servertools.notify.message must be text of 1 to 300 characters');
    need(isObject(n) && typeof n.cooldownSeconds === 'number' && n.cooldownSeconds >= 0 && n.cooldownSeconds <= 86_400, 'servertools.notify.cooldownSeconds must be from 0 to 86400');
    need(isObject(l) && typeof l.enabled === 'boolean', 'servertools.liveNames.enabled must be true or false');
    need(
      isObject(l) &&
        Array.isArray(l.channels) &&
        l.channels.every((ch) => isObject(ch) && Number.isInteger(ch.channelId) && (ch.channelId as number) > 0 && typeof ch.template === 'string' && ch.template.trim() !== '' && ch.template.length <= 100),
      'servertools.liveNames.channels must be a list of { "channelId": <channel ID number>, "template": "<name, up to 100 characters>" }',
    );
    need(isObject(l) && typeof l.updateSeconds === 'number' && l.updateSeconds >= 30 && l.updateSeconds <= 3600, 'servertools.liveNames.updateSeconds must be from 30 to 3600');
    need(isObject(sn) && typeof sn.enabled === 'boolean', 'servertools.seen.enabled must be true or false');
    need(isObject(sn) && typeof sn.keepDays === 'number' && sn.keepDays >= 1 && sn.keepDays <= 3650, 'servertools.seen.keepDays must be from 1 to 3650');
  }
  {
    const r = c.rooms;
    need(isObject(r) && typeof r.enabled === 'boolean', 'rooms.enabled must be true or false');
    need(isObject(r) && typeof r.creatorChannel === 'string' && r.creatorChannel.trim() !== '' && r.creatorChannel.length <= 100, 'rooms.creatorChannel must be a channel name (or "#<id>")');
    need(isObject(r) && typeof r.parentChannel === 'string' && r.parentChannel.length <= 100, 'rooms.parentChannel must be a channel name, "#<id>", or empty');
    need(isObject(r) && typeof r.nameTemplate === 'string' && r.nameTemplate.trim() !== '' && r.nameTemplate.length <= 40, 'rooms.nameTemplate must be text of 1 to 40 characters');
    need(isObject(r) && Number.isInteger(r.deleteDelaySeconds) && r.deleteDelaySeconds >= 10 && r.deleteDelaySeconds <= 86_400, 'rooms.deleteDelaySeconds must be a whole number from 10 to 86400');
    need(isObject(r) && Number.isInteger(r.ownerChannelGroup) && r.ownerChannelGroup >= 0, 'rooms.ownerChannelGroup must be a channel-group ID number (0 = none)');
    need(isObject(r) && typeof r.cooldownSeconds === 'number' && r.cooldownSeconds >= 0 && r.cooldownSeconds <= 3600, 'rooms.cooldownSeconds must be from 0 to 3600');
    need(isObject(r) && Number.isInteger(r.maxRooms) && r.maxRooms >= 1 && r.maxRooms <= 200, 'rooms.maxRooms must be a whole number from 1 to 200');
  }
  {
    const g = c.grouptools;
    const rk = isObject(g) ? g.ranks : undefined;
    const pr = isObject(g) ? g.protect : undefined;
    need(isObject(rk) && typeof rk.enabled === 'boolean', 'grouptools.ranks.enabled must be true or false');
    need(
      isObject(rk) &&
        Array.isArray(rk.rules) &&
        rk.rules.length <= 20 &&
        rk.rules.every((r) => isObject(r) && typeof r.hours === 'number' && r.hours > 0 && r.hours <= 100_000 && Number.isInteger(r.group) && (r.group as number) > 0 && typeof r.label === 'string' && r.label.trim() !== '' && r.label.length <= 40),
      'grouptools.ranks.rules must be a list (up to 20) of { "hours": <more than 0>, "group": <server-group ID>, "label": "<name, up to 40 characters>" }',
    );
    need(isObject(rk) && typeof rk.replaceLower === 'boolean', 'grouptools.ranks.replaceLower must be true or false');
    need(isObject(rk) && typeof rk.countAway === 'boolean', 'grouptools.ranks.countAway must be true or false');
    need(isObject(rk) && Array.isArray(rk.ignoreChannels) && rk.ignoreChannels.every((n) => typeof n === 'string'), 'grouptools.ranks.ignoreChannels must be a list of channel names');
    need(isObject(rk) && Array.isArray(rk.exemptGroups) && rk.exemptGroups.every((x) => Number.isInteger(x) && x >= 0), 'grouptools.ranks.exemptGroups must be a list of server-group ID numbers');
    need(isObject(pr) && typeof pr.enabled === 'boolean', 'grouptools.protect.enabled must be true or false');
    need(isObject(pr) && (pr.mode === 'warn' || pr.mode === 'remove'), 'grouptools.protect.mode must be "warn" or "remove"');
    need(
      isObject(pr) &&
        Array.isArray(pr.groups) &&
        pr.groups.every((x) => isObject(x) && Number.isInteger(x.group) && (x.group as number) > 0 && Array.isArray(x.allowed) && x.allowed.every((u) => typeof u === 'string' && u.trim() !== '')),
      'grouptools.protect.groups must be a list of { "group": <server-group ID>, "allowed": ["<unique ID>", ...] }',
    );
  }
  {
    const e = c.events;
    need(isObject(e) && typeof e.enabled === 'boolean', 'events.enabled must be true or false');
    need(isObject(e) && (e.whoCanAdd === 'admins' || e.whoCanAdd === 'everyone'), 'events.whoCanAdd must be "admins" or "everyone"');
    need(isObject(e) && Number.isInteger(e.remindMinutes) && e.remindMinutes >= 0 && e.remindMinutes <= 10_080, 'events.remindMinutes must be a whole number from 0 to 10080');
    need(isObject(e) && typeof e.pokeGoing === 'boolean', 'events.pokeGoing must be true or false');
    need(isObject(e) && Number.isInteger(e.maxEvents) && e.maxEvents >= 1 && e.maxEvents <= 500, 'events.maxEvents must be a whole number from 1 to 500');
    need(isObject(e) && (e.postTo === 'channel' || e.postTo === 'server'), 'events.postTo must be "channel" or "server"');
    const a = c.announcements;
    need(isObject(a) && typeof a.enabled === 'boolean', 'announcements.enabled must be true or false');
    need(isObject(a) && typeof a.everyMinutes === 'number' && a.everyMinutes >= 5 && a.everyMinutes <= 1440, 'announcements.everyMinutes must be from 5 to 1440');
    need(isObject(a) && Array.isArray(a.messages) && a.messages.length <= 50 && a.messages.every((m) => typeof m === 'string' && m.trim() !== '' && m.length <= 500), 'announcements.messages must be a list (up to 50) of messages, each 1 to 500 characters');
    need(isObject(a) && (a.postTo === 'channel' || a.postTo === 'server'), 'announcements.postTo must be "channel" or "server"');
    const n = c.nickfilter;
    need(isObject(n) && typeof n.enabled === 'boolean', 'nickfilter.enabled must be true or false');
    need(isObject(n) && Array.isArray(n.words) && n.words.every((w) => typeof w === 'string' && w.trim().length >= 2 && w.length <= 32), 'nickfilter.words must be a list of words, each 2 to 32 characters');
    need(isObject(n) && (n.action === 'warn' || n.action === 'move' || n.action === 'kick'), 'nickfilter.action must be "warn", "move" or "kick"');
    need(isObject(n) && typeof n.moveChannel === 'string' && n.moveChannel.length <= 100, 'nickfilter.moveChannel must be a channel name');
    need(isObject(n) && typeof n.graceSeconds === 'number' && n.graceSeconds >= 1 && n.graceSeconds <= 3600, 'nickfilter.graceSeconds must be from 1 to 3600');
    need(isObject(n) && Array.isArray(n.exemptGroups) && n.exemptGroups.every((g) => Number.isInteger(g) && g >= 0), 'nickfilter.exemptGroups must be a list of server-group ID numbers');
  }
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
  need(Number.isInteger(c.audio.radioRetries) && c.audio.radioRetries >= 0 && c.audio.radioRetries <= 20, 'audio.radioRetries must be a whole number from 0 (no retries) to 20');
  need(typeof c.audio.radioRetrySeconds === 'number' && c.audio.radioRetrySeconds > 0 && c.audio.radioRetrySeconds <= 120, 'audio.radioRetrySeconds must be more than 0 and at most 120');
  need(typeof c.audio.radioFallback === 'string' && c.audio.radioFallback.length <= 100, 'audio.radioFallback must be a station key, number or name (or empty)');
  need(typeof c.audio.healthCheckHours === 'number' && c.audio.healthCheckHours >= 0 && c.audio.healthCheckHours <= 720, 'audio.healthCheckHours must be from 0 (never) to 720');
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
