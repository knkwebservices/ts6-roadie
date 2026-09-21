import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cleanStations, MAX_STATIONS, readLogTail, redact, stationKey } from '../src/cogs/web/admin.js';
import { listStations } from '../src/cogs/audio/sources.js';
import { CH, until } from './helpers.js';
import { makeWebRig, openPage, request, type Page, type WebRig } from './web-helpers.js';

const CODE = /[A-Z2-9]{4}-[A-Z2-9]{4}/;

/** A config.json on disk, like the real bot has, so saving stations has something to edit. */
function writeConfig(r: WebRig, extra: Record<string, unknown> = {}): string {
  const file = join(r.dir, 'config.json');
  writeFileSync(file, JSON.stringify({ server: { address: 'localhost:9987', nickname: 'Test Bot', homeChannel: 'Lobby' }, admins: ['uid-Admin'], cogs: ['core', 'web'], ...extra }, null, 2));
  return file;
}

function writeLog(r: WebRig, name: string, text: string): void {
  mkdirSync(join(r.dir, 'logs'), { recursive: true });
  writeFileSync(join(r.dir, 'logs', name), text);
}

const good = (n: number) => ({ stations: Array.from({ length: n }, (_, i) => ({ name: `Station ${i + 1}`, url: `https://radio.example.com/${i + 1}.mp3` })) });

// ---- who may use it ----------------------------------------------------------------

test('the Admin routes need a session, and then a bot admin', async () => {
  const r = await makeWebRig();
  try {
    for (const path of ['/api/admin/overview', '/api/admin/logs', '/api/admin/stations']) {
      assert.equal((await request(r.port, { path })).status, 401, `${path} signed out`);
    }
    assert.equal((await request(r.port, { path: '/api/admin/stations/save', body: good(1) })).status, 401);

    const alice = await r.login(r.alice); // signed in, but not a bot admin
    for (const path of ['/api/admin/overview', '/api/admin/logs', '/api/admin/stations']) {
      const res = await r.as(alice, path);
      assert.equal(res.status, 403, `${path} as a non-admin`);
      assert.match(res.json.error, /admins only/);
    }
    assert.equal((await r.as(alice, '/api/admin/stations/save', good(1))).status, 403);
    assert.equal((await r.as(alice, '/api/state')).json.admin, false);

    const admin = await r.login(r.admin);
    assert.equal((await r.as(admin, '/api/state')).json.admin, true);
    assert.equal((await r.as(admin, '/api/admin/overview')).status, 200);
  } finally {
    r.cleanup();
  }
});

test('each Admin route answers only its own kind of request', async () => {
  const r = await makeWebRig();
  try {
    const admin = await r.login(r.admin);
    assert.equal((await r.as(admin, '/api/admin/overview', {})).status, 405, 'POST to a GET route');
    assert.equal((await request(r.port, { method: 'GET', path: '/api/admin/stations/save', headers: { Cookie: admin } })).status, 405, 'GET to a POST route');
    assert.equal((await r.as(admin, '/api/admin/nope')).status, 404);
    assert.equal((await r.as(admin, '/api/admin/stations/save', { stations: 'no' })).status, 400);
    assert.equal((await request(r.port, { path: '/api/admin/stations/save', rawBody: 'stations=1', headers: { Cookie: admin, 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415);
  } finally {
    r.cleanup();
  }
});

// ---- overview ----------------------------------------------------------------------

test('the overview shows health, cogs and who is where, and never other people\'s unique IDs', async () => {
  const r = await makeWebRig({ cogs: ['core', 'web', 'voteskip'] });
  try {
    r.adapter.addUser(7, 'Bob', CH.a, 'uid-secret-bob');
    const admin = await r.login(r.admin);
    const res = await r.as(admin, '/api/admin/overview');
    assert.equal(res.status, 200);
    const o = res.json;
    assert.match(o.version, /^\d+\.\d+\.\d+/);
    assert.equal(o.connected, true);
    assert.equal(o.botChannelId, String(CH.home));
    assert.ok(o.uptimeSec >= 0);

    const cog = (n: string) => o.cogs.find((c: { name: string }) => c.name === n);
    assert.equal(cog('core').loaded, true);
    assert.equal(cog('voteskip').loaded, true);
    assert.equal(cog('audio').loaded, false, 'a cog that exists but is not loaded is listed as off');

    const ch = (name: string) => o.channels.find((c: { name: string }) => c.name === name);
    assert.deepEqual(ch('Lobby').users.map((u: { name: string }) => u.name).sort(), ['Admin', 'Alice']);
    assert.deepEqual(ch('Gaming A').users, [{ id: 7, name: 'Bob' }]);
    assert.equal(ch('Gaming A').id, String(CH.a));
    assert.equal(ch('Gaming A').parentId, '0');

    assert.doesNotMatch(res.text, /uid-/, 'no unique IDs are sent');
  } finally {
    r.cleanup();
  }
});

// ---- log viewer --------------------------------------------------------------------

const LOG = [
  '2026-09-20T10:00:00.000Z INFO  starting',
  '2026-09-20T10:00:01.000Z WARN  [audio] slow start',
  '2026-09-20T10:00:02.000Z ERROR [audio] boom Error: something broke',
  '    at play (player.ts:1:1)',
  '    at run (bot.ts:2:2)',
  '2026-09-20T10:00:03.000Z INFO  your dashboard code is ABCD-EFGH',
  '2026-09-20T10:00:04.000Z INFO  connecting with password: hunter2 and token=abc123',
  '2026-09-20T10:00:05.000Z DEBUG [x] noise',
  '',
].join('\n');

test('the log viewer shows recent lines, filters by level, and hides anything secret', async () => {
  const r = await makeWebRig();
  try {
    writeLog(r, 'tsbot-2026-09-20.log', LOG);
    const admin = await r.login(r.admin);

    const all = (await r.as(admin, '/api/admin/logs')).json;
    assert.equal(all.file, 'tsbot-2026-09-20.log');
    assert.equal(all.lines.length, 8);
    assert.equal(all.more, false);
    const text = all.lines.join('\n');
    assert.doesNotMatch(text, /ABCD-EFGH/, 'a login code is hidden');
    assert.match(text, /\*\*\*\*-\*\*\*\*/);
    assert.doesNotMatch(text, /hunter2|abc123/, 'passwords and tokens are hidden');
    assert.match(text, /password: \[hidden\]/);

    const warn = (await r.as(admin, '/api/admin/logs?level=warn')).json.lines;
    assert.equal(warn.filter((l: string) => /^\d{4}-/.test(l)).length, 2, 'a warning and an error');
    assert.ok(warn.some((l: string) => /player\.ts/.test(l)), 'the error keeps its stack lines');

    const err = (await r.as(admin, '/api/admin/logs?level=error')).json.lines;
    assert.equal(err.filter((l: string) => /^\d{4}-/.test(l)).length, 1);
    assert.equal(err.length, 3, 'the error and its two stack lines');

    const two = (await r.as(admin, '/api/admin/logs?lines=2')).json;
    assert.equal(two.lines.length, 2);
    assert.equal(two.more, true);
    assert.match(two.lines[1], /DEBUG/, 'the newest lines come last');

    assert.equal((await r.as(admin, '/api/admin/logs?level=bogus&lines=abc')).status, 200, 'nonsense options fall back to the defaults');
  } finally {
    r.cleanup();
  }
});

test('with no log files yet, the viewer says so instead of failing; a short day is topped up from the day before', async () => {
  const r = await makeWebRig();
  try {
    const admin = await r.login(r.admin);
    assert.deepEqual((await r.as(admin, '/api/admin/logs')).json, { file: '', lines: [], more: false });

    writeLog(r, 'tsbot-2026-09-19.log', '2026-09-19T23:59:00.000Z INFO  yesterday\n');
    writeLog(r, 'tsbot-2026-09-20.log', '2026-09-20T00:00:01.000Z INFO  today\n');
    writeLog(r, 'notes.txt', 'not a log');
    const res = (await r.as(admin, '/api/admin/logs')).json;
    assert.equal(res.file, 'tsbot-2026-09-20.log');
    assert.deepEqual(res.lines.map((l: string) => l.split('  ')[1]), ['yesterday', 'today']);
  } finally {
    r.cleanup();
  }
});

test('the log reader copes with big files and very long lines', () => {
  const dir = join(process.env.TMPDIR ?? '/tmp', `roadie-logs-${process.pid}-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const many = Array.from({ length: 20_000 }, (_, i) => `2026-09-20T10:00:00.000Z INFO  line ${i}`).join('\n') + '\n';
  writeFileSync(join(dir, 'tsbot-2026-09-20.log'), many + `2026-09-20T10:00:01.000Z INFO  ${'x'.repeat(5000)}\n`);
  const t = readLogTail(dir, 5000, 'all');
  assert.ok(t.lines.length <= 1000, 'never more than 1000 lines');
  assert.equal(t.more, true);
  assert.ok(t.lines.every((l) => l.length <= 2000), 'long lines are cut');
  assert.match(t.lines.at(-2)!, /line 19999$/);
  assert.equal(redact('a'.repeat(3000)).length, 2000);
});

// ---- radio stations ----------------------------------------------------------------

test('keys for stations are short, safe, unique and never a bare number', () => {
  const taken = new Set<string>();
  assert.equal(stationKey('SomaFM Groove Salad', taken), 'somafm-groove-salad');
  taken.add('somafm-groove-salad');
  assert.equal(stationKey('SomaFM: Groove Salad!', taken), 'somafm-groove-salad-2');
  assert.equal(stationKey('12345', new Set()), 'st-12345');
  assert.equal(stationKey('***', new Set()), 'station');
  assert.equal(stationKey('x'.repeat(80), new Set()).length, 28);
  assert.match(stationKey('Ünïcödé Radio', new Set()), /^[a-z0-9][a-z0-9-]*$/);
});

test('a station list is checked carefully before anything is saved', () => {
  const ok = cleanStations({ stations: [{ key: 'keep-me', name: ' Jazz ', url: ' https://radio.example.com/jazz ' }, { name: 'Rock', url: 'http://radio.example.com:8000/rock' }] });
  assert.deepEqual(ok, { ok: true, stations: [{ key: 'keep-me', name: 'Jazz', url: 'https://radio.example.com/jazz' }, { key: 'rock', name: 'Rock', url: 'http://radio.example.com:8000/rock' }] });

  const bad = (rows: unknown[], re: RegExp, what: string) => {
    const r = cleanStations({ stations: rows });
    assert.equal(r.ok, false, what);
    if (!r.ok) assert.match(r.error, re, what);
  };
  const st = (over: Record<string, unknown>) => ({ name: 'A', url: 'https://radio.example.com/a', ...over });
  bad([st({ name: '' })], /Station 1 needs a name/, 'empty name');
  bad([st({ name: 'x'.repeat(61) })], /needs a name/, 'long name');
  bad([st({ name: 'Two\nlines' })], /needs a name/, 'control characters');
  bad([st({}), st({ name: 'a' })], /Two stations are called/, 'duplicate names, any case');
  bad([st({ url: 'ftp://radio.example.com/a' })], /http:\/\/ or https:\/\//, 'wrong scheme');
  bad([st({ url: 'https://' })], /not valid/, 'no host');
  bad([st({ url: 'https://user:pw@radio.example.com/a' })], /login details/, 'credentials in the address');
  bad([st({ url: 'http://192.168.1.5:8000/a' })], /private network/, 'private address');
  bad([st({ url: 'http://localhost:8000/a' })], /private network/, 'localhost');
  bad([st({ url: `https://radio.example.com/${'a'.repeat(500)}` })], /http/, 'long address');
  bad(good(MAX_STATIONS + 1).stations, /too many/, 'too many');
  bad([42], /not valid/, 'not an object');
  assert.equal(cleanStations(null).ok, false);
  assert.equal(cleanStations({}).ok, false);

  const junkKeys = cleanStations({ stations: [st({ key: '../evil' }), st({ name: 'B', key: '123' }), st({ name: 'C', key: 'dup' }), st({ name: 'D', key: 'dup' })] });
  assert.equal(junkKeys.ok, true);
  if (junkKeys.ok) assert.deepEqual(junkKeys.stations.map((s) => s.key), ['a', 'b', 'dup', 'd']);
});

test('saving stations updates config.json and the running bot at once, keeping everything else', async () => {
  const r = await makeWebRig();
  try {
    const file = writeConfig(r, { prefix: '!', audio: { defaultVolume: 33 } });
    const before = readFileSync(file, 'utf8');
    const admin = await r.login(r.admin);

    const list = (await r.as(admin, '/api/admin/stations')).json;
    assert.equal(list.max, MAX_STATIONS);
    assert.equal(list.stations.length, 5);
    assert.equal(list.stations[0].key, 'groovesalad');

    const res = await r.as(admin, '/api/admin/stations/save', {
      stations: [
        { key: 'defcon', name: 'SomaFM DEF CON Radio', url: 'https://ice1.somafm.com/defcon-128-mp3' },
        { name: 'Jazz FM', url: 'https://radio.example.com/jazz.mp3' },
        { name: '2024', url: 'https://radio.example.com/2024.mp3' },
      ],
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.json.stations.map((s: { key: string }) => s.key), ['defcon', 'jazz-fm', 'st-2024']);

    // the running bot uses it straight away, in the order given
    const live = listStations(r.bot.config.audio);
    assert.deepEqual(live.map((s) => s.name), ['SomaFM DEF CON Radio', 'Jazz FM', '2024']);
    assert.equal((await r.as(admin, '/api/state')).json.stations.length, 3);

    // the file on disk has it, and nothing else was lost
    const disk = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(disk.audio.radioStations), ['defcon', 'jazz-fm', 'st-2024']);
    assert.equal(disk.audio.defaultVolume, 33);
    assert.equal(disk.prefix, '!');
    assert.deepEqual(disk.admins, ['uid-Admin']);
    assert.equal(readFileSync(`${file}.web.bak`, 'utf8'), before, 'the old file is kept as a backup');

    // and the bot would start with it
    assert.equal(listStations(r.bot.config.audio).length, 3);
  } finally {
    r.cleanup();
  }
});

test('a bad station list changes nothing, on disk or in the running bot', async () => {
  const r = await makeWebRig();
  try {
    const file = writeConfig(r);
    const before = readFileSync(file, 'utf8');
    const liveBefore = JSON.stringify(r.bot.config.audio.radioStations);
    const admin = await r.login(r.admin);

    for (const stations of [[{ name: '', url: 'https://radio.example.com/a' }], [{ name: 'A', url: 'http://10.0.0.5/a' }], good(MAX_STATIONS + 1).stations]) {
      const res = await r.as(admin, '/api/admin/stations/save', { stations });
      assert.equal(res.status, 400);
      assert.equal(typeof res.json.error, 'string');
    }
    assert.equal(readFileSync(file, 'utf8'), before);
    assert.equal(JSON.stringify(r.bot.config.audio.radioStations), liveBefore);
    assert.equal(existsSync(`${file}.web.bak`), false, 'no backup for a save that did not happen');
  } finally {
    r.cleanup();
  }
});

test('saving explains itself when config.json is missing or broken, and leaves a broken file alone', async () => {
  const r = await makeWebRig();
  try {
    const admin = await r.login(r.admin);
    const missing = await r.as(admin, '/api/admin/stations/save', good(1));
    assert.equal(missing.status, 400);
    assert.match(missing.json.error, /cannot find config\.json/);

    const file = join(r.dir, 'config.json');
    writeFileSync(file, '{ not json');
    const broken = await r.as(admin, '/api/admin/stations/save', good(1));
    assert.equal(broken.status, 400);
    assert.match(broken.json.error, /Could not save/);
    assert.equal(readFileSync(file, 'utf8'), '{ not json');

    writeFileSync(file, '[1,2]');
    assert.match((await r.as(admin, '/api/admin/stations/save', good(1))).json.error, /does not hold a JSON object/);
  } finally {
    r.cleanup();
  }
});

test('a full list of stations fits in one request, and an oversized one is refused', async () => {
  const r = await makeWebRig();
  try {
    writeConfig(r);
    const admin = await r.login(r.admin);
    const full = { stations: Array.from({ length: MAX_STATIONS }, (_, i) => ({ name: `Station ${i + 1} ${'n'.repeat(40)}`, url: `https://radio.example.com/${'p'.repeat(440)}${i}.mp3` })) };
    assert.ok(JSON.stringify(full).length > 4096, 'bigger than an ordinary request');
    assert.equal((await r.as(admin, '/api/admin/stations/save', full)).status, 200);
    assert.equal(listStations(r.bot.config.audio).length, MAX_STATIONS);

    const huge = await request(r.port, { path: '/api/admin/stations/save', rawBody: JSON.stringify({ stations: [], pad: 'x'.repeat(40_000) }), headers: { Cookie: admin } });
    assert.equal(huge.status, 413);
  } finally {
    r.cleanup();
  }
});

// ---- the page ----------------------------------------------------------------------

async function signIn(r: WebRig, page: Page, user = r.admin): Promise<void> {
  const n = r.adapter.sent.length;
  r.adapter.say(user, '!weblogin');
  await until(() => r.adapter.sent.length > n, 2000, 'the code');
  const code = CODE.exec(r.adapter.lastReply())![0];
  (page.q('#code') as HTMLInputElement).value = code;
  (page.q('#login-form') as HTMLFormElement).requestSubmit();
  await until(() => !page.q('#app').hidden, 5000, 'signing in');
}

const click = (page: Page, sel: string) => (page.q(sel) as HTMLElement).click();
const buttonNamed = (page: Page, label: string) => {
  const b = page.qa('button').find((x) => x.getAttribute('aria-label') === label || x.textContent === label);
  if (!b) throw new Error(`no button "${label}"`);
  return b as HTMLButtonElement;
};

test('only admins see the Admin tab', async () => {
  const r = await makeWebRig();
  try {
    const asAlice = await openPage(r);
    try {
      await signIn(r, asAlice, r.alice);
      assert.equal(asAlice.q('#tabs').hidden, true, 'a non-admin gets no tab bar');
    } finally {
      asAlice.close();
    }

    const asAdmin = await openPage(r);
    try {
      await signIn(r, asAdmin, r.admin);
      assert.equal(asAdmin.q('#tabs').hidden, false);
      assert.equal(asAdmin.q('#tab-admin').hidden, true, 'the player is shown first');
      assert.equal(asAdmin.q('#tab-player').hidden, false);
    } finally {
      asAdmin.close();
    }
  } finally {
    r.cleanup();
  }
});

test('the Admin tab shows health, cogs and channels, and its buttons send ordinary chat commands', async () => {
  const r = await makeWebRig({ cogs: ['core', 'web', 'voteskip'] });
  r.adapter.addUser(7, 'Bob', CH.a, 'uid-Bob');
  const page = await openPage(r);
  page.win.confirm = () => true;
  try {
    await signIn(r, page);
    click(page, '#tab-btn-admin');
    await until(() => page.qa('#cogs li').length > 0 && page.qa('#channels li').length > 0, 3000, 'the Admin tab to load');
    assert.equal(page.q('#tab-admin').hidden, false);
    assert.equal(page.q('#tab-player').hidden, true);
    assert.match(page.q('#admin-facts').textContent!, /Bot \d+\.\d+\.\d+.*Connected.*Channel: Lobby/);

    // core and web can not be switched off from here; others get buttons
    const rows = page.qa('#cogs li');
    const rowOf = (name: string) => rows.find((li) => new RegExp(`^\\[(on|off)\\]\\s+${name} `).test(li.textContent!))!;
    assert.match(rowOf('core').textContent!, /needed by this page/);
    assert.equal(rowOf('core').querySelectorAll('button').length, 0);
    assert.equal(rowOf('web').querySelectorAll('button').length, 0);
    assert.deepEqual([...rowOf('voteskip').querySelectorAll('button')].map((b) => b.textContent), ['Reload', 'Unload']);
    assert.deepEqual([...rowOf('audio').querySelectorAll('button')].map((b) => b.textContent), ['Load']);

    // channels, with who is in them; the bot's own channel can't be "brought to"
    const lobby = page.qa('#channels li').find((li) => li.textContent!.includes('Lobby'))!;
    assert.match(lobby.textContent!, /Admin, Alice|Alice, Admin/);
    assert.equal((lobby.querySelector('button') as HTMLButtonElement).disabled, true);
    const gamingA = page.qa('#channels li').find((li) => li.textContent!.includes('Gaming A'))!;
    assert.match(gamingA.textContent!, /Bob/);

    click(page, '#btn-status');
    await until(() => page.sent.includes('!status'), 2000, '!status');
    (gamingA.querySelector('button') as HTMLButtonElement).click();
    await until(() => page.sent.includes(`!goto #${CH.a}`), 2000, '!goto');
    await until(() => !page.q('#admin-output').hidden, 2000, 'the reply to show');

    buttonNamed(page, 'Reload voteskip').click();
    await until(() => page.sent.includes('!reload voteskip'), 2000, '!reload');
    buttonNamed(page, 'Unload voteskip').click();
    await until(() => page.sent.includes('!unload voteskip'), 2000, '!unload');
    // the list follows what really happened
    await until(() => /\[off\]\s+voteskip/.test(page.q('#cogs').textContent!), 4000, 'voteskip to show as off');
    assert.equal(buttonNamed(page, 'Load voteskip').textContent, 'Load');

    click(page, '#btn-home');
    await until(() => page.sent.includes('!leave'), 2000, '!leave');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('Restart and Unload ask first; saying no sends nothing', async () => {
  const r = await makeWebRig({ cogs: ['core', 'web', 'voteskip'] });
  const page = await openPage(r);
  const asked: string[] = [];
  page.win.confirm = (m?: string) => (asked.push(String(m)), false);
  try {
    await signIn(r, page);
    click(page, '#tab-btn-admin');
    await until(() => page.qa('#cogs li').length > 0, 3000, 'cogs');

    click(page, '#btn-restart');
    buttonNamed(page, 'Unload voteskip').click();
    assert.equal(asked.length, 2);
    assert.match(asked[0]!, /sign in to this page again/);
    await new Promise((res) => setTimeout(res, 100));
    assert.deepEqual(page.sent.filter((c) => /restart|unload/.test(c)), []);
    assert.equal(r.restarted(), false);

    page.win.confirm = () => true;
    click(page, '#btn-restart');
    await until(() => page.sent.includes('!restart'), 2000, '!restart');
    await until(() => r.restarted(), 2000, 'the restart');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the station editor edits a copy, saves it, and shows the bot\'s answer when it refuses', async () => {
  const r = await makeWebRig();
  writeConfig(r);
  const page = await openPage(r);
  try {
    await signIn(r, page);
    click(page, '#tab-btn-admin');
    await until(() => page.qa('#station-editor li').length === 5, 3000, 'five stations');
    assert.match(page.q('#stations-count').textContent!, /5 of 30 stations/);
    assert.equal((page.q('#btn-st-save') as HTMLButtonElement).disabled, true, 'nothing to save yet');

    const rows = () => page.qa('#station-editor li');
    const input = (row: Element, cls: string) => row.querySelector<HTMLInputElement>(cls)!;
    const type = (el: HTMLInputElement, v: string) => {
      el.value = v;
      el.dispatchEvent(new page.win.Event('input', { bubbles: true }));
    };

    // move the last station up, remove the first, rename one
    assert.equal((rows()[0]!.querySelector('button[aria-label="Move station 1 up"]') as HTMLButtonElement).disabled, true);
    (rows()[4]!.querySelector('button[aria-label="Move station 5 up"]') as HTMLButtonElement).click();
    assert.equal(input(rows()[3]!, '.st-name').value, 'SomaFM Metal Detector');
    assert.equal((page.q('#btn-st-save') as HTMLButtonElement).disabled, false);
    (rows()[0]!.querySelector('button[aria-label="Remove station 1"]') as HTMLButtonElement).click();
    assert.equal(rows().length, 4);
    type(input(rows()[0]!, '.st-name'), 'Space Station Renamed');

    // add a bad one first: the bot's reason is shown and the draft is kept
    click(page, '#btn-st-add');
    assert.equal(rows().length, 5);
    type(input(rows()[4]!, '.st-name'), 'Broken');
    type(input(rows()[4]!, '.st-url'), 'http://192.168.1.9/stream');
    click(page, '#btn-st-save');
    await until(() => /private network/.test(page.q('#stations-msg').textContent!), 3000, 'the refusal');
    assert.match(page.q('#stations-msg').className, /error/);
    assert.equal(rows().length, 5, 'the draft is still there to fix');
    assert.equal(listStations(r.bot.config.audio).length, 5, 'and nothing was saved');

    type(input(rows()[4]!, '.st-url'), 'https://radio.example.com/broken.mp3');
    click(page, '#btn-st-save');
    await until(() => /Saved/.test(page.q('#stations-msg').textContent!), 3000, 'the save');
    assert.deepEqual(listStations(r.bot.config.audio).map((s) => s.name), ['Space Station Renamed', 'SomaFM DEF CON Radio', 'SomaFM Metal Detector', 'SomaFM Secret Agent', 'Broken']);
    assert.equal((page.q('#btn-st-save') as HTMLButtonElement).disabled, true);

    // the Player tab's radio buttons follow
    click(page, '#tab-btn-player');
    await until(() => page.qa('#stations button').length === 5 && page.q('#stations').textContent!.includes('Broken'), 4000, 'the Player tab to update');

    // discard throws away edits
    click(page, '#tab-btn-admin');
    await until(() => page.qa('#station-editor li').length === 5, 3000, 'editor');
    type(input(rows()[0]!, '.st-name'), 'Oops');
    assert.equal((page.q('#btn-st-discard') as HTMLButtonElement).disabled, false);
    click(page, '#btn-st-discard');
    await until(() => input(rows()[0]!, '.st-name').value === 'Space Station Renamed', 3000, 'the edit to be discarded');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('unsaved station edits survive switching tabs, and the tab does not run in the background', async () => {
  const r = await makeWebRig();
  writeConfig(r);
  const page = await openPage(r);
  try {
    await signIn(r, page);
    click(page, '#tab-btn-admin');
    await until(() => page.qa('#station-editor li').length === 5, 3000, 'editor');
    const first = page.q<HTMLInputElement>('#station-editor .st-name');
    first.value = 'Half-typed';
    first.dispatchEvent(new page.win.Event('input', { bubbles: true }));

    click(page, '#tab-btn-player');
    click(page, '#tab-btn-admin');
    await new Promise((res) => setTimeout(res, 150));
    assert.equal(page.q<HTMLInputElement>('#station-editor .st-name').value, 'Half-typed');

    // while the Player tab is showing, the Admin tab makes no requests
    click(page, '#tab-btn-player');
    let asked = 0;
    const original = page.win.fetch;
    (page.win as unknown as { fetch: unknown }).fetch = (...a: Parameters<typeof fetch>) => {
      if (String(a[0]).includes('/api/admin/')) asked++;
      return original(...a);
    };
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(asked, 0);
  } finally {
    page.close();
    r.cleanup();
  }
});

test('the log viewer shows the log, filters it, and can be refreshed', async () => {
  const r = await makeWebRig();
  writeLog(r, 'tsbot-2026-09-20.log', LOG);
  const page = await openPage(r);
  try {
    await signIn(r, page);
    click(page, '#tab-btn-admin');
    await until(() => page.q('#logs').textContent!.includes('starting'), 3000, 'the log');
    assert.match(page.q('#logs-note').textContent!, /tsbot-2026-09-20\.log/);
    assert.doesNotMatch(page.q('#logs').textContent!, /ABCD-EFGH|hunter2/);

    const level = page.q<HTMLSelectElement>('#log-level');
    level.value = 'error';
    level.dispatchEvent(new page.win.Event('change', { bubbles: true }));
    await until(() => !page.q('#logs').textContent!.includes('starting'), 3000, 'the filter');
    assert.match(page.q('#logs').textContent!, /boom/);
    assert.match(page.q('#logs').textContent!, /player\.ts/);

    writeLog(r, 'tsbot-2026-09-20.log', LOG + '2026-09-20T10:00:09.000Z ERROR brand new problem\n');
    click(page, '#btn-log-refresh');
    await until(() => page.q('#logs').textContent!.includes('brand new problem'), 3000, 'the refreshed log');
  } finally {
    page.close();
    r.cleanup();
  }
});

test('SAFETY: names from TeamSpeak, cogs and the config are shown as plain text, never as page code', async () => {
  const evil = '<img src=x onerror="window.pwned=1">';
  const r = await makeWebRig();
  writeConfig(r, { audio: { radioStations: { bad: { name: evil, url: 'https://radio.example.com/a' } } } });
  r.bot.config.audio.radioStations = { bad: { name: evil, url: 'https://radio.example.com/a' } };
  r.adapter.chans.push({ id: 20n, name: evil, parentId: CH.a });
  r.adapter.addUser(9, evil, 20n, 'uid-evil');
  writeLog(r, 'tsbot-2026-09-20.log', `2026-09-20T10:00:00.000Z INFO  ${evil}\n`);
  const page = await openPage(r);
  try {
    await signIn(r, page);
    click(page, '#tab-btn-admin');
    await until(() => page.q('#channels').textContent!.includes(evil) && page.q('#logs').textContent!.includes(evil), 3000, 'the tab to load');
    await until(() => page.qa('#station-editor li').length === 1, 3000, 'the editor');
    assert.equal(page.qa('#tab-admin img').length, 0, 'no image element was created');
    assert.equal((page.win as unknown as { pwned?: number }).pwned, undefined);
    assert.equal(page.q<HTMLInputElement>('#station-editor .st-name').value, evil);
  } finally {
    page.close();
    r.cleanup();
  }
});
