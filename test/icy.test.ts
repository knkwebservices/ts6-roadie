import assert from 'node:assert/strict';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { cleanTitle, parseStreamTitle, startIcyTitles } from '../src/cogs/audio/icy.js';
import { until } from './helpers.js';

interface Station {
  url: string;
  requests: number;
  closed: number;
  close(): void;
}

interface StationOptions {
  /** ICY block spacing in audio bytes; undefined = the station sends no titles. */
  metaint?: number;
  /** Titles to announce in turn, each repeated `repeat` times (a raw Buffer lets a test send Latin-1). */
  titles?: (string | Buffer)[];
  repeat?: number;
  /** Write in pieces of this many bytes so blocks straddle network packets. */
  chunk?: number;
  status?: number;
  redirectTo?: string;
  /** Hang up on the FIRST connection after this many blocks (to test reconnecting). */
  dropFirstAfter?: number;
}

async function station(o: StationOptions = {}): Promise<Station> {
  const metaint = 'metaint' in o ? o.metaint : 512;
  const titles = o.titles ?? ['Rick Astley - Never Gonna Give You Up'];
  const repeat = o.repeat ?? 3;
  const sockets = new Set<import('node:net').Socket>();
  const st = { requests: 0, closed: 0 } as Station;

  const server: Server = createServer((req, res: ServerResponse) => {
    st.requests++;
    const thisConn = st.requests;
    res.on('close', () => st.closed++);
    if (o.redirectTo) {
      res.writeHead(302, { location: o.redirectTo }).end();
      return;
    }
    if (o.status && o.status !== 200) {
      res.writeHead(o.status).end();
      return;
    }
    res.writeHead(200, { 'content-type': 'audio/mpeg', 'icy-name': 'Fake FM', ...(metaint ? { 'icy-metaint': String(metaint) } : {}) });
    let blocks = 0;
    const timer = setInterval(() => {
      if (!metaint) return void res.write(Buffer.alloc(300, 7));
      const t = titles[Math.floor(blocks / repeat) % titles.length]!;
      const text = typeof t === 'string' ? Buffer.from(`StreamTitle='${t}';`) : Buffer.concat([Buffer.from("StreamTitle='"), t, Buffer.from("';")]);
      const units = Math.ceil(text.length / 16);
      const meta = Buffer.alloc(1 + units * 16);
      meta[0] = units;
      text.copy(meta, 1);
      const frame = Buffer.concat([Buffer.alloc(metaint, 7), meta]);
      const size = o.chunk ?? frame.length;
      for (let i = 0; i < frame.length; i += size) res.write(frame.subarray(i, i + size));
      blocks++;
      if (o.dropFirstAfter && thisConn === 1 && blocks >= o.dropFirstAfter) res.destroy();
    }, 5);
    res.on('close', () => clearInterval(timer));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  st.url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  st.close = () => {
    for (const s of sockets) s.destroy();
    server.close();
  };
  return st;
}

const collect = (url: string, extra: Partial<Parameters<typeof startIcyTitles>[1]> = {}) => {
  const titles: string[] = [];
  const notes: string[] = [];
  const stop = startIcyTitles(url, { onTitle: (t) => titles.push(t), onNote: (n) => notes.push(n), retryDelayMs: 20, ...extra });
  return { titles, notes, stop };
};

test('announced titles are reported, once each, in order', async () => {
  const s = await station({ titles: ['Rick Astley - Never Gonna Give You Up', "a-ha - Take On Me", 'Queen - Bohemian Rhapsody'], repeat: 4 });
  const c = collect(s.url);
  try {
    await until(() => c.titles.length >= 3, 3000, 'three titles');
    assert.deepEqual(c.titles.slice(0, 3), ['Rick Astley - Never Gonna Give You Up', 'a-ha - Take On Me', 'Queen - Bohemian Rhapsody']);
  } finally {
    c.stop();
    s.close();
  }
});

test('blocks split across network packets (even one byte at a time) still parse', async () => {
  for (const chunk of [1, 7, 100]) {
    const s = await station({ chunk, metaint: 64, titles: ["Björk - Jóga", 'Second - Song'], repeat: 2 });
    const c = collect(s.url);
    try {
      await until(() => c.titles.length >= 2, 4000, `titles with ${chunk}-byte chunks`);
      assert.deepEqual(c.titles.slice(0, 2), ['Björk - Jóga', 'Second - Song'], `chunk size ${chunk}`);
    } finally {
      c.stop();
      s.close();
    }
  }
});

test('an older station sending Latin-1 is decoded correctly', async () => {
  const s = await station({ titles: [Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x64, 0x65, 0x6c, 0x20, 0x4d, 0x61, 0x72])] }); // "Café del Mar" in Latin-1
  const c = collect(s.url);
  try {
    await until(() => c.titles.length >= 1, 3000, 'a title');
    assert.equal(c.titles[0], 'Café del Mar');
  } finally {
    c.stop();
    s.close();
  }
});

test('a station that announces no titles is left alone, quietly, without retrying', async () => {
  const s = await station({ metaint: undefined });
  const c = collect(s.url);
  try {
    await until(() => c.notes.length > 0, 3000, 'a note');
    assert.match(c.notes[0]!, /does not announce song titles/);
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(s.requests, 1, 'exactly one connection, no reconnect loop');
    assert.equal(c.titles.length, 0);
  } finally {
    c.stop();
    s.close();
  }
});

test('stop() ends the connection and no more titles arrive', async () => {
  const s = await station({ titles: ['One', 'Two', 'Three', 'Four'], repeat: 1 });
  const c = collect(s.url);
  try {
    await until(() => c.titles.length >= 1, 3000, 'first title');
    c.stop();
    await until(() => s.closed >= 1, 2000, 'the station to see the connection close');
    const n = c.titles.length;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(c.titles.length, n, 'nothing after stop');
    assert.equal(s.requests, 1, 'and no reconnecting after stop');
  } finally {
    s.close();
  }
});

test('a dropped connection is re-established and titles continue', async () => {
  const s = await station({ titles: ['First', 'Second'], repeat: 1, dropFirstAfter: 2 });
  const c = collect(s.url);
  try {
    await until(() => s.requests >= 2, 3000, 'a reconnect');
    await until(() => c.titles.includes('Second') || c.titles.length >= 2, 3000, 'titles after reconnecting');
  } finally {
    c.stop();
    s.close();
  }
});

test('a failing station is retried a limited number of times, then abandoned', async () => {
  const s = await station({ status: 503 });
  const c = collect(s.url, { maxRetries: 2 });
  try {
    await until(() => c.notes.some((n) => /gave up/.test(n)), 4000, 'giving up');
    assert.equal(s.requests, 3, 'the first try plus two retries');
  } finally {
    c.stop();
    s.close();
  }
});

test('redirects are followed only if allowed', async () => {
  const target = await station({ titles: ['Behind the redirect'] });
  const redirecting = await station({ redirectTo: target.url });
  const follows = collect(redirecting.url, { checkRedirect: () => true });
  try {
    await until(() => follows.titles.length >= 1, 3000, 'a title through the redirect');
    assert.equal(follows.titles[0], 'Behind the redirect');
  } finally {
    follows.stop();
  }

  const refused = collect(redirecting.url, { checkRedirect: () => false });
  try {
    await until(() => refused.notes.length > 0, 2000, 'a note');
    assert.match(refused.notes[0]!, /did not follow a redirect/);
    const before = target.requests;
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(target.requests, before, 'the redirect target must not be contacted');
  } finally {
    refused.stop();
    target.close();
    redirecting.close();
  }
});

test('by default, redirects to private addresses are refused (the station is public, its redirect is not trusted)', async () => {
  const redirecting = await station({ redirectTo: 'http://192.168.1.10/stream' });
  const c = collect(redirecting.url); // default check
  try {
    await until(() => c.notes.length > 0, 2000, 'a note');
    assert.match(c.notes[0]!, /did not follow a redirect/);
  } finally {
    c.stop();
    redirecting.close();
  }
});

test('title cleaning: control characters, TeamSpeak [brackets], spacing and length', () => {
  assert.equal(cleanTitle('  Artist\u0000 -\tSong  \n'), 'Artist - Song');
  assert.equal(cleanTitle('[URL]http://evil.example[/URL] hi'), '(URL)http://evil.example(/URL) hi');
  assert.equal(cleanTitle('x'.repeat(400)).length, 150);
  assert.equal(cleanTitle('   '), '');
});

test('parseStreamTitle handles padding, extra fields, apostrophes and blocks without a title', () => {
  const pad = (s: string) => Buffer.concat([Buffer.from(s), Buffer.alloc(16 - (s.length % 16), 0)]);
  assert.equal(parseStreamTitle(pad("StreamTitle='A - B';StreamUrl='http://x';")), 'A - B');
  assert.equal(parseStreamTitle(pad("StreamTitle='Don't Stop Me Now';")), "Don't Stop Me Now");
  assert.equal(parseStreamTitle(pad("StreamTitle='';")), undefined);
  assert.equal(parseStreamTitle(pad("StreamUrl='http://x';")), undefined);
});
