import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CH, until } from './helpers.js';
import { makeWebRig, openPage, type Page, type WebRig } from './web-helpers.js';

async function signIn(r: WebRig, page: Page, user = r.admin): Promise<void> {
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
const choose = (page: Page, sel: string, value: string) => {
  const el = page.q<HTMLSelectElement>(sel);
  el.value = value;
  el.dispatchEvent(new page.win.Event('change', { bubbles: true }));
};
const openAdmin = async (page: Page, ready: string) => {
  click(page, '#tab-btn-admin');
  await until(() => page.qa(ready).length > 0, 3000, `the Admin tab (${ready})`);
};

test('the Player tab shows repeat, lets you move queued tracks, and jumps when you click the progress bar', async () => {
  const r = await makeWebRig({}, {
    repeat: 'track',
    positionSec: 20,
    current: { id: 1, kind: 'media', title: 'Song One', url: 'https://x.test/1', durationSec: 200 },
    upcoming: [{ kind: 'media', title: 'A', url: 'https://x.test/a', durationSec: 10 }, { kind: 'media', title: 'B', url: 'https://x.test/b', durationSec: 20 }],
  });
  const page = await openPage(r);
  try {
    await signIn(r, page, r.alice);
    assert.equal(page.q('#btn-repeat').textContent, 'Repeat: track');
    click(page, '#btn-repeat');
    await until(() => page.sent.length === 1, 2000, 'repeat');
    assert.equal(page.sent[0], '!repeat queue', 'track goes on to queue');

    r.audio.state.repeat = 'queue';
    await until(() => page.q('#btn-repeat').textContent === 'Repeat: queue', 4000, 'the label to follow');
    click(page, '#btn-repeat');
    await until(() => page.sent.length === 2, 2000, 'repeat');
    assert.equal(page.sent[1], '!repeat off', 'queue goes round to off');

    assert.equal((named(page, 'Move A up') as HTMLButtonElement).disabled, true, 'the first cannot go up');
    assert.equal((named(page, 'Move B down') as HTMLButtonElement).disabled, true, 'the last cannot go down');
    named(page, 'Move A down').click();
    named(page, 'Move B up').click();
    await until(() => page.sent.length === 4, 2000, 'both moves');
    assert.deepEqual(page.sent.slice(2), ['!move 1 2', '!move 2 1']);

    // clicking a third of the way along the bar asks for the matching time
    const wrap = page.q('#progress-wrap');
    wrap.getBoundingClientRect = () => ({ left: 100, width: 300, top: 0, right: 400, bottom: 6, height: 6, x: 100, y: 0, toJSON() {} }) as DOMRect;
    wrap.dispatchEvent(new page.win.MouseEvent('click', { bubbles: true, clientX: 200 }));
    await until(() => page.sent.length === 5, 2000, 'seek');
    assert.equal(page.sent[4], '!seek 66');
    wrap.dispatchEvent(new page.win.MouseEvent('click', { bubbles: true, clientX: 9999 }));
    await until(() => page.sent.length === 6, 2000, 'seek to the end');
    assert.equal(page.sent[5], '!seek 199', 'never past the end');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('live radio cannot be clicked to seek, and an Auto-DJ pick is labelled', async () => {
  const r = await makeWebRig({}, { current: { id: 2, kind: 'radio', title: 'SomaFM Groove Salad', url: 'https://x.test/r', auto: true }, positionSec: 5 });
  const page = await openPage(r);
  try {
    await signIn(r, page, r.alice);
    assert.match(page.q('#now-sub').textContent!, /^Auto-DJ\s+\|\s+Live radio/);
    const wrap = page.q('#progress-wrap');
    wrap.getBoundingClientRect = () => ({ left: 0, width: 100, top: 0, right: 100, bottom: 6, height: 6, x: 0, y: 0, toJSON() {} }) as DOMRect;
    wrap.dispatchEvent(new page.win.MouseEvent('click', { bubbles: true, clientX: 50 }));
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(page.sent, []);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the Auto-DJ and 24/7 card shows the state and sends the matching commands', async () => {
  const r = await makeWebRig({}, { autoDj: { enabled: false, source: '', sourceName: '' }, stay: false });
  const page = await openPage(r);
  try {
    await signIn(r, page);
    await openAdmin(page, '#autodj-source option');
    assert.match(page.q('#autodj-status').textContent!, /Auto-DJ is off.*none chosen yet.*24\/7 mode is off/);
    assert.equal((page.q('#btn-autodj') as HTMLButtonElement).disabled, true, 'cannot turn on with no source');
    const options = page.qa('#autodj-source option').map((o) => [o.getAttribute('value'), o.textContent]);
    assert.deepEqual(options[0], ['radio:groovesalad', 'Radio: SomaFM Groove Salad']);
    assert.deepEqual(options.at(-1), ['playlist:Friday Night', 'Playlist: Friday Night']);

    choose(page, '#autodj-source', 'playlist:Friday Night');
    click(page, '#btn-autodj-set');
    await until(() => page.sent.length === 1, 2000, 'source');
    assert.equal(page.sent[0], '!autodj source playlist Friday Night');
    choose(page, '#autodj-source', 'radio:defcon');
    click(page, '#btn-autodj-set');
    await until(() => page.sent.length === 2, 2000, 'source');
    assert.equal(page.sent[1], '!autodj source radio defcon');

    click(page, '#btn-stay');
    await until(() => page.sent.length === 3, 2000, 'stay');
    assert.equal(page.sent[2], '!stay on');

    // now the bot reports it on: the card and the buttons follow
    r.audio.state.autoDj = { enabled: true, source: 'radio:defcon', sourceName: 'SomaFM DEF CON Radio' };
    r.audio.state.stay = true;
    await until(() => /Auto-DJ is ON.*SomaFM DEF CON Radio.*24\/7 mode is ON/.test(page.q('#autodj-status').textContent!), 8000, 'the card to update');
    assert.equal(page.q('#btn-autodj').textContent, 'Turn Auto-DJ off');
    assert.equal(page.q('#btn-stay').textContent, 'Turn 24/7 mode off');
    assert.equal(page.q<HTMLSelectElement>('#autodj-source').value, 'radio:defcon', 'the drop-down shows the bot\'s source');
    click(page, '#btn-autodj');
    click(page, '#btn-stay');
    await until(() => page.sent.length === 5, 2000, 'both');
    assert.deepEqual(page.sent.slice(3), ['!autodj off', '!stay off']);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the Troll control card lists who and what is blocked, and blocks and unblocks through chat commands', async () => {
  const r = await makeWebRig();
  r.adapter.addUser(7, 'Bob', CH.a, 'uid-bob');
  r.audio.troll = { users: [{ name: 'Mallory', until: Date.now() + 10 * 60_000 }, { name: 'Trudy' }], words: ['earrape'], maxQueuePerUser: 3 };
  const page = await openPage(r);
  try {
    await signIn(r, page);
    await openAdmin(page, '#blocked-users li');
    assert.match(page.q('#troll-limit').textContent!, /Each person may have 3 tracks/);
    const users = page.qa('#blocked-users li').map((li) => li.textContent);
    assert.match(users[0]!, /Mallory\s+\((9|10) min left\)/);
    assert.match(users[1]!, /^Trudy/);
    assert.equal(page.q('#blocked-users-empty').hidden, true);
    assert.equal(page.qa('#blocked-words li').length, 1);

    named(page, 'Unblock Mallory').click();
    named(page, 'Allow the word earrape').click();
    await until(() => page.sent.length === 2, 2000, 'unblocks');
    assert.deepEqual(page.sent, ['!unblock Mallory', '!unblockword earrape']);

    // the list of people to block: everyone online, by client number
    const choices = page.qa('#block-user option').map((o) => [o.getAttribute('value'), o.textContent]);
    assert.ok(choices.some(([v, t]) => v === '7' && /Bob\s+\(Gaming A\)/.test(t!)), JSON.stringify(choices));
    choose(page, '#block-user', '7');
    choose(page, '#block-minutes', '60');
    click(page, '#btn-block');
    await until(() => page.sent.length === 3, 2000, 'block');
    assert.equal(page.sent[2], '!block #7 60');
    choose(page, '#block-minutes', '0');
    click(page, '#btn-block');
    await until(() => page.sent.length === 4, 2000, 'block');
    assert.equal(page.sent[3], '!block #7', 'no minutes means until unblocked');

    (page.q('#word-input') as HTMLInputElement).value = '  spam  ';
    (page.q('#word-form') as HTMLFormElement).requestSubmit();
    await until(() => page.sent.length === 5, 2000, 'word');
    assert.equal(page.sent[4], '!blockword spam');
    assert.equal((page.q('#word-input') as HTMLInputElement).value, '', 'the box clears');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('with nothing blocked and nobody online the card says so and has nothing to click', async () => {
  const r = await makeWebRig();
  r.adapter.userList.length = 0;
  const page = await openPage(r);
  try {
    r.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin'); // to sign in; then leave again
    await signIn(r, page);
    r.adapter.userList.length = 0;
    await openAdmin(page, '#block-user option');
    await until(() => page.q('#block-user').textContent!.includes('Nobody is online'), 6000, 'the empty list');
    assert.equal((page.q('#btn-block') as HTMLButtonElement).disabled, true);
    assert.match(page.q('#troll-limit').textContent!, /no limit on how many tracks/);
    assert.equal(page.q('#blocked-users-empty').hidden, false);
    assert.equal(page.q('#blocked-words-empty').hidden, false);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('SAFETY: blocked names and words, and source names, are shown as text and never as page code', async () => {
  const evil = '<img src=x onerror="window.pwned=1">';
  const r = await makeWebRig();
  r.audio.troll = { users: [{ name: evil }], words: [evil], maxQueuePerUser: 0 };
  r.adapter.addUser(9, evil, CH.a, 'uid-evil');
  const page = await openPage(r);
  try {
    await signIn(r, page);
    await openAdmin(page, '#blocked-users li');
    assert.equal(page.qa('#tab-admin img').length, 0);
    assert.equal((page.win as unknown as { pwned?: number }).pwned, undefined);
    assert.ok(page.q('#blocked-users').textContent!.includes(evil));
    assert.ok(page.q('#block-user').textContent!.includes(evil));
  } finally {
    page.close();
    r.cleanup();
  }
});
