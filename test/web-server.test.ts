import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { APP_HTML, APP_JS } from '../src/cogs/web/ui.js';
import { buildConfig } from '../src/config.js';
import { makeBot, makeConfig, until } from './helpers.js';
import { makeWebRig, request } from './web-helpers.js';

test('the page, its script and stylesheet are served with strict security headers', async () => {
  const r = await makeWebRig();
  try {
    for (const [path, type] of [['/', 'text/html'], ['/app.js', 'text/javascript'], ['/app.css', 'text/css']] as const) {
      const res = await request(r.port, { path });
      assert.equal(res.status, 200, path);
      assert.match(String(res.headers['content-type']), new RegExp(type), path);
      assert.equal(res.headers['x-content-type-options'], 'nosniff');
      assert.equal(res.headers['referrer-policy'], 'no-referrer');
      assert.equal(res.headers['cache-control'], 'no-store');
      assert.match(String(res.headers['content-security-policy']), /default-src 'none'.*script-src 'self'.*frame-ancestors 'none'/);
    }
    assert.equal((await request(r.port, { path: '/nope' })).status, 404);
    assert.equal((await request(r.port, { path: '/api/nope' })).status, 404);
  } finally {
    r.cleanup();
  }
});

test('!weblogin sends the code privately, never into the channel', async () => {
  const r = await makeWebRig();
  try {
    r.adapter.say(r.alice, '!weblogin', 'channel');
    await until(() => r.adapter.sent.length >= 2, 2000, 'both messages');
    const priv = r.adapter.sent.find((s) => s.kind === 'private')!;
    const chan = r.adapter.sent.find((s) => s.kind === 'channel')!;
    assert.match(priv.text, /[A-Z2-9]{4}-[A-Z2-9]{4}/);
    assert.equal(priv.to, r.alice.id);
    assert.match(priv.text, new RegExp(`127\\.0\\.0\\.1:${r.port}`));
    assert.doesNotMatch(chan.text, /[A-Z2-9]{4}-[A-Z2-9]{4}/, 'the channel must not see the code');
    assert.match(chan.text, /private message/);
  } finally {
    r.cleanup();
  }
});

test('login: wrong code 401, right code sets a locked-down cookie once, and a used code is dead', async () => {
  const r = await makeWebRig();
  try {
    assert.equal((await request(r.port, { path: '/api/login', body: { code: 'NOPE-NOPE' } })).status, 401);

    r.adapter.say(r.alice, '!weblogin');
    await until(() => r.adapter.sent.length === 1, 2000, 'code');
    const code = /[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(r.adapter.lastReply())![0];
    const ok = await request(r.port, { path: '/api/login', body: { code } });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.user.name, 'Alice');
    const cookie = String(ok.headers['set-cookie']![0]);
    assert.match(cookie, /^roadie_sid=[A-Za-z0-9_-]{40,};/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Max-Age=43200/); // 12 hours

    assert.equal((await request(r.port, { path: '/api/login', body: { code } })).status, 401, 'single use');
  } finally {
    r.cleanup();
  }
});

test('SAFETY: guessing codes is rate-limited', async () => {
  const r = await makeWebRig();
  try {
    let last = 0;
    for (let i = 0; i < 12; i++) last = (await request(r.port, { path: '/api/login', body: { code: `WRNG-${1000 + i}` } })).status;
    assert.equal(last, 429);
  } finally {
    r.cleanup();
  }
});

test('the state needs a session, and shows the player, playlists, stations and who you are', async () => {
  const r = await makeWebRig({}, { upcoming: [{ kind: 'media', title: 'Next One', url: 'https://x.test/1', durationSec: 100 }] });
  try {
    assert.equal((await request(r.port, { path: '/api/state' })).status, 401);
    assert.equal((await request(r.port, { path: '/api/state', headers: { Cookie: 'roadie_sid=forged' } })).status, 401);

    const cookie = await r.login(r.alice);
    const s = (await request(r.port, { path: '/api/state', headers: { Cookie: cookie } })).json;
    assert.equal(s.user.name, 'Alice');
    assert.equal(s.prefix, '!');
    assert.equal(s.connected, true);
    assert.equal(s.bot.connected, true);
    assert.equal(s.bot.channel, 'Lobby');
    assert.equal(s.audio.current.title, 'Song One');
    assert.equal(s.audio.upcoming[0].title, 'Next One');
    assert.deepEqual(s.playlists, [{ name: 'Friday Night', tracks: 3, owner: 'Alice' }]);
    assert.ok(s.stations.length >= 3 && s.stations[0].n === 1);
  } finally {
    r.cleanup();
  }
});

test('PARITY: a command from the dashboard follows exactly the chat permissions', async () => {
  const r = await makeWebRig({ permissions: { commands: { help: { groups: [12] } } } });
  try {
    const alice = await r.login(r.alice);
    const admin = await r.login(r.admin);

    assert.deepEqual((await r.as(alice, '/api/command', { text: '!ping' })).json, { ok: true, replies: ['pong'] });
    assert.match((await r.as(alice, '/api/command', { text: '!status' })).json.replies[0], /admins only/, 'admin-only stays admin-only');
    assert.match((await r.as(admin, '/api/command', { text: '!status' })).json.replies[0], /TS library/);
    assert.match((await r.as(alice, '/api/command', { text: '!help' })).json.replies[0], /don't have permission to use !help/, 'group rules apply too');
  } finally {
    r.cleanup();
  }
});

test('commands: unknown ones and text without the prefix are explained; a user who left TeamSpeak is told so', async () => {
  const r = await makeWebRig();
  try {
    const cookie = await r.login(r.alice);
    assert.match((await r.as(cookie, '/api/command', { text: '!frobnicate' })).json.replies.join(' '), /not a command I know/);
    assert.match((await r.as(cookie, '/api/command', { text: 'ping' })).json.replies.join(' '), /Commands start with "!"/);
    assert.equal((await r.as(cookie, '/api/command', { text: '' })).status, 400);
    assert.equal((await r.as(cookie, '/api/command', { text: 'x'.repeat(501) })).status, 400);

    r.adapter.userList.splice(r.adapter.userList.indexOf(r.alice), 1); // Alice leaves TeamSpeak
    const gone = (await r.as(cookie, '/api/command', { text: '!ping' })).json;
    assert.equal(gone.ok, false);
    assert.match(gone.replies[0], /connected to TeamSpeak/);
    assert.equal((await request(r.port, { path: '/api/state', headers: { Cookie: cookie } })).json.connected, false);
  } finally {
    r.cleanup();
  }
});

test('SAFETY: wrong Host (DNS rebinding) and foreign Origin (cross-site) are refused', async () => {
  const r = await makeWebRig();
  try {
    const cookie = await r.login(r.alice);
    for (const host of ['evil.example', `evil.example:${r.port}`, `127.0.0.1.evil.example:${r.port}`, '10.0.0.5:8787']) {
      assert.equal((await request(r.port, { path: '/', host })).status, 403, `Host ${host}`);
      assert.equal((await request(r.port, { path: '/api/state', host, headers: { Cookie: cookie } })).status, 403, `Host ${host} with a valid cookie`);
    }
    for (const origin of ['http://evil.example', `http://localhost.evil.example:${r.port}`, 'null', 'https://127.0.0.1']) {
      const res = await r.as(cookie, '/api/command', { text: '!ping' }, { Origin: origin });
      assert.equal(res.status, 403, `Origin ${origin}`);
    }
    // the genuine browser case is fine, by either name
    assert.equal((await r.as(cookie, '/api/command', { text: '!ping' }, { Origin: `http://127.0.0.1:${r.port}` })).status, 200);
    assert.equal((await request(r.port, { path: '/', host: `localhost:${r.port}` })).status, 200);
  } finally {
    r.cleanup();
  }
});

test('SAFETY: only JSON, only small, only the right method', async () => {
  const r = await makeWebRig();
  try {
    const cookie = await r.login(r.alice);
    const form = await request(r.port, { path: '/api/command', rawBody: 'text=%21skip', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415, 'a plain form post (what another site could send) is refused');
    assert.equal((await request(r.port, { path: '/api/command', rawBody: '{ not json', headers: { Cookie: cookie } })).status, 400);
    assert.equal((await request(r.port, { path: '/api/command', rawBody: '[1,2]', headers: { Cookie: cookie } })).status, 400);
    const big = await request(r.port, { path: '/api/command', rawBody: JSON.stringify({ text: 'x'.repeat(6000) }), headers: { Cookie: cookie } });
    assert.equal(big.status, 413);
    assert.equal((await request(r.port, { path: '/api/state', method: 'POST', body: {}, headers: { Cookie: cookie } })).status, 405);
    assert.equal((await request(r.port, { path: '/api/command', method: 'GET', headers: { Cookie: cookie } })).status, 405);
  } finally {
    r.cleanup();
  }
});

test('commands are rate-limited per session', async () => {
  const r = await makeWebRig();
  try {
    const cookie = await r.login(r.alice);
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await r.as(cookie, '/api/command', { text: '!ping' })).status);
    assert.equal(statuses.filter((s) => s === 200).length, 10);
    assert.ok(statuses.includes(429));
  } finally {
    r.cleanup();
  }
});

test('signing out ends the session', async () => {
  const r = await makeWebRig();
  try {
    const cookie = await r.login(r.alice);
    const out = await r.as(cookie, '/api/logout', {});
    assert.equal(out.status, 200);
    assert.match(String(out.headers['set-cookie']![0]), /Max-Age=0/);
    assert.equal((await request(r.port, { path: '/api/state', headers: { Cookie: cookie } })).status, 401);
  } finally {
    r.cleanup();
  }
});

test('the page never puts outside text into the page as HTML', () => {
  for (const banned of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'srcdoc']) {
    assert.ok(!APP_JS.includes(banned), `app.js must not use ${banned}`);
  }
  assert.doesNotMatch(APP_HTML, /<script(?![^>]*\bsrc=)/i, 'no inline scripts');
  assert.doesNotMatch(APP_HTML, /\son[a-z]+\s*=/i, 'no inline event handlers');
});

test('the dashboard is local-only: other listen addresses are refused by the config', () => {
  for (const host of ['0.0.0.0', '192.168.1.5', '', '::']) assert.throws(() => buildConfig({ web: { host } }), /web\.host/, host);
  for (const host of ['127.0.0.1', '::1', 'localhost']) assert.doesNotThrow(() => buildConfig({ web: { host } }), host);
  assert.throws(() => buildConfig({ web: { port: -1 } }), /web\.port/);
  assert.throws(() => buildConfig({ web: { codeMinutes: 0 } }), /codeMinutes/);
  assert.throws(() => buildConfig({ web: { sessionHours: 1000 } }), /sessionHours/);
});

test('unloading the cog closes the port; a port already in use gives a clear error', async () => {
  const r = await makeWebRig();
  try {
    const before = await request(r.port, { path: '/' });
    assert.equal(before.status, 200);
    await r.bot.unloadCog('web');
    // a brand-new connection (not a pooled keep-alive one) must be refused: nothing listens any more
    await assert.rejects(
      new Promise<void>((resolve, reject) => {
        const sock = net.connect(r.port, '127.0.0.1', () => {
          sock.destroy();
          resolve();
        });
        sock.on('error', reject);
      }),
      /ECONNREFUSED/,
    );

    // occupy a port, then ask the dashboard to use it
    const blocker = net.createServer().listen(0, '127.0.0.1');
    await new Promise((res) => blocker.once('listening', res));
    const busy = (blocker.address() as net.AddressInfo).port;
    const h2 = await makeBot({ config: makeConfig({ cogs: ['core'], web: { port: busy } }) });
    try {
      await assert.rejects(h2.bot.loadCog('web'), /port \d+ is already in use/);
    } finally {
      h2.cleanup();
      blocker.close();
    }
  } finally {
    r.cleanup();
  }
});
