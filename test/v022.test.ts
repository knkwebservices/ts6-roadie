import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import { BANNER_HEIGHT, BANNER_WIDTH, fit, measure, renderBanner } from '../src/cogs/web/banner.js';
import { bump } from '../src/cogs/floodguard/index.js';
import { findGame } from '../src/cogs/gamegroups/index.js';
import { renderLiveName } from '../src/cogs/servertools/livenames.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';
import { makeWebRig, request } from './web-helpers.js';

const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function say(h: Harness, user: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  const mine = () => h.adapter.sent.slice(n).find((s) => s.kind === 'private' && s.to === user.id);
  h.adapter.say(user, text);
  await until(() => !!mine(), 10000, `an answer to ${text}`);
  return mine()!.text;
}
const to = (h: Harness, user: TsUser) => h.adapter.sent.filter((s) => s.kind === 'private' && s.to === user.id).map((s) => s.text);
const moveTo = (h: Harness, u: TsUser, ch: bigint): void => {
  u.channelId = ch;
  h.adapter.events.emit('directory');
};

test('the new settings have safe defaults and are checked', () => {
  const c = buildConfig({});
  assert.deepEqual(c.gamegroups, { enabled: true, games: [], moveBack: true });
  assert.equal(c.floodguard.enabled, false);
  assert.equal(c.floodguard.action, 'warn');
  assert.deepEqual(c.web.banner, { enabled: false, title: '' });
  assert.deepEqual(c.servertools.staffGroups, []);
  assert.throws(() => buildConfig({ gamegroups: { games: [{ name: 'x', group: 3 }] } }), /gamegroups\.games/);
  assert.throws(() => buildConfig({ floodguard: { hops: 1 } }), /floodguard\.hops/);
  assert.throws(() => buildConfig({ floodguard: { action: 'ban' } }), /floodguard\.action/);
  assert.throws(() => buildConfig({ web: { banner: { enabled: 'yes' } } }), /web\.banner/);
  assert.throws(() => buildConfig({ servertools: { staffGroups: ['6'] } }), /servertools\.staffGroups/);
});

// ---- game groups ---------------------------------------------------------------------------

test('findGame matches what people type', () => {
  const games = [
    { name: 'Fallout 76', group: 14 },
    { name: 'Once Human', group: 15 },
    { name: 'Icarus', group: 16 },
  ];
  assert.equal(findGame(games, 'fallout 76')?.group, 14);
  assert.equal(findGame(games, 'Fallout76')?.group, 14);
  assert.equal(findGame(games, 'once')?.group, 15);
  assert.equal(findGame(games, 'human')?.group, 15);
  assert.equal(findGame(games, 'minecraft'), undefined);
  assert.equal(findGame(games, ''), undefined);
});

test('!game gives and takes back a game group, and admins set the list up', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'gamegroups'] }) });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    assert.match(await say(h, ann, '!games'), /No game groups yet\.$/);
    assert.match(await say(h, ann, '!game add 14 Fallout 76'), /admins only/i);
    assert.match(await say(h, admin, '!game add 14 Fallout 76'), /now gives server group 14/);
    assert.match(await say(h, admin, '!game add 14 Other'), /already offered as Fallout 76/);
    assert.match(await say(h, admin, '!game add x Bad'), /Usage/);
    assert.match(await say(h, admin, '!game add 15 Once Human'), /server group 15/);

    assert.match(await say(h, ann, '!games'), /\[ \] Fallout 76\n\[ \] Once Human/);
    assert.match(await say(h, ann, '!game fallout76'), /Done: you're in Fallout 76/);
    assert.deepEqual(h.adapter.groupChanges.at(-1), { userId: 10, groupId: 14, op: 'add' });
    assert.match(await say(h, ann, '!games'), /\[x\] Fallout 76/);
    await pause(5100); // one toggle per person and game every 5 seconds
    assert.match(await say(h, ann, '!game Fallout 76'), /no longer in Fallout 76/);
    assert.deepEqual(h.adapter.groupChanges.at(-1), { userId: 10, groupId: 14, op: 'remove' });
    assert.match(await say(h, ann, '!game minecraft'), /No game called "minecraft"\. Choose from: Fallout 76, Once Human/);

    // a refused change is explained
    h.adapter.failGroupChange = new Error('insufficient client permissions (failed_permid=4)');
    assert.match(await say(h, ann, '!role once human'), /couldn't change your Once Human group \(insufficient client permissions/);
    h.adapter.failGroupChange = undefined;

    assert.match(await say(h, admin, '!game remove once'), /Removed Once Human/);
    assert.match(await say(h, admin, '!game off'), /off/);
    assert.match(await say(h, ann, '!game fallout 76'), /switched off/);
  } finally {
    h.cleanup();
  }
});

test('joining a game channel toggles the group and moves you back', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'gamegroups'] }) });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    h.adapter.chans.push({ id: 70n, name: 'Get Fallout 76 role', parentId: 0n });
    await pause(2200); // the first look after connecting only learns where everyone is
    await say(h, admin, '!game add 14 Fallout 76');
    assert.match(await say(h, admin, '!game channel Fallout | Nowhere'), /can't find a channel/);
    assert.match(await say(h, admin, '!game channel Fallout | Get Fallout 76 role'), /Joining "Get Fallout 76 role" now toggles Fallout 76, and I move them back/);

    moveTo(h, ann, 70n);
    await until(() => to(h, ann).some((t) => /you're in Fallout 76/.test(t)), 10000, 'the group');
    await until(() => ann.channelId === CH.a, 5000, 'the move back');
    assert.deepEqual(h.adapter.userMoves.at(-1), { id: 10, to: CH.a });
    assert.match(await say(h, ann, '!games'), /\[x\] Fallout 76 \(or join "Get Fallout 76 role"\)/);
  } finally {
    h.cleanup();
  }
});

// ---- staff online ----------------------------------------------------------------------------

test('{staff} and {staffnames} fill in, and a long list is shortened to fit', () => {
  const v = { online: 9, record: 12, song: '', staff: 2, staffNames: 'Rob, KrazyIce' };
  assert.equal(renderLiveName('[cspacer]Staff on: {staffnames}', v), '[cspacer]Staff on: Rob, KrazyIce');
  assert.equal(renderLiveName('Staff online: {staff}', v), 'Staff online: 2');
  assert.equal(renderLiveName('Staff: {staffnames}', { ...v, staff: 0, staffNames: '' }), 'Staff: none');
  const long = renderLiveName('[cspacer]Staff: {staffnames}', { ...v, staffNames: 'Alexander, Bartholomew, Christopher, Dominique' });
  assert.equal(long.length, 40);
  assert.match(long, /\.\.\.$/);
});

test('!staff lists the staff online; admins choose the staff groups', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'servertools'] }) });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.staff, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    const mod = h.adapter.addUser(11, 'Mo', CH.b, 'uid-Mo', [9]);
    assert.equal(await say(h, ann, '!staff'), 'Staff online (1): Admin (Staff Room)');
    assert.match(await say(h, ann, '!staff add 9'), /Only bot admins/);
    assert.match(await say(h, admin, '!staff add 9'), /group 9 now count as staff/);
    assert.equal(await say(h, ann, '!admins'), 'Staff online (2): Admin (Staff Room), Mo (Gaming B)');
    assert.match(await say(h, admin, '!staff groups'), /bot admins and server groups 9/);
    assert.match(await say(h, admin, '!staff remove 9'), /no longer counts/);
    void mod;
    h.adapter.userList = h.adapter.userList.filter((u) => u.id !== admin.id);
    assert.match(await say(h, ann, '!staff'), /No staff are online/);
  } finally {
    h.cleanup();
  }
});

// ---- flood guard -------------------------------------------------------------------------------

test('bump counts events inside the window', () => {
  const t: number[] = [];
  assert.equal(bump(t, 0, 1000), 1);
  assert.equal(bump(t, 500, 1000), 2);
  assert.equal(bump(t, 1600, 1000), 1, 'the old ones fell out');
});

test('channel hopping gets a warning, then the chosen action; admins are never checked', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'floodguard'], floodguard: { enabled: true, hops: 4, hopSeconds: 30, action: 'move', moveChannel: 'Staff Room' } }) });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    await pause(3200);
    const hop = (n: number, u: TsUser): void => {
      for (let i = 0; i < n; i++) moveTo(h, u, u.channelId === CH.a ? CH.b : CH.a);
    };
    hop(4, admin);
    hop(4, ann);
    await until(() => h.adapter.sent.some((s) => s.kind === 'poke' && s.to === 10 && /slow down: you're hopping between channels/.test(s.text)), 5000, 'the warning');
    assert.ok(!h.adapter.sent.some((s) => s.to === 2 && /slow down/.test(s.text)), 'the admin was not warned');
    await until(() => to(h, ann).some((t) => /ignore your commands for 60 seconds\. If it happens again soon, you'll be moved to "Staff Room"/.test(t)), 5000, 'the private warning');

    // silenced: commands are ignored without a reply
    const before = h.adapter.sent.length;
    h.adapter.say(ann, '!ping');
    await pause(200);
    assert.equal(h.adapter.sent.length, before);

    hop(4, ann);
    await until(() => ann.channelId === CH.staff, 5000, 'the move');
    await until(() => to(h, admin).some((t) => /moved Ann to "Staff Room" for hopping between channels again/.test(t)), 5000, 'the admins told');
  } finally {
    h.cleanup();
  }
});

test('chat spam is caught too, and kick is an option', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'floodguard'], floodguard: { enabled: true, messages: 3, messageSeconds: 10, quietSeconds: 0 } }) });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.home);
    assert.match(await say(h, ann, '!floodguard'), /admins only/i);
    assert.match(await say(h, admin, '!floodguard action kick'), /get them kicked/);
    assert.match(await say(h, admin, '!floodguard'), /The flood guard is ON\.[\s\S]*Spam: 3 messages/);
    for (let i = 0; i < 3; i++) h.adapter.say(ann, `hi ${i}`, 'channel');
    await until(() => h.adapter.sent.some((s) => s.kind === 'poke' && s.to === 10 && /sending messages too fast/.test(s.text)), 5000, 'the warning');
    for (let i = 0; i < 3; i++) h.adapter.say(ann, `hi again ${i}`, 'channel');
    await until(() => h.adapter.kicks.length === 1, 5000, 'the kick');
    assert.match(h.adapter.kicks[0]!.reason, /Flooding: sending messages too fast/);
    assert.match(await say(h, admin, '!floodguard off'), /off/);
  } finally {
    h.cleanup();
  }
});

// ---- stats banner ----------------------------------------------------------------------------

test('the banner is a real PNG of the right size, and long text is shortened', () => {
  const png = renderBanner({ title: 'TGSC Gaming Community', online: 7, record: 14, song: 'x'.repeat(300), clock: 'Sat 9:41 PM' });
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), BANNER_WIDTH);
  assert.equal(png.readUInt32BE(20), BANNER_HEIGHT);
  // the pixel data inflates to exactly one filter byte plus RGB per row
  const idatAt = png.indexOf('IDAT');
  const len = png.readUInt32BE(idatAt - 4);
  assert.equal(inflateSync(png.subarray(idatAt + 4, idatAt + 4 + len)).length, (BANNER_WIDTH * 3 + 1) * BANNER_HEIGHT);
  assert.ok(measure(fit('y'.repeat(500), 'small', 300), 'small') <= 300);
  assert.match(fit('y'.repeat(500), 'small', 300), /\.\.\.$/);
  assert.equal(fit('short', 'small', 300), 'short');
  // characters the font does not have still draw (as "?")
  assert.ok(renderBanner({ title: 'Café ✓ 漢字', online: 0, record: 0, song: '', clock: '' }).length > 1000);
});

test('/banner.png is public while on, and !banner sets it up', async () => {
  const r = await makeWebRig();
  try {
    assert.equal((await request(r.port, { path: '/banner.png' })).status, 404);
    const say2 = async (u: TsUser, text: string): Promise<string> => {
      const n = r.adapter.sent.length;
      r.adapter.say(u, text);
      await until(() => r.adapter.sent.length > n, 10000, text);
      return r.adapter.sent[n]!.text;
    };
    assert.match(await say2(r.alice, '!banner on'), /admins only/i);
    assert.match(await say2(r.admin, '!banner'), /The stats banner is off\. Title: "Test Bot"\.\nAddress: http:\/\/127\.0\.0\.1:\d+\/banner\.png \(800 x 160/);
    assert.match(await say2(r.admin, '!banner title TGSC Gaming Community'), /now "TGSC Gaming Community"/);
    assert.match(await say2(r.admin, '!banner on'), /on: http/);
    const res = await request(r.port, { path: '/banner.png?t=123', host: 'evil.example' });
    assert.equal(res.status, 403, 'still only answers to its own host names');
    const ok = await request(r.port, { path: '/banner.png?t=123' });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['content-type'], 'image/png');
    assert.equal(ok.headers['cache-control'], 'public, max-age=30');
    assert.ok(Number(ok.headers['content-length'] ?? ok.text.length) > 1000);
    assert.equal((await request(r.port, { path: '/banner.png', body: {} })).status, 405);
    assert.deepEqual(r.bot.state.get('web.banner', null), { enabled: true, title: 'TGSC Gaming Community' });
  } finally {
    r.cleanup();
  }
});

test('!whois shows what the server shares, privately, to bot admins only', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'servertools'] }) });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const amy = h.adapter.addUser(10, 'Amy', CH.a);
    assert.match(await say(h, amy, '!whois Admin'), /admins only/i);
    h.adapter.details.set(10, { client_country: 'US', connection_client_ip: '192.168.1.20', client_version: '6.0.0' });
    const out = await say(h, admin, '!whois am');
    assert.match(out, /About Amy \(client #10\):/);
    assert.match(out, /client_country: US/);
    assert.match(out, /connection_client_ip: 192\.168\.1\.20/);
    assert.match(out, /Connection info: not available/);
    assert.match(out, /DOES share addresses/);
    h.adapter.details.set(10, { client_country: 'US' });
    assert.match(await say(h, admin, '!whois amy'), /no address was shared/);
    assert.match(await say(h, admin, '!whois zed'), /Nobody online matches/);
  } finally {
    h.cleanup();
  }
});
