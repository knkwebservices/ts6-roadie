import { closeSync, copyFileSync, existsSync, fstatSync, openSync, readFileSync, readdirSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { buildConfig, ConfigError } from '../../config.js';
import { AUDIO_SERVICE, COMMUNITY_SERVICE, type AudioService, type CommunityService } from '../../core/services.js';
import type { BotApi } from '../../core/types.js';
import { errMessage } from '../../util/text.js';
import { writeJsonAtomic } from '../../util/fs.js';
import { BOT_VERSION, tsLibVersion } from '../../version.js';
import { isPublicHttpUrl } from '../audio/sources.js';

/**
 * What the dashboard's Admin tab shows and can change, beyond the chat commands it simply runs.
 * The server only offers these to bot admins.
 */

export interface StationRow {
  key: string;
  name: string;
  url: string;
}

export type SaveResult = { ok: true; stations: StationRow[] } | { ok: false; error: string };

export interface LogTail {
  file: string;
  lines: string[];
  /** True if older lines exist that were not sent. */
  more: boolean;
}

export type LogLevel = 'all' | 'warn' | 'error';

export interface AdminApi {
  overview(): unknown;
  logs(opts: { lines: number; level: LogLevel }): LogTail;
  stations(): { stations: StationRow[]; max: number };
  saveStations(input: unknown): SaveResult;
}

export const MAX_STATIONS = 30;
const MAX_LOG_LINES = 1000;
const MAX_LOG_LINE_CHARS = 2000;
/** How much of the end of a log file is read; plenty for a page of recent lines, and keeps this cheap. */
const TAIL_BYTES = 512 * 1024;
const LOG_FILE = /^tsbot-\d{4}-\d{2}-\d{2}\.log$/;
const ENTRY_START = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Hide anything in a log line that works like a password, before it is sent to a browser. */
export function redact(line: string): string {
  return line
    .replace(/\b[A-Z2-9]{4}-[A-Z2-9]{4}\b/g, '****-****') // dashboard login codes
    .replace(/((?:password|passwd|secret|token|privilege ?key|cookie|authorization)["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1[hidden]')
    .slice(0, MAX_LOG_LINE_CHARS);
}

function readTail(file: string, bytes: number): { text: string; whole: boolean } {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1); // the first line is probably cut in half
    return { text, whole: start === 0 };
  } finally {
    closeSync(fd);
  }
}

/** Group lines into entries: a stack trace's extra lines belong to the entry above them. */
function toEntries(lines: string[]): string[][] {
  const entries: string[][] = [];
  for (const l of lines) {
    if (ENTRY_START.test(l) || entries.length === 0) entries.push([l]);
    else entries.at(-1)!.push(l);
  }
  return entries;
}

function entryLevel(first: string): 'debug' | 'info' | 'warn' | 'error' {
  const m = /^\S+\s+(DEBUG|INFO|WARN|ERROR)\b/.exec(first);
  return m ? (m[1]!.toLowerCase() as 'debug' | 'info' | 'warn' | 'error') : 'info';
}

export function readLogTail(dir: string, wantLines: number, level: LogLevel): LogTail {
  const n = Math.max(1, Math.min(MAX_LOG_LINES, Math.floor(wantLines) || 200));
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => LOG_FILE.test(f)).sort();
  } catch {
    /* no logs folder yet */
  }
  const newest = files.at(-1);
  if (!newest) return { file: '', lines: [], more: false };

  // Newest file first; if it is short (just after midnight or a restart), top up from the day before.
  const chunks: string[] = [];
  let more = false;
  for (const f of [newest, files.at(-2)].filter((x): x is string => !!x)) {
    const t = readTail(join(dir, f), TAIL_BYTES);
    chunks.unshift(t.text);
    more = !t.whole;
    if (chunks.join('\n').split('\n').length >= n * 3) break;
  }
  const all = chunks.join('\n').split(/\r?\n/).filter((l) => l !== '');
  const keep = level === 'all' ? ['debug', 'info', 'warn', 'error'] : level === 'warn' ? ['warn', 'error'] : ['error'];
  const lines = toEntries(all)
    .filter((e) => keep.includes(entryLevel(e[0]!)))
    .flat();
  const shown = lines.slice(-n).map(redact);
  return { file: newest, lines: shown, more: more || lines.length > n };
}

/** A short, safe key for a station name: "SomaFM Groove Salad" becomes "somafm-groove-salad". */
export function stationKey(name: string, taken: Set<string>): string {
  let base = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 28);
  if (!base) base = 'station';
  if (/^\d+$/.test(base)) base = `st-${base}`; // a number-only key would jump the queue in a JS object and clash with "!radio 3"
  let key = base;
  for (let i = 2; taken.has(key); i++) key = `${base}-${i}`;
  return key;
}

const GOOD_KEY = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Turn what the browser sent into a clean list of stations, or say what is wrong. */
export function cleanStations(input: unknown): { ok: true; stations: StationRow[] } | { ok: false; error: string } {
  if (!isObject(input) || !Array.isArray(input.stations)) return { ok: false, error: 'Send a list of stations.' };
  const rows = input.stations;
  if (rows.length > MAX_STATIONS) return { ok: false, error: `That is too many stations (the most is ${MAX_STATIONS}).` };

  const out: StationRow[] = [];
  const keys = new Set<string>();
  const names = new Set<string>();
  const pending: { name: string; url: string; key?: string }[] = [];
  for (const [i, r] of rows.entries()) {
    const at = `Station ${i + 1}`;
    if (!isObject(r)) return { ok: false, error: `${at} is not valid.` };
    const name = typeof r.name === 'string' ? r.name.trim() : '';
    const url = typeof r.url === 'string' ? r.url.trim() : '';
    if (name.length < 1 || name.length > 60 || /[\u0000-\u001f\u007f]/.test(name)) return { ok: false, error: `${at} needs a name of 1 to 60 characters.` };
    if (names.has(name.toLowerCase())) return { ok: false, error: `Two stations are called "${name}". Give each its own name.` };
    names.add(name.toLowerCase());
    if (url.length > 500 || !/^https?:\/\//i.test(url)) return { ok: false, error: `${at} ("${name}") needs a web address that starts with http:// or https://.` };
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      return { ok: false, error: `${at} ("${name}") has an address that is not valid.` };
    }
    if (u.username || u.password) return { ok: false, error: `${at} ("${name}"): leave login details out of the address.` };
    if (!isPublicHttpUrl(url)) return { ok: false, error: `${at} ("${name}"): that address points inside a private network. Add stations like that by editing config.json.` };
    const key = typeof r.key === 'string' && GOOD_KEY.test(r.key) && !/^\d+$/.test(r.key) && !keys.has(r.key) ? r.key : undefined;
    if (key) keys.add(key);
    pending.push({ name, url, key });
  }
  for (const p of pending) {
    const key = p.key ?? stationKey(p.name, keys);
    keys.add(key);
    out.push({ key, name: p.name, url: p.url });
  }
  return { ok: true, stations: out };
}

export function createAdminApi(bot: BotApi, extras: { widget?: () => unknown } = {}): AdminApi {
  const currentStations = (): StationRow[] => Object.entries(bot.config.audio.radioStations).map(([key, s]) => ({ key, name: s.name, url: s.url }));

  return {
    overview() {
      const here = bot.adapter.selfChannelId();
      const channels = bot.adapter.channels();
      const audio = bot.services.get<AudioService>(AUDIO_SERVICE);
      return {
        version: BOT_VERSION,
        tsLib: tsLibVersion(),
        node: process.versions.node,
        uptimeSec: Math.round((Date.now() - bot.startedAt) / 1000),
        connected: bot.adapter.connected,
        botChannelId: String(here),
        cogs: bot.listCogs().map((c) => ({ name: c.manifest.name, version: c.manifest.version, description: c.manifest.description, source: c.source, loaded: c.loaded })),
        channels: channels.map((c) => ({
          id: String(c.id),
          name: c.name,
          parentId: String(c.parentId),
          // the client number (not the unique ID) lets the page ask the bot about one particular person
          users: bot.adapter.usersInChannel(c.id).map((u) => ({ id: u.id, name: u.name })),
        })),
        troll: audio?.troll?.() ?? null,
        tools: audio?.tools?.() ?? null,
        community: bot.services.get<CommunityService>(COMMUNITY_SERVICE)?.state() ?? null,
        widget: extras.widget?.() ?? null,
      };
    },

    logs(opts) {
      return readLogTail(join(bot.dataDir, 'logs'), opts.lines, opts.level);
    },

    stations() {
      return { stations: currentStations(), max: MAX_STATIONS };
    },

    saveStations(input) {
      const cleaned = cleanStations(input);
      if (!cleaned.ok) return cleaned;

      const file = join(bot.dataDir, 'config.json');
      if (!existsSync(file)) return { ok: false, error: 'I cannot find config.json to save into.' };
      try {
        const raw: unknown = JSON.parse(readFileSync(file, 'utf8'));
        if (!isObject(raw)) return { ok: false, error: 'config.json does not hold a JSON object, so I left it alone.' };
        const record: Record<string, { name: string; url: string }> = {};
        for (const s of cleaned.stations) record[s.key] = { name: s.name, url: s.url };
        const next = { ...raw, audio: { ...(isObject(raw.audio) ? raw.audio : {}), radioStations: record } };
        const built = buildConfig(next); // refuses anything the bot would not accept at start-up
        copyFileSync(file, `${file}.web.bak`);
        writeJsonAtomic(file, next);
        bot.config.audio.radioStations = built.audio.radioStations; // takes effect at once, no restart
        bot.log.child('web').info(`radio stations saved from the dashboard (${cleaned.stations.length})`);
        return { ok: true, stations: currentStations() };
      } catch (e) {
        return { ok: false, error: e instanceof ConfigError ? e.message : `Could not save: ${errMessage(e)}` };
      }
    },
  };
}
