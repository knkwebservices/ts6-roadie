import http from 'node:http';
import type { AudioService, AudioState, PlaylistsService } from '../src/core/services.js';
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
}

export function fakeAudio(over: Partial<AudioState> = {}): FakeAudio {
  const state: AudioState = { playing: true, paused: false, volume: 50, positionSec: 30, current: { id: 1, kind: 'media', title: 'Song One', url: 'https://www.youtube.com/watch?v=one', durationSec: 200 }, upcoming: [], ...over };
  const svc: AudioService = {
    state: () => state,
    snapshot: () => ({ current: state.current, upcoming: state.upcoming }),
    queue: async () => {},
    skip: () => true,
    resolve: async () => [],
  };
  return { svc, state };
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
  h.bot.services.provide<PlaylistsService>('playlists', { list: () => [{ name: 'Friday Night', tracks: 3, owner: 'Alice' }] });
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
