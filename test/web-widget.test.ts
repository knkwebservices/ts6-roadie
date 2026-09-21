import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { CH, until } from './helpers.js';
import { makeWebRig, request, type WebRig } from './web-helpers.js';

const get = (r: WebRig, path: string, headers: Record<string, string> = {}, host?: string) => request(r.port, { method: 'GET', path, headers, host });
const say = async (r: WebRig, user: Parameters<WebRig['adapter']['say']>[0], text: string): Promise<string> => {
  const n = r.adapter.sent.length;
  r.adapter.say(user, text);
  await until(() => r.adapter.sent.length > n, 10000, `an answer to ${text}`);
  return r.adapter.sent[n]!.text;
};
const rig = (widget: Record<string, unknown> = {}) => makeWebRig({ web: { widget } });

test('the widget does not exist until an admin turns it on', async () => {
  const r = await rig();
  try {
    for (const path of ['/widget', '/widget.json', '/widget.js', '/widget.css', '/widget.json?x=1']) assert.equal((await get(r, path)).status, 404, path);
    assert.equal((await request(r.port, { path: '/widget.json', body: {} })).status, 405, 'read-only, on or off');

    assert.match(await say(r, r.alice, '!widget'), /admins only/i);
    assert.match(await say(r, r.admin, '!widget'), /The public widget is off, and shows names and channels\.\nPage: http:\/\/127\.0\.0\.1:\d+\/widget {2}Data: .*\/widget\.json\nNo website may embed it yet/);
    assert.match(await say(r, r.admin, '!widget on'), /The public widget is on: anyone with the address can see what is playing and who is online, by name\./);
    assert.equal((await get(r, '/widget.json')).status, 200);
    assert.match(await say(r, r.admin, '!widget off'), /is off/);
    assert.equal((await get(r, '/widget.json')).status, 404, 'and off again');
    assert.match(await say(r, r.admin, '!widget sideways'), /Usage/);
    assert.match(await say(r, r.admin, '!widget names maybe'), /Usage/);
    assert.deepEqual(r.bot.state.get('web.widget', null), { enabled: false, showNames: true });
  } finally {
    r.cleanup();
  }
});

test('the data feed shows what is playing and who is where, needs no login, and sets no cookie', async () => {
  const r = await rig({ enabled: true });
  try {
    r.adapter.addUser(7, 'Bob', CH.a, 'uid-bob');
    r.audio.state.current = { id: 3, kind: 'radio', title: 'Rock 96.7', url: 'https://x.test/r', liveTitle: 'Queen - Bohemian Rhapsody' };
    r.audio.state.playing = true;
    const res = await get(r, '/widget.json');
    assert.equal(res.status, 200);
    assert.match(String(res.headers['content-type']), /application\/json/);
    assert.equal(res.headers['x-robots-tag'], 'noindex');
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'no other website may read it unless listed');
    assert.equal(res.headers['cache-control'], 'no-store');
    const d = res.json;
    assert.deepEqual(d.nowPlaying, { title: 'Rock 96.7', live: true, paused: false, song: 'Queen - Bohemian Rhapsody' });
    assert.equal(d.online, 3);
    assert.deepEqual(d.channels.map((c: { name: string }) => c.name), ['Lobby', 'Gaming A'], 'only channels with someone in them');
    assert.deepEqual(d.channels[0], { name: 'Lobby', count: 2, users: ['Alice', 'Admin'] });
    assert.deepEqual(d.channels[1], { name: 'Gaming A', count: 1, users: ['Bob'] });
    assert.ok(Math.abs(d.updatedAt - Date.now()) < 5000);
    assert.doesNotMatch(res.text, /uid-/, 'no unique IDs');
    assert.doesNotMatch(res.text, /https:\/\/x\.test/, 'no addresses of what is playing');
  } finally {
    r.cleanup();
  }
});

test('with nothing playing the feed says so, and a paused song is marked', async () => {
  const r = await rig({ enabled: true });
  try {
    r.audio.state.current = undefined;
    assert.equal((await get(r, '/widget.json')).json.nowPlaying, null);
    r.audio.state.current = { id: 1, kind: 'media', title: 'Song', url: 'https://x.test/s', durationSec: 100 };
    r.audio.state.playing = true;
    r.audio.state.paused = true;
    // (the feed is kept for a few seconds so many visitors cost the bot nothing)
    await say(r, r.admin, '!widget names on');
    assert.deepEqual((await get(r, '/widget.json')).json.nowPlaying, { title: 'Song', live: false, paused: true });
  } finally {
    r.cleanup();
  }
});

test('names can be switched off (counts only), and people can hide themselves', async () => {
  const r = await rig({ enabled: true });
  try {
    r.adapter.addUser(7, 'Bob', CH.a, 'uid-bob');
    assert.match(await say(r, r.alice, '!hideme'), /can show in the public widget/);
    assert.match(await say(r, r.alice, '!hideme on'), /will not be shown in the public widget \(you still count in the total\)/);
    let d = (await get(r, '/widget.json')).json;
    assert.deepEqual(d.channels[0], { name: 'Lobby', count: 2, users: ['Admin'] }, 'Alice is counted but not named');
    assert.equal(d.online, 3);
    assert.match(await say(r, r.alice, '!hideme'), /is hidden from the public widget/);
    assert.match(await say(r, r.admin, '!widget'), /1 person has hidden their name with !hideme/);
    assert.match(await say(r, r.alice, '!hideme sideways'), /Usage/);

    assert.match(await say(r, r.admin, '!widget names off'), /only how many people are in each channel/);
    d = (await get(r, '/widget.json')).json;
    assert.deepEqual(d.channels, [{ name: 'Lobby', count: 2 }, { name: 'Gaming A', count: 1 }]);
    assert.equal(JSON.stringify(d).includes('Bob'), false, 'no names at all');

    await say(r, r.admin, '!widget names on');
    assert.match(await say(r, r.alice, '!hideme off'), /can show in the public widget again/);
    d = (await get(r, '/widget.json')).json;
    assert.deepEqual(d.channels[0]!.users, ['Alice', 'Admin']);
    assert.deepEqual(r.bot.state.get('web.widgetHidden', null), []);
  } finally {
    r.cleanup();
  }
});

test('the feed is kept for a few seconds, and changing a setting refreshes it at once', async () => {
  const r = await rig({ enabled: true });
  try {
    const first = (await get(r, '/widget.json')).json;
    r.adapter.addUser(9, 'Newcomer', CH.home, 'uid-new');
    const second = (await get(r, '/widget.json')).json;
    assert.equal(second.updatedAt, first.updatedAt, 'the same answer within a few seconds');
    assert.equal(second.online, first.online);
    await say(r, r.alice, '!hideme on');
    const third = (await get(r, '/widget.json')).json;
    assert.equal(third.online, first.online + 1, 'a setting changed, so it was worked out again');
  } finally {
    r.cleanup();
  }
});

test('other websites can read the feed only if they are listed; the rest of the dashboard never opens up', async () => {
  const listed = 'https://tgscgaming.com';
  const r = await rig({ enabled: true, origins: [listed] });
  try {
    const ok = await get(r, '/widget.json', { Origin: listed });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['access-control-allow-origin'], listed);
    assert.equal(ok.headers['vary'], 'Origin');
    const other = await get(r, '/widget.json', { Origin: 'https://evil.example' });
    assert.equal(other.status, 200);
    assert.equal(other.headers['access-control-allow-origin'], undefined, 'not listed: the browser will not let that site read it');

    // the dashboard itself is as closed as ever, even to the listed website
    assert.equal((await get(r, '/api/state', { Origin: listed })).status, 403);
    const cookie = await r.login(r.admin);
    assert.equal((await request(r.port, { path: '/api/state', method: 'GET', headers: { Cookie: cookie, Origin: listed } })).status, 403);
    assert.equal((await get(r, '/widget.json', {}, 'evil.example.com')).status, 403, 'a wrong Host name is still refused');
  } finally {
    r.cleanup();
  }
});

test('the widget page can be framed only by listed websites, and its files are plain', async () => {
  const framed = await rig({ enabled: true, origins: ['https://tgscgaming.com', 'https://www.tgscgaming.com'] });
  try {
    const page = await get(framed, '/widget');
    assert.equal(page.status, 200);
    assert.match(String(page.headers['content-type']), /text\/html/);
    assert.match(String(page.headers['content-security-policy']), /frame-ancestors https:\/\/tgscgaming\.com https:\/\/www\.tgscgaming\.com$/);
    assert.match(String(page.headers['content-security-policy']), /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers['x-frame-options'], undefined, 'the CSP decides who may frame it');
    assert.equal(page.headers['x-robots-tag'], 'noindex');
    assert.doesNotMatch(page.text, /<script(?![^>]*\bsrc=)/i, 'no inline script');
    assert.doesNotMatch(page.text, /\son[a-z]+\s*=/i, 'no inline handlers');
    const js = await get(framed, '/widget.js');
    assert.match(String(js.headers['content-type']), /javascript/);
    assert.doesNotMatch(js.text, /innerHTML|outerHTML|document\.write|eval\(/);
    assert.match(String((await get(framed, '/widget.css')).headers['content-type']), /text\/css/);
  } finally {
    framed.cleanup();
  }
  const alone = await rig({ enabled: true });
  try {
    const page = await get(alone, '/widget');
    assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'$/);
    assert.equal(page.headers['x-frame-options'], 'DENY');
  } finally {
    alone.cleanup();
  }
});

test('each visitor gets a fair share of requests', async () => {
  const r = await rig({ enabled: true });
  try {
    const codes: number[] = [];
    for (let i = 0; i < 63; i++) codes.push((await get(r, '/widget.json')).status);
    assert.equal(codes.filter((c) => c === 200).length, 60);
    assert.deepEqual(codes.slice(60), [429, 429, 429]);
    assert.equal((await get(r, '/widget.json', { 'X-Forwarded-For': '203.0.113.9' })).status, 200, 'somebody else is not affected');
  } finally {
    r.cleanup();
  }
});

// ---- the page, in a simulated browser ---------------------------------------------------------

async function openWidget(r: WebRig): Promise<JSDOM['window']> {
  const dom = await JSDOM.fromURL(`http://127.0.0.1:${r.port}/widget`, {
    runScripts: 'dangerously',
    resources: 'usable',
    pretendToBeVisual: true,
    beforeParse(w) {
      // the page asks for /widget.json: give it a fetch that talks to the real server, as a browser would
      (w as unknown as { fetch: unknown }).fetch = (url: string, opts?: RequestInit) => fetch(new URL(url, `http://127.0.0.1:${r.port}/`), opts);
    },
  });
  return dom.window;
}

test('the widget page shows what is playing and who is online, as plain text', async () => {
  const evil = '<img src=x onerror="window.pwned=1">';
  const r = await rig({ enabled: true });
  try {
    r.adapter.addUser(7, evil, CH.a, 'uid-evil');
    r.adapter.addUser(8, 'Hidden One', CH.a, 'uid-h');
    await say(r, r.alice, '!hideme on');
    await say(r, r.admin, '!widget on');
    r.audio.state.current = { id: 3, kind: 'radio', title: evil, url: 'https://x.test/r', liveTitle: 'A Song' };
    r.audio.state.playing = true;
    const w = await openWidget(r);
    try {
      const doc = w.document;
      await until(() => doc.getElementById('count')!.textContent === '(4)', 10000, 'the data to load');
      assert.equal(doc.getElementById('np')!.textContent, evil);
      assert.equal(doc.getElementById('np-sub')!.textContent, 'Live radio - now: A Song');
      const rows = [...doc.querySelectorAll('#channels li')].map((li) => li.textContent);
      assert.deepEqual(rows, ['Lobby  -  Admin and 1 more', `Gaming A  -  ${evil}, Hidden One`]);
      assert.equal(doc.getElementById('empty')!.hidden, true);
      assert.equal(doc.querySelectorAll('img').length, 0, 'nothing became page code');
      assert.equal((w as unknown as { pwned?: number }).pwned, undefined);
    } finally {
      w.close();
    }
  } finally {
    r.cleanup();
  }
});

test('the widget page says when it is switched off, and when nobody is around', async () => {
  const r = await rig();
  try {
    // the page files are 404 while it is off, so the page itself cannot even load
    assert.equal((await get(r, '/widget')).status, 404);
    await say(r, r.admin, '!widget on');
    r.adapter.userList.length = 0;
    r.audio.state.current = undefined;
    const w = await openWidget(r);
    try {
      const doc = w.document;
      await until(() => doc.getElementById('count')!.textContent === '(0)', 10000, 'the data to load');
      assert.equal(doc.getElementById('np')!.textContent, 'Nothing is playing.');
      assert.equal(doc.getElementById('empty')!.hidden, false);
      assert.equal(doc.querySelectorAll('#channels li').length, 0);
    } finally {
      w.close();
    }
  } finally {
    r.cleanup();
  }
});

test('the widget settings are checked when the config is read', async () => {
  const { buildConfig } = await import('../src/config.js');
  assert.deepEqual(buildConfig({}).web.widget, { enabled: false, showNames: true, origins: [] });
  for (const bad of ['tgscgaming.com', 'https://tgscgaming.com/', 'https://tgscgaming.com/path', 'ftp://tgscgaming.com', 'https://u:p@tgscgaming.com', 5]) {
    assert.throws(() => buildConfig({ web: { widget: { origins: [bad] } } }), /web\.widget/, String(bad));
  }
  assert.throws(() => buildConfig({ web: { widget: { enabled: 'yes' } } }), /web\.widget/);
  assert.doesNotThrow(() => buildConfig({ web: { widget: { enabled: true, showNames: false, origins: ['https://tgscgaming.com', 'http://localhost:3000'] } } }));
});
