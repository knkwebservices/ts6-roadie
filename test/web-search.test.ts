import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SourceError } from '../src/cogs/audio/sources.js';
import type { HistoryEntry } from '../src/core/services.js';
import { until } from './helpers.js';
import { makeWebRig, openPage, request, type Page, type WebRig } from './web-helpers.js';

async function signIn(r: WebRig, page: Page, user = r.alice): Promise<void> {
  const n = r.adapter.sent.length;
  r.adapter.say(user, '!weblogin');
  await until(() => r.adapter.sent.length > n, 2000, 'the code');
  (page.q('#code') as HTMLInputElement).value = /[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(r.adapter.lastReply())![0];
  (page.q('#login-form') as HTMLFormElement).requestSubmit();
  await until(() => !page.q('#app').hidden, 5000, 'signing in');
}
const click = (page: Page, sel: string) => (page.q(sel) as HTMLElement).click();
const named = (page: Page, label: string) => {
  const b = page.qa('button').find((x) => x.getAttribute('aria-label') === label || x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};
const entry = (id: number, over: Partial<HistoryEntry> = {}): HistoryEntry => ({ id, at: Date.now() - id * 60_000, kind: 'media', title: `Song ${id}`, url: `https://x.test/${id}`, durationSec: 100 + id, byName: 'Alice', ...over });

// ---- the requests ----------------------------------------------------------------------

test('/api/search needs a session and words, and hands back what the audio cog found', async () => {
  const r = await makeWebRig();
  try {
    assert.equal((await request(r.port, { path: '/api/search', body: { q: 'x' } })).status, 401);
    const cookie = await r.login(r.alice);
    assert.equal((await r.as(cookie, '/api/search', {})).status, 400);
    assert.equal((await r.as(cookie, '/api/search', { q: '   ' })).status, 400);
    assert.equal((await r.as(cookie, '/api/search', { q: 'x'.repeat(201) })).status, 400);

    let asked = '';
    r.audio.setSearch(async (q) => ((asked = q), [{ title: 'Found One', url: 'https://www.youtube.com/watch?v=a', durationSec: 60, by: 'Chan' }]));
    const ok = await r.as(cookie, '/api/search', { q: '  lofi  ' });
    assert.equal(ok.status, 200);
    assert.equal(asked, 'lofi', 'the words are trimmed');
    assert.deepEqual(ok.json, { ok: true, results: [{ title: 'Found One', url: 'https://www.youtube.com/watch?v=a', durationSec: 60, by: 'Chan' }] });
  } finally {
    r.cleanup();
  }
});

test('search errors: a safe message is passed on, anything else is hidden, and blocked people are refused', async () => {
  const r = await makeWebRig();
  try {
    const cookie = await r.login(r.alice);
    r.audio.setSearch(async () => {
      throw new SourceError('YouTube is asking the server to prove it is not a bot.');
    });
    const safe = await r.as(cookie, '/api/search', { q: 'a' });
    assert.equal(safe.status, 400);
    assert.match(safe.json.error, /not a bot/);

    r.audio.setSearch(async () => {
      throw new Error('spawn C:\\secret\\path\\yt-dlp.exe EACCES');
    });
    const hidden = await r.as(cookie, '/api/search', { q: 'a' });
    assert.equal(hidden.status, 400);
    assert.equal(hidden.json.error, 'That search did not work.', 'internals are not shown');
    assert.doesNotMatch(hidden.text, /secret/);

    r.audio.blockedUids.add('uid-alice');
    const blocked = await r.as(cookie, '/api/search', { q: 'a' });
    assert.equal(blocked.status, 403);
    assert.match(blocked.json.error, /blocked/);
  } finally {
    r.cleanup();
  }
});

test('searching is limited, because each one starts yt-dlp', async () => {
  const r = await makeWebRig();
  try {
    const cookie = await r.login(r.alice);
    r.audio.setSearch(async () => []);
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await r.as(cookie, '/api/search', { q: 'x' })).status);
    assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  } finally {
    r.cleanup();
  }
});

test('/api/history needs a session and lists the latest entries', async () => {
  const r = await makeWebRig();
  try {
    assert.equal((await request(r.port, { path: '/api/history' })).status, 401);
    const cookie = await r.login(r.alice);
    assert.deepEqual((await r.as(cookie, '/api/history')).json, { history: [] });
    r.audio.historyList.push(entry(2), entry(1));
    const res = await r.as(cookie, '/api/history');
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.history.map((e: HistoryEntry) => e.id), [2, 1]);
    assert.equal((await r.as(cookie, '/api/history', {})).status, 405, 'a GET route');
  } finally {
    r.cleanup();
  }
});

// ---- the page ------------------------------------------------------------------------------

test('searching from the page shows results you can add, and explains problems', async () => {
  const r = await makeWebRig();
  const page = await openPage(r);
  try {
    await signIn(r, page);
    r.audio.setSearch(async (q) => [1, 2].map((n) => ({ title: `${q} result ${n}`, url: `https://www.youtube.com/watch?v=v${n}`, durationSec: 60 * n, by: `Chan ${n}` })));

    click(page, '#btn-search'); // nothing typed: nothing happens
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(page.qa('#search-results li').length, 0);
    assert.equal(page.q('#search-note').textContent, '');

    (page.q('#add-input') as HTMLInputElement).value = 'lofi';
    click(page, '#btn-search');
    await until(() => page.qa('#search-results li').length === 2, 3000, 'the results');
    assert.equal(page.q('#search-note').textContent, 'Results for "lofi":');
    assert.equal(page.qa('#search-results .t')[0]!.textContent, 'lofi result 1 [1:00]  -  Chan 1');
    assert.equal((page.q('#add-input') as HTMLInputElement).value, 'lofi', 'the box keeps your words');

    named(page, 'Add lofi result 2').click();
    await until(() => page.sent.length === 1, 2000, 'the add');
    assert.equal(page.sent[0], '!play https://www.youtube.com/watch?v=v2');
    assert.equal(page.qa('#search-results li').length, 2, 'the results stay so you can add more');

    r.audio.setSearch(async () => {
      throw new SourceError('I could not find anything for that.');
    });
    click(page, '#btn-search');
    await until(() => page.qa('#search-results li').length === 0 && /could not find/.test(page.q('#search-note').textContent!), 3000, 'the message');
    assert.match(page.q('#search-note').className, /error/);

    r.audio.setSearch(async () => []);
    click(page, '#btn-search');
    await until(() => page.q('#search-note').textContent === 'Nothing found.', 3000, 'nothing found');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the Recently played card lists entries, plays one again, and refreshes when a new track starts', async () => {
  const r = await makeWebRig();
  r.audio.historyList.push(entry(2, { kind: 'radio', title: 'Groove Salad', durationSec: undefined, byName: 'Auto-DJ' }), entry(1));
  const page = await openPage(r);
  try {
    await signIn(r, page);
    await until(() => page.qa('#history li').length === 2, 3000, 'the list');
    const texts = page.qa('#history .t').map((t) => t.textContent);
    assert.match(texts[0]!, /^Groove Salad \[radio\]  -  Auto-DJ, 2 min ago$/);
    assert.match(texts[1]!, /^Song 1 \[1:41\]  -  Alice, 1 min ago$/);
    assert.equal(page.q('#history-empty').hidden, true);

    named(page, 'Play Song 1 again').click();
    named(page, 'Play Groove Salad again').click();
    await until(() => page.sent.length === 2, 2000, 'both');
    assert.deepEqual(page.sent, ['!again 1', '!again 2']);

    // a different track starting is the cue to fetch the list again
    r.audio.historyList.unshift(entry(3, { title: 'Brand New' }));
    r.audio.state.current = { id: 77, kind: 'media', title: 'Brand New', url: 'https://x.test/3', durationSec: 50 };
    r.audio.state.playing = true;
    await until(() => page.qa('#history li').length === 3 && page.qa('#history .t')[0]!.textContent!.startsWith('Brand New'), 6000, 'the refreshed list');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('with nothing played yet the card says so', async () => {
  const r = await makeWebRig();
  const page = await openPage(r);
  try {
    await signIn(r, page);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(page.qa('#history li').length, 0);
    assert.equal(page.q('#history-empty').hidden, false);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the Tools card shows versions and the last YouTube check, and its buttons send commands', async () => {
  const r = await makeWebRig();
  r.audio.tools.youtube = { ok: true, message: 'YouTube works (found "Me at the zoo")', at: Date.now() - 5 * 60_000 };
  const page = await openPage(r);
  const asked: string[] = [];
  page.win.confirm = (m?: string) => (asked.push(String(m)), false);
  try {
    await signIn(r, page, r.admin);
    click(page, '#tab-btn-admin');
    await until(() => /yt-dlp 2026\.01\.01/.test(page.q('#tools-line').textContent!), 4000, 'the Tools card');
    assert.equal(page.q('#tools-line').textContent, 'yt-dlp 2026.01.01  |  ffmpeg 7.0');
    assert.equal(page.q('#tools-youtube').textContent, 'YouTube: OK, checked 5 min ago  -  YouTube works (found "Me at the zoo")');
    assert.doesNotMatch(page.q('#tools-youtube').className, /error/);

    click(page, '#btn-ytcheck');
    await until(() => page.sent.length === 1, 2000, 'the check');
    assert.equal(page.sent[0], '!ytcheck');

    click(page, '#btn-ytupdate'); // says no
    await new Promise((res) => setTimeout(res, 100));
    assert.equal(page.sent.length, 1);
    assert.match(asked[0]!, /Update yt-dlp now/);
    page.win.confirm = () => true;
    click(page, '#btn-ytupdate');
    await until(() => page.sent.length === 2, 2000, 'the update');
    assert.equal(page.sent[1], '!ytupdate');

    // a problem is shown as one, and the update button waits while an update runs
    r.audio.tools.youtube = { ok: false, message: 'YouTube is asking for a cookies file.', at: Date.now() };
    r.audio.tools.updating = true;
    await until(() => /PROBLEM/.test(page.q('#tools-youtube').textContent!), 8000, 'the problem to show');
    assert.match(page.q('#tools-youtube').className, /error/);
    assert.match(page.q('#tools-line').textContent!, /updating now/);
    assert.equal((page.q('#btn-ytupdate') as HTMLButtonElement).disabled, true);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('SAFETY: search results, history and tool messages are shown as text, never as page code', async () => {
  const evil = '<img src=x onerror="window.pwned=1">';
  const r = await makeWebRig();
  r.audio.historyList.push(entry(1, { title: evil, byName: evil }));
  r.audio.tools.youtube = { ok: false, message: evil, at: Date.now() };
  r.audio.setSearch(async () => [{ title: evil, url: 'https://www.youtube.com/watch?v=x', by: evil }]);
  const page = await openPage(r);
  try {
    await signIn(r, page, r.admin);
    (page.q('#add-input') as HTMLInputElement).value = 'x';
    click(page, '#btn-search');
    await until(() => page.qa('#search-results li').length === 1, 3000, 'the result');
    await until(() => page.qa('#history li').length === 1, 3000, 'the history');
    click(page, '#tab-btn-admin');
    await until(() => page.q('#tools-youtube').textContent!.includes(evil), 4000, 'the tools card');
    assert.equal(page.qa('img').length, 0);
    assert.equal((page.win as unknown as { pwned?: number }).pwned, undefined);
    assert.ok(page.q('#search-results').textContent!.includes(evil));
    assert.ok(page.q('#history').textContent!.includes(evil));
  } finally {
    page.close();
    r.cleanup();
  }
});
