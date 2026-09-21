import assert from 'node:assert/strict';
import { test } from 'node:test';
import { until } from './helpers.js';
import { makeWebRig, openPage, type Page, type WebRig } from './web-helpers.js';

async function signIn(r: WebRig, page: Page, user = r.admin): Promise<void> {
  const n = r.adapter.sent.length;
  r.adapter.say(user, '!weblogin');
  await until(() => r.adapter.sent.length > n, 10000, 'the code');
  (page.q('#code') as HTMLInputElement).value = /[A-Z2-9]{4}-[A-Z2-9]{4}/.exec(r.adapter.lastReply())![0];
  (page.q('#login-form') as HTMLFormElement).requestSubmit();
  await until(() => !page.q('#app').hidden, 10000, 'signing in');
}
const click = (page: Page, sel: string) => (page.q(sel) as HTMLElement).click();
const openAdmin = async (page: Page): Promise<void> => {
  click(page, '#tab-btn-admin');
  await until(() => page.q('#afk-status').textContent !== '' && page.q('#widget-status').textContent !== '', 10000, 'the Community card');
};
const withCommunity = (over: Record<string, unknown> = {}) => makeWebRig({ cogs: ['core', 'web', 'community'], ...over });

test('the Community card shows the AFK mover, the welcome message and the widget', async () => {
  const r = await withCommunity();
  r.adapter.chans.push({ id: 20n, name: 'AFK Room', parentId: 0n });
  r.bot.state.set('community.moved', { 'uid-zed': { name: 'Zed', from: '11', at: Date.now() - 5 * 60_000 } });
  const page = await openPage(r);
  try {
    await signIn(r, page);
    await openAdmin(page);
    assert.equal(page.q('#afk-status').textContent, 'AFK mover is off  |  moves people after 30 minutes away, muted or idle to "AFK Room"  |  in there now: Zed (5 min ago)');
    assert.equal(page.q('#btn-afk').textContent, 'Turn AFK mover on');
    assert.equal((page.q('#afk-minutes') as HTMLInputElement).value, '30');
    assert.match(page.q('#welcome-status').textContent!, /The welcome message is off\. Everyone who joins gets this as a private message/);
    assert.equal((page.q('#welcome-text') as HTMLTextAreaElement).value, "Welcome, {name}! I'm the music bot. Send me a private message saying !help to see what I can do.");
    assert.equal(page.q('#btn-welcome').textContent, 'Turn welcome message on');
    assert.match(page.q('#widget-status').textContent!, /^The public widget is off, showing names and channels\.  Page: http:\/\/127\.0\.0\.1:\d+\/widget  \|  no website may embed it yet/);
    assert.equal(page.q('#btn-widget').textContent, 'Turn widget on');
    assert.equal(page.q('#btn-widget-names').textContent, 'Show only counts');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('a channel that does not exist is pointed out', async () => {
  const r = await withCommunity();
  const page = await openPage(r);
  try {
    await signIn(r, page);
    await openAdmin(page);
    assert.match(page.q('#afk-status').textContent!, /to "AFK Room"  \(that channel does not exist!\)/);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the buttons switch things on and off for real, and the card follows', async () => {
  const r = await withCommunity();
  r.adapter.chans.push({ id: 20n, name: 'AFK Room', parentId: 0n });
  const page = await openPage(r);
  try {
    await signIn(r, page);
    await openAdmin(page);

    click(page, '#btn-afk');
    await until(() => /AFK mover is ON/.test(page.q('#afk-status').textContent!), 10000, 'the AFK mover to turn on');
    assert.equal(page.q('#btn-afk').textContent, 'Turn AFK mover off');
    assert.equal(r.bot.state.get<{ enabled: boolean }>('community.afk', { enabled: false }).enabled, true);

    click(page, '#btn-welcome');
    await until(() => /welcome message is ON/.test(page.q('#welcome-status').textContent!), 10000, 'the welcome message to turn on');
    click(page, '#btn-widget');
    await until(() => /widget is ON/.test(page.q('#widget-status').textContent!), 10000, 'the widget to turn on');
    assert.equal(page.q('#btn-widget').textContent, 'Turn widget off');
    click(page, '#btn-widget-names');
    await until(() => /only how many are in each channel/.test(page.q('#widget-status').textContent!), 10000, 'the names to switch off');
    assert.equal(page.q('#btn-widget-names').textContent, 'Show names');

    click(page, '#btn-afk');
    await until(() => /AFK mover is off/.test(page.q('#afk-status').textContent!), 10000, 'the AFK mover to turn off');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the AFK minutes are sent only when they make sense', async () => {
  const r = await withCommunity();
  const page = await openPage(r);
  try {
    await signIn(r, page);
    await openAdmin(page);
    const box = page.q('#afk-minutes') as HTMLInputElement;
    for (const bad of ['0', '', '2000', 'abc']) {
      box.value = bad;
      click(page, '#btn-afk-minutes');
    }
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(page.sent.filter((c) => c.startsWith('!afk minutes')), []);
    box.value = '45';
    box.dispatchEvent(new page.win.Event('input', { bubbles: true }));
    click(page, '#btn-afk-minutes');
    await until(() => page.sent.includes('!afk minutes 45'), 10000, 'the change');
    await until(() => (r.bot.state.get('community.afk', { minutes: 0 }) as { minutes: number }).minutes === 45, 10000, 'it to be kept');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the welcome text is edited without being overwritten by refreshes, saved, and tested', async () => {
  const r = await withCommunity();
  const page = await openPage(r);
  try {
    await signIn(r, page);
    await openAdmin(page);
    const box = page.q('#welcome-text') as HTMLTextAreaElement;
    const save = page.q('#btn-welcome-save') as HTMLButtonElement;
    assert.equal(save.disabled, true, 'nothing to save yet');

    box.value = 'Hi {name}, read the rules in the Lobby!';
    box.dispatchEvent(new page.win.Event('input', { bubbles: true }));
    assert.equal(save.disabled, false);
    click(page, '#btn-status'); // any action redraws the Admin tab
    await until(() => page.sent.includes('!status'), 10000, 'the redraw');
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(box.value, 'Hi {name}, read the rules in the Lobby!', 'the redraw did not throw the edit away');

    click(page, '#btn-welcome-save');
    await until(() => page.sent.includes('!welcome set Hi {name}, read the rules in the Lobby!'), 10000, 'the save');
    await until(() => (r.bot.state.get('community.welcome', { message: '' }) as { message: string }).message === 'Hi {name}, read the rules in the Lobby!', 10000, 'it to be kept');
    assert.equal(save.disabled, true);

    click(page, '#btn-welcome-test');
    await until(() => page.sent.includes('!welcome test'), 10000, 'the test');
    await until(() => page.q('#admin-output').textContent === 'Hi Admin, read the rules in the Lobby!', 10000, 'the test message to show');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('without the community cog the card says how to add it, and the widget still works', async () => {
  const r = await makeWebRig();
  const page = await openPage(r);
  try {
    await signIn(r, page);
    click(page, '#tab-btn-admin');
    await until(() => /community cog is not loaded/.test(page.q('#afk-status').textContent!), 10000, 'the card');
    for (const id of ['btn-afk', 'btn-afk-minutes', 'btn-welcome', 'btn-welcome-test']) assert.equal((page.q(`#${id}`) as HTMLButtonElement).disabled, true, id);
    assert.equal((page.q('#btn-widget') as HTMLButtonElement).disabled, false);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('SAFETY: a welcome text or a name with page code in it stays text', async () => {
  const evil = '<img src=x onerror="window.pwned=1">';
  const r = await withCommunity();
  r.bot.state.set('community.moved', { 'uid-evil': { name: evil, from: '11', at: Date.now() } });
  const page = await openPage(r);
  try {
    r.adapter.say(r.admin, `!welcome set ${evil}`);
    await until(() => (r.bot.state.get('community.welcome', { message: '' }) as { message: string }).message === evil, 10000, 'the text to be saved');
    await signIn(r, page);
    await openAdmin(page);
    assert.equal((page.q('#welcome-text') as HTMLTextAreaElement).value, evil);
    assert.ok(page.q('#afk-status').textContent!.includes(evil));
    assert.equal(page.qa('#tab-admin img').length, 0);
    assert.equal((page.win as unknown as { pwned?: number }).pwned, undefined);
  } finally {
    page.close();
    r.cleanup();
  }
});
