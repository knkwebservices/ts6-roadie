import http from 'node:http';
import { JSDOM } from 'jsdom';
import type { AudioService, AudioState, HistoryEntry, PlaylistsService, SearchResult, ToolsInfo, TrollSettings } from '../src/core/services.js';
import type { WebService } from '../src/cogs/web/index.js';
import type { TsUser } from '../src/adapter/types.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

export interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** A raw HTTP request, so a test can choose the Host and Origin headers a browser would (or would not) send. */
export function request(
  port: number,
  o: { method?: string; path: string; headers?: Record<string, string>; body?: unknown; host?: string; rawBody?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = o.rawBody ?? (o.body === undefined ? undefined : JSON.stringify(o.body));
    const headers: Record<string, string> = { Host: o.host ?? `127.0.0.1:${port}`, ...(o.headers ?? {}) };
    if (payload !== undefined) {
      headers['Content-Length'] = String(Buffer.byteLength(payload));
      headers['Content-Type'] ??= 'application/json';
    }
    const r = http.request({ host: '127.0.0.1', port, path: o.path, method: o.method ?? (payload === undefined ? 'GET' : 'POST'), headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          /* not JSON */
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: parsed });
      });
    });
    r.on('error', reject);
    r.end(payload);
  });
}

export interface FakeAudio {
  svc: AudioService;
  state: AudioState;
  /** What the Admin tab's Troll control card is shown. Change it before opening the page. */
  troll: TrollSettings;
  /** What the History card is shown (edit the array before opening the page). */
  historyList: HistoryEntry[];
  tools: ToolsInfo;
  /** People (by unique ID) the fake audio service reports as blocked. */
  blockedUids: Set<string>;
  /** Set to answer the page's searches. */
  setSearch(fn: (q: string) => Promise<SearchResult[]>): void;
}

export function fakeAudio(over: Partial<AudioState> = {}): FakeAudio {
  const state: AudioState = { playing: true, paused: false, volume: 50, positionSec: 30, current: { id: 1, kind: 'media', title: 'Song One', url: 'https://www.youtube.com/watch?v=one', durationSec: 200 }, upcoming: [], ...over };
  const svc: AudioService = {
    state: () => state,
    snapshot: () => ({ current: state.current, upcoming: state.upcoming }),
    queue: async () => {},
    skip: () => true,
    resolve: async () => [],
    blocked: (uid) => blockedUids.has(uid),
    troll: () => troll,
    search: async (q) => (searchImpl ? searchImpl(q) : []),
    history: () => historyList,
    tools: () => toolsInfo,
  };
  const blockedUids = new Set<string>();
  let searchImpl: ((q: string) => Promise<SearchResult[]>) | undefined;
  const historyList: HistoryEntry[] = [];
  const toolsInfo: ToolsInfo = { ytdlp: '2026.01.01', ffmpeg: '7.0', updating: false };
  const troll: TrollSettings = { users: [], words: [], maxQueuePerUser: 0 };
  return { svc, state, get troll() { return troll; }, set troll(v) { Object.assign(troll, v); }, historyList, tools: toolsInfo, blockedUids, setSearch: (fn) => (searchImpl = fn) };
}

export interface WebRig extends Harness {
  port: number;
  audio: FakeAudio;
  alice: TsUser;
  admin: TsUser;
  /** Sign in as this user via !weblogin, returning the session cookie header value. */
  login(user: TsUser): Promise<string>;
  /** An authenticated request. */
  as(cookie: string, path: string, body?: unknown, extra?: Record<string, string>): Promise<Reply>;
}

export async function makeWebRig(configOver: Record<string, unknown> = {}, audioOver: Partial<AudioState> = {}): Promise<WebRig> {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'web'], ...configOver, web: { port: 0, ...(configOver.web as object | undefined) } }) });
  const web = h.bot.services.get<WebService>('web')!;
  const audio = fakeAudio(audioOver);
  h.bot.services.provide<AudioService>('audio', audio.svc);
  h.bot.services.provide<PlaylistsService>('playlists', { list: () => [{ name: 'Friday Night', tracks: 3, owner: 'Alice' }], tracks: () => undefined });
  const alice = h.adapter.addUser(5, 'Alice', CH.home, 'uid-alice', [6]);
  const admin = h.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin', []);

  const login = async (user: TsUser): Promise<string> => {
    const n = h.adapter.sent.length;
    h.adapter.say(user, '!weblogin');
    await until(() => h.adapter.sent.length > n, 2000, 'the login code');
    const code = /[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(h.adapter.lastReply())?.[0];
    if (!code) throw new Error(`no code in: ${h.adapter.lastReply()}`);
    const r = await request(web.port, { path: '/api/login', body: { code } });
    if (r.status !== 200) throw new Error(`login failed: ${r.text}`);
    return String(r.headers['set-cookie']![0]).split(';')[0]!;
  };
  const as = (cookie: string, path: string, body?: unknown, extra: Record<string, string> = {}) =>
    request(web.port, { path, body, headers: { Cookie: cookie, ...extra } });

  return { ...h, port: web.port, audio, alice, admin, login, as };
}

/** A fetch() for the page under test: real HTTP to the real server, with a browser-like cookie jar and Origin header. */
function browserFetch(port: number) {
  let cookie = '';
  return async (url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    if (cookie) headers['Cookie'] = cookie;
    if (opts.method === 'POST') headers['Origin'] = `http://127.0.0.1:${port}`;
    const res = await fetch(new URL(url, `http://127.0.0.1:${port}/`), { method: opts.method, headers, body: opts.body });
    for (const c of res.headers.getSetCookie()) cookie = /Max-Age=0/i.test(c) ? '' : c.split(';')[0]!;
    return res;
  };
}

export interface Page {
  win: JSDOM['window'];
  doc: Document;
  /** The chat commands the page has asked the bot to run, in order. */
  sent: string[];
  q<T extends Element = HTMLElement>(sel: string): T;
  qa(sel: string): Element[];
  close(): void;
}

export async function openPage(r: WebRig): Promise<Page> {
  const sent: string[] = [];
  const original = r.bot.runCommandAs.bind(r.bot);
  r.bot.runCommandAs = async (uid: string, text: string) => {
    sent.push(text);
    return original(uid, text);
  };
  const dom = await JSDOM.fromURL(`http://127.0.0.1:${r.port}/`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(w) {
      (w as unknown as { fetch: unknown }).fetch = browserFetch(r.port);
    },
  });
  const doc = dom.window.document;
  await until(() => !doc.getElementById('login')!.hidden || !doc.getElementById('app')!.hidden, 5000, 'the page to start');
  return {
    win: dom.window,
    doc,
    sent,
    q: <T extends Element = HTMLElement>(sel: string) => {
      const e = doc.querySelector<T>(sel);
      if (!e) throw new Error(`no element for ${sel}`);
      return e;
    },
    qa: (sel) => [...doc.querySelectorAll(sel)],
    close: () => dom.window.close(),
  };
}
