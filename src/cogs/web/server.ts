import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Log } from '../../logger.js';
import { errMessage } from '../../util/text.js';
import type { Person, WebAuth } from './auth.js';
import { APP_CSS, APP_HTML, APP_JS } from './ui.js';

const COOKIE = 'roadie_sid';
const MAX_BODY_BYTES = 4096;
const COMMAND_LIMIT = { count: 10, windowMs: 5_000 };

export interface WebDeps {
  auth: WebAuth;
  /** Run a chat command as this connected person, with their chat permissions. */
  runCommandAs(uid: string, text: string): Promise<{ ok: boolean; replies: string[] }>;
  /** Everything the page shows, for this person. Must be JSON-serialisable. */
  state(person: Person): unknown;
  sessionTtlMs: number;
  log: Log;
}

export interface RunningWeb {
  port: number;
  close(): Promise<void>;
}

const SECURITY_HEADERS: Record<string, string> = {
  // The page loads only its own script and stylesheet, and can only talk to its own server.
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

function send(res: http.ServerResponse, status: number, body: string, type: string, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': type, ...SECURITY_HEADERS, ...extra });
  res.end(body);
}
const json = (res: http.ServerResponse, status: number, data: unknown, extra: Record<string, string> = {}): void =>
  send(res, status, JSON.stringify(data), 'application/json; charset=utf-8', extra);

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

/**
 * Read a small JSON object body. On a problem it sends the error reply itself and resolves to undefined.
 * An oversized request gets its 413 reply first, and only then is the connection closed.
 */
function readJsonBody(req: http.IncomingMessage, res: http.ServerResponse): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    const fail = (status: number, message: string, close = false): void => {
      if (settled) return;
      settled = true;
      json(res, status, { error: message }, close ? { Connection: 'close' } : {});
      if (close) res.once('finish', () => req.destroy());
      resolve(undefined);
    };
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return fail(413, 'That request is too large.', true);

    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY_BYTES) return fail(413, 'That request is too large.', true);
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('not an object');
        settled = true;
        resolve(v as Record<string, unknown>);
      } catch {
        fail(400, 'That request was not valid JSON.');
      }
    });
    req.on('error', () => {
      if (!settled) {
        settled = true;
        resolve(undefined);
      }
    });
  });
}

/** Addresses that mean "this machine": a reverse proxy running here reaches the dashboard from one of these. */
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * Who is really asking? Normally the connection's own address. Behind a reverse proxy on this machine every
 * connection comes from the proxy, so the address the proxy reports in X-Forwarded-For (the last entry, the one
 * the proxy itself added) is used instead, so each visitor gets their own login-guess allowance.
 * The header is only believed when the connection itself comes from this machine.
 */
function clientKey(req: http.IncomingMessage): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  if (!LOOPBACK.has(remote)) return remote;
  const forwarded = req.headers['x-forwarded-for'];
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').pop()?.trim();
  return last ? last.slice(0, 64) : 'local';
}

export async function startWebServer(opts: { host: string; port: number; publicUrl?: string }, deps: WebDeps): Promise<RunningWeb> {
  const commandTimes = new Map<string, number[]>();
  let boundPort = opts.port;

  // When a reverse proxy serves the dashboard on a public https address, that address (and only that one) is
  // also accepted, along with the matching https origin. Everything else is still refused.
  const publicUrl = opts.publicUrl ? new URL(opts.publicUrl) : undefined;
  const publicHost = publicUrl?.host.toLowerCase();

  const allowedHosts = (): Set<string> => {
    const hosts = new Set([`127.0.0.1:${boundPort}`, `localhost:${boundPort}`, `[::1]:${boundPort}`]);
    if (publicHost) hosts.add(publicHost);
    return hosts;
  };

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      deps.log.error(`dashboard request failed: ${errMessage(e)}`);
      if (!res.headersSent) json(res, 500, { error: 'Something went wrong.' });
      else res.destroy();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // 1. Only answer requests addressed to this machine by name or number. This is what stops a
    //    malicious web page from reaching the dashboard through your browser ("DNS rebinding").
    const host = (req.headers.host ?? '').toLowerCase();
    if (!allowedHosts().has(host)) return json(res, 403, { error: 'Not allowed.' });
    // 2. A browser tells us which site a request came from; refuse any site that is not this one.
    const origin = req.headers.origin;
    const viaPublic = publicHost !== undefined && host === publicHost;
    const expectedOrigin = viaPublic ? publicUrl!.origin : `http://${host}`;
    if (origin !== undefined && origin !== expectedOrigin) return json(res, 403, { error: 'Not allowed.' });
    // Tell browsers to keep using https for this address (half a year).
    if (viaPublic) res.setHeader('Strict-Transport-Security', 'max-age=15552000');

    const url = new URL(req.url ?? '/', `http://${host}`);
    const method = req.method ?? 'GET';
    const path = url.pathname;

    if (method === 'GET' && (path === '/' || path === '/index.html')) return send(res, 200, APP_HTML, 'text/html; charset=utf-8');
    if (method === 'GET' && path === '/app.js') return send(res, 200, APP_JS, 'text/javascript; charset=utf-8');
    if (method === 'GET' && path === '/app.css') return send(res, 200, APP_CSS, 'text/css; charset=utf-8');

    const api = ['/api/login', '/api/logout', '/api/state', '/api/command'];
    if (!api.includes(path)) return json(res, 404, { error: 'Not found.' });

    const wantsPost = path !== '/api/state';
    if ((method === 'POST') !== wantsPost) return json(res, 405, { error: 'Method not allowed.' }, { Allow: wantsPost ? 'POST' : 'GET' });
    // Requiring JSON means another site cannot send us a form post: a cross-site JSON request needs permission first.
    if (method === 'POST' && !/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'Send JSON.' });

    const sid = readCookie(req, COOKIE);

    if (path === '/api/login') {
      const body = await readJsonBody(req, res);
      if (!body) return;
      const r = deps.auth.redeem(typeof body.code === 'string' ? body.code : '', clientKey(req));
      if (!r.ok) {
        return r.reason === 'locked'
          ? json(res, 429, { error: 'Too many wrong codes. Wait a few minutes, then try again.' })
          : json(res, 401, { error: 'That code is not valid or has expired. Send !weblogin again for a new one.' });
      }
      const maxAge = Math.floor(deps.sessionTtlMs / 1000);
      return json(res, 200, { ok: true, user: { name: r.session.name } }, { 'Set-Cookie': `${COOKIE}=${r.sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${viaPublic ? '; Secure' : ''}` });
    }

    if (path === '/api/logout') {
      deps.auth.end(sid);
      return json(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${viaPublic ? '; Secure' : ''}` });
    }

    const person = deps.auth.session(sid);
    if (!person) return json(res, 401, { error: 'Sign in first.' });

    if (path === '/api/state') return json(res, 200, deps.state(person));

    // /api/command
    const now = Date.now();
    const recent = (commandTimes.get(sid!) ?? []).filter((t) => now - t < COMMAND_LIMIT.windowMs);
    if (recent.length >= COMMAND_LIMIT.count) return json(res, 429, { error: 'Slow down a little.' });
    recent.push(now);
    commandTimes.set(sid!, recent);

    const body = await readJsonBody(req, res);
    if (!body) return;
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    if (!text || text.length > 500) return json(res, 400, { error: 'Send a command of up to 500 characters.' });
    const r = await deps.runCommandAs(person.uid, text);
    return json(res, 200, r);
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  boundPort = (server.address() as AddressInfo).port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
