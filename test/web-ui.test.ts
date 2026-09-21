import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import type { AudioState } from '../src/core/services.js';
import { until } from './helpers.js';
import { makeWebRig, type WebRig } from './web-helpers.js';

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

interface Page {
  win: JSDOM['window'];
  doc: Document;
  /** The chat commands the page has asked the bot to run, in order. */
  sent: string[];
  q<T extends Element = HTMLElement>(sel: string): T;
  qa(sel: string): Element[];
  close(): void;
}

async function openPage(r: WebRig): Promise<Page> {
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

/** Sign in through the page's own form. */
async function signIn(r: WebRig, page: Page, user = r.alice): Promise<void> {
  const n = r.adapter.sent.length;
  r.adapter.say(user, '!weblogin');
  await until(() => r.adapter.sent.length > n, 2000, 'the code');
  const code = /[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(r.adapter.lastReply())![0];
  (page.q('#code') as HTMLInputElement).value = code;
  (page.q('#login-form') as HTMLFormElement).requestSubmit();
  await until(() => !page.q('#app').hidden, 5000, 'signing in');
}

const click = (page: Page, sel: string) => (page.q(sel) as HTMLElement).click();

test('signed out, you see the sign-in form; a wrong code is explained; the right one opens the dashboard', async () => {
  const r = await makeWebRig();
  const page = await openPage(r);
  try {
    assert.equal(page.q('#login').hidden, false);
    assert.equal(page.q('#app').hidden, true);

    (page.q('#code') as HTMLInputElement).value = 'WRNG-CODE';
    (page.q('#login-form') as HTMLFormElement).requestSubmit();
    await until(() => !page.q('#login-error').hidden, 3000, 'the error');
    assert.match(page.q('#login-error').textContent!, /not valid or has expired/);

    await signIn(r, page);
    assert.equal(page.q('#login').hidden, true);
    assert.equal(page.q('#who-name').textContent, 'Signed in as Alice');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('it shows what is playing, with a progress readout and the queue', async () => {
  const r = await makeWebRig({}, { positionSec: 30, upcoming: [{ kind: 'media', title: 'Next One', url: 'https://x.test/1', durationSec: 100 }, { kind: 'radio', title: 'SomaFM Groove Salad', url: 'https://x.test/2' }] });
  const page = await openPage(r);
  try {
    await signIn(r, page);
    assert.equal(page.q('#now-title').textContent, 'Song One');
    assert.match(page.q('#now-time').textContent!, /0:3[01] \/ 3:20/);
    assert.equal(page.q('#progress-wrap').hidden, false);
    const items = page.qa('.queue-item').map((e) => e.textContent);
    assert.equal(items.length, 2);
    assert.match(items[0]!, /1.*Next One \[1:40\]/);
    assert.match(items[1]!, /2.*SomaFM Groove Salad \[radio\]/);
    assert.equal(page.q('#queue-empty').hidden, true);
    assert.equal(page.q('#stations').children.length >= 3, true, 'radio station buttons');
    assert.match(page.q('#playlists').textContent!, /Friday Night \(3 tracks, by Alice\)/);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('a live radio station shows the song it is announcing', async () => {
  const r = await makeWebRig({}, { current: { id: 2, kind: 'radio', title: 'SomaFM Groove Salad', url: 'https://x.test/r', liveTitle: 'Queen - Bohemian Rhapsody' }, positionSec: 65 });
  const page = await openPage(r);
  try {
    await signIn(r, page);
    assert.equal(page.q('#now-sub').textContent, 'Live radio - now: Queen - Bohemian Rhapsody');
    assert.match(page.q('#now-time').textContent!, /1:0[5-6] \/ live/);
    assert.equal(page.q('#progress-wrap').hidden, true, 'no progress bar for a live stream');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('SAFETY: hostile titles are shown as plain text and inject nothing', async () => {
  const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script>';
  const r = await makeWebRig({}, {
    current: { id: 3, kind: 'media', title: evil, url: 'https://x.test/e', durationSec: 60 },
    upcoming: [{ kind: 'media', title: `Q ${evil}`, url: 'https://x.test/q' }],
  });
  const page = await openPage(r);
  try {
    await signIn(r, page);
    assert.equal(page.q('#now-title').textContent, evil, 'the title appears literally');
    assert.match(page.qa('.queue-item')[0]!.textContent!, /<img src=x/);
    assert.equal(page.qa('#app img').length, 0, 'no image element was created from a title');
    assert.equal(page.qa('#app script').length, 0, 'no script element was created from a title');
    await new Promise((res) => setTimeout(res, 100));
    assert.equal((page.win as unknown as { __pwned?: number }).__pwned, undefined, 'nothing ran');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('every button sends the matching chat command', async () => {
  const r = await makeWebRig({}, { upcoming: [{ kind: 'media', title: 'A', url: 'https://x.test/a', durationSec: 10 }, { kind: 'media', title: 'B', url: 'https://x.test/b', durationSec: 20 }] });
  const page = await openPage(r);
  const expectNext = async (n: number, what: string) => until(() => page.sent.length >= n, 3000, what);
  try {
    await signIn(r, page);
    let n = 0;

    click(page, '#btn-pause'); await expectNext(++n, 'pause');
    click(page, '#btn-skip'); await expectNext(++n, 'skip');
    click(page, '#btn-stop'); await expectNext(++n, 'stop');
    click(page, '#btn-shuffle'); await expectNext(++n, 'shuffle');
    click(page, '#btn-clear'); await expectNext(++n, 'clear');

    const vol = page.q('#volume') as HTMLInputElement;
    vol.value = '30';
    vol.dispatchEvent(new page.win.Event('change', { bubbles: true }));
    await expectNext(++n, 'volume');

    (page.q('#add-input') as HTMLInputElement).value = 'never gonna give you up';
    (page.q('#add-form') as HTMLFormElement).requestSubmit();
    await expectNext(++n, 'play');
    assert.equal((page.q('#add-input') as HTMLInputElement).value, '', 'the box clears after adding');

    (page.qa('#stations button')[1] as HTMLElement).click(); await expectNext(++n, 'radio');
    (page.qa('.queue-item button')[1] as HTMLElement).click(); await expectNext(++n, 'remove');
    (page.qa('.playlist-item button')[0] as HTMLElement).click(); await expectNext(++n, 'playlist');

    assert.deepEqual(page.sent, ['!pause', '!skip', '!stop', '!shuffle', '!clear', '!volume 30', '!play never gonna give you up', '!radio 2', '!remove 2', '!playlist load Friday Night']);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the pause button becomes Resume while paused and sends the right command', async () => {
  const r = await makeWebRig({}, { paused: true });
  const page = await openPage(r);
  try {
    await signIn(r, page);
    assert.equal(page.q('#btn-pause').textContent, 'Resume');
    assert.match(page.q('#now-time').textContent!, /\(paused\)/);
    click(page, '#btn-pause');
    await until(() => page.sent.length === 1, 3000, 'resume');
    assert.equal(page.sent[0], '!resume');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('what the bot answers appears in the messages list, as text', async () => {
  const r = await makeWebRig();
  const page = await openPage(r);
  try {
    await signIn(r, page);
    click(page, '#btn-skip'); // no audio cog in this rig, so the bot answers "not a command I know"
    await until(() => page.qa('#log li').length > 0, 3000, 'a message');
    assert.match(page.q('#log li').textContent!, /not a command I know/);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('when you are not in TeamSpeak, or the bot is not, the page says so', async () => {
  const r = await makeWebRig();
  const page = await openPage(r);
  try {
    await signIn(r, page);
    assert.equal(page.q('#banner').hidden, true);

    r.adapter.userList.splice(r.adapter.userList.indexOf(r.alice), 1);
    click(page, '#btn-skip');
    await until(() => !page.q('#banner').hidden, 4000, 'the banner');
    assert.match(page.q('#banner').textContent!, /You are not connected to TeamSpeak/);

    r.adapter.connected = false;
    click(page, '#btn-skip');
    await until(() => /bot is not connected/.test(page.q('#banner').textContent!), 4000, 'the bot banner');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('signing out returns to the sign-in form and stops asking for state', async () => {
  const r = await makeWebRig();
  const page = await openPage(r);
  try {
    await signIn(r, page);
    click(page, '#logout');
    await until(() => !page.q('#login').hidden, 3000, 'the sign-in form');
    assert.equal(page.q('#app').hidden, true);
    assert.equal(page.q('#who').hidden, true);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the volume label follows the slider while it moves', async () => {
  const r = await makeWebRig({}, { volume: 50 });
  const page = await openPage(r);
  try {
    await signIn(r, page);
    assert.equal(page.q('#volume-label').textContent, '50');
    const vol = page.q('#volume') as HTMLInputElement;
    vol.value = '72';
    vol.dispatchEvent(new page.win.Event('input', { bubbles: true }));
    assert.equal(page.q('#volume-label').textContent, '72');
    assert.equal(page.sent.length, 0, 'nothing is sent until the slider is released');
  } finally {
    page.close();
    r.cleanup();
  }
});

// keep TypeScript honest about the shape the tests feed in
const _shape: Partial<AudioState> = {};
void _shape;
