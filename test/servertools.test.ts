import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import { MAX_CHANNEL_NAME, renderLiveName } from '../src/cogs/servertools/livenames.js';
import { SeenStore } from '../src/cogs/servertools/seen.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const SUPPORT = 30n;
const STAFF_GROUP = 12;
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function makeRig(servertools: Record<string, unknown> = {}): Promise<Harness> {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'servertools'], servertools }) });
  h.adapter.chans.push({ id: SUPPORT, name: 'Support Room', parentId: 0n });
  return h;
}

/** Send a command and return the bot's answer to that person (not what it sent anyone else meanwhile). */
async function say(h: Harness, user: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  const mine = () => h.adapter.sent.slice(n).find((s) => s.kind === 'private' && s.to === user.id);
  h.adapter.say(user, text);
  await until(() => !!mine(), 10000, `an answer to ${text}`);
  return mine()!.text;
}
const to = (h: Harness, user: TsUser) => h.adapter.sent.filter((s) => s.kind === 'private' && s.to === user.id).map((s) => s.text);
const join2 = (h: Harness, id: number, name: string, ch: bigint, groups: number[] = []): TsUser => {
  const u = h.adapter.addUser(id, name, ch, `uid-${name}`, groups);
  h.adapter.events.emit('directory');
  return u;
};
const moveTo = (h: Harness, u: TsUser, ch: bigint): void => {
  u.channelId = ch;
  h.adapter.events.emit('directory');
};
const leave = (h: Harness, u: TsUser): void => {
  h.adapter.userList = h.adapter.userList.filter((x) => x.id !== u.id);
  h.adapter.events.emit('directory');
};

// ---- config -------------------------------------------------------------------------------------

test('servertools settings have safe defaults and are checked', () => {
  const c = buildConfig({});
  assert.equal(c.servertools.notify.enabled, false);
  assert.equal(c.servertools.liveNames.enabled, false);
  assert.equal(c.servertools.seen.enabled, true);
  assert.throws(() => buildConfig({ servertools: { notify: { rules: [{ channel: 'Support', groups: [] }] } } }), /servertools\.notify\.rules/);
  assert.throws(() => buildConfig({ servertools: { liveNames: { channels: [{ channelId: 'x', template: 'Online: {online}' }] } } }), /servertools\.liveNames\.channels/);
  assert.throws(() => buildConfig({ servertools: { liveNames: { updateSeconds: 5 } } }), /updateSeconds/);
});

// ---- the support notifier ------------------------------------------------------------------------

test('the support notifier tells online staff when someone joins the watched channel, but not when staff do', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const staff = h.adapter.addUser(3, 'Mod', CH.a, 'uid-Mod', [STAFF_GROUP]);
    const staff2 = h.adapter.addUser(4, 'Mod2', CH.b, 'uid-Mod2', [STAFF_GROUP, 7]);
    h.adapter.events.emit('directory');

    assert.match(await say(h, admin, '!notify'), /is off\.\nNothing is watched yet/);
    assert.match(await say(h, admin, '!notify on'), /Add a channel to watch first/);
    assert.match(await say(h, admin, '!notify add Nowhere | 12'), /cannot find a channel called "Nowhere"/);
    assert.match(await say(h, admin, '!notify add Support Room | twelve'), /Give server-group ID numbers/);
    assert.match(await say(h, admin, '!notify add Support Room | 12'), /When someone joins "Support Room", I'll tell the online members of server group 12\. The notifier is off/);
    assert.match(await say(h, admin, '!notify on'), /is on/);

    const guest = join2(h, 10, 'Guest', CH.home);
    moveTo(h, guest, SUPPORT);
    await until(() => to(h, staff).length === 1 && to(h, staff2).length === 1, 10000, 'the staff to be told');
    assert.equal(to(h, staff)[0], 'Heads up: Guest just joined "Support Room".');
    assert.deepEqual(to(h, guest), [], 'the person who joined is not told');

    // hopping out and back in straight away does not ping staff again
    moveTo(h, guest, CH.home);
    moveTo(h, guest, SUPPORT);
    await pause(50);
    assert.equal(to(h, staff).length, 1);

    // staff going into the room is not news
    moveTo(h, staff2, SUPPORT);
    await pause(50);
    assert.equal(to(h, staff).length, 1);

    // connecting straight into the channel counts as joining it
    join2(h, 11, 'Newbie', SUPPORT);
    await until(() => to(h, staff).length === 2, 10000, 'the second note');
    assert.match(to(h, staff)[1]!, /Newbie just joined/);

    assert.match(await say(h, admin, '!notify message {name} needs help in {channel}'), /Saved\. It will read like: Admin needs help in Support Room/);
    join2(h, 12, 'Third', SUPPORT);
    await until(() => to(h, staff).length === 3, 10000, 'the custom message');
    assert.equal(to(h, staff)[2], 'Third needs help in Support Room');

    assert.match(await say(h, admin, '!notify'), /1\. "Support Room" -> server group 12/);
    assert.match(await say(h, admin, '!notify test 1'), /Sent a test to 2 online members/);
    assert.match(await say(h, admin, '!notify remove 1'), /No longer watching "Support Room"/);
    join2(h, 13, 'Fourth', SUPPORT);
    await pause(50);
    assert.equal(to(h, staff).filter((t) => /Fourth/.test(t)).length, 0);
  } finally {
    h.cleanup();
  }
});

test('the notifier is for admins only, and people already in the channel when it loads are not announced', async () => {
  const h = await makeRig({ notify: { enabled: true, rules: [{ channel: 'Support Room', groups: [STAFF_GROUP] }] } });
  try {
    const staff = h.adapter.addUser(3, 'Mod', CH.a, 'uid-Mod', [STAFF_GROUP]);
    const user = h.adapter.addUser(5, 'Pat', CH.home);
    h.adapter.addUser(6, 'Waiting', SUPPORT);
    // a reconnect: the people already there are not new
    h.adapter.events.emit('connected');
    h.adapter.events.emit('directory');
    await pause(50);
    assert.deepEqual(to(h, staff), []);
    assert.match(await say(h, user, '!notify on'), /admin/i);
  } finally {
    h.cleanup();
  }
});

// ---- !seen and the record ------------------------------------------------------------------------

test('!seen says who is online now and when others were last seen, and !record keeps the most ever online', async () => {
  const h = await makeRig();
  try {
    const me = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    h.adapter.events.emit('directory');
    assert.match(await say(h, me, '!seen'), /Usage: !seen <name>/);
    assert.match(await say(h, me, '!seen nobody'), /haven't seen anyone called "nobody"/);

    const ann = join2(h, 10, 'Ann', CH.a);
    const bob = join2(h, 11, 'Bobby', CH.b);
    assert.match(await say(h, me, '!record'), /The most people online at once: 3, on .+ Right now: 3\./);
    assert.match(await say(h, me, '!seen ann'), /^Ann is online now, in "Gaming A"\.$/);

    leave(h, ann);
    assert.match(await say(h, me, '!seen Ann'), /^Ann was last seen just now \(.+\)\.$/);
    // part of a name finds them too
    assert.match(await say(h, me, '!seen bob'), /Bobby is online now/);
    assert.match(await say(h, me, '!record'), /: 3, on .+ Right now: 2\./);

    // a new nickname is still the same person
    const back = h.adapter.addUser(12, 'Annie', CH.home, 'uid-Ann');
    h.adapter.events.emit('directory');
    leave(h, back);
    assert.match(await say(h, me, '!seen annie'), /^Annie was last seen/);
    void bob;
  } finally {
    h.cleanup();
  }
});

test('last-seen times are saved to seen.json and read back after a restart', async () => {
  const h = await makeRig();
  try {
    const ann = join2(h, 10, 'Ann', CH.a);
    leave(h, ann);
    await h.bot.unloadCog('servertools');
    const saved = JSON.parse(readFileSync(join(h.dir, 'seen.json'), 'utf8'));
    assert.equal(saved.people['uid-Ann'].name, 'Ann');

    await h.bot.loadCog('servertools');
    const me = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    assert.match(await say(h, me, '!seen Ann'), /^Ann was last seen just now/);
  } finally {
    h.cleanup();
  }
});

test('the seen store forgets people not seen for a long time, and survives a damaged file', () => {
  const dir = makeTmp();
  const file = join(dir, 'seen.json');
  const s = new SeenStore(file);
  const day = 86_400_000;
  s.saw('a', 'Old', Date.now() - 400 * day);
  s.saw('b', 'New', Date.now());
  s.prune(365);
  assert.equal(s.size, 1);
  assert.equal(s.find('new')[0]!.name, 'New');
  s.save();

  writeFileSync(file, '{ not json');
  const again = new SeenStore(file);
  assert.equal(again.size, 0);
});

function makeTmp(): string {
  return mkdtempSync(join(tmpdir(), 'seen-test-'));
}

// ---- live channel names ------------------------------------------------------------------------------

test('live names fill in the numbers and never go past TeamSpeak\'s 40 characters', () => {
  assert.equal(renderLiveName('[cspacer]Online: {online}', { online: 7, record: 20, song: '' }), '[cspacer]Online: 7');
  assert.equal(renderLiveName('Record: {record}', { online: 7, record: 20, song: '' }), 'Record: 20');
  assert.equal(renderLiveName('Now playing: {song}', { online: 0, record: 0, song: '' }), 'Now playing: -');
  const long = renderLiveName('[cspacer]Now: {song}', { online: 0, record: 0, song: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)' });
  assert.ok(long.length <= MAX_CHANNEL_NAME, long);
  assert.match(long, /^\[cspacer\]Now: Rick Astley.*\.\.\.$/);
});

test('!livename renames a channel from its template, keeps it up to date, and reports a refused rename', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    h.adapter.events.emit('directory');
    assert.match(await say(h, admin, '!livename'), /are off\.\nNo channels yet/);
    assert.match(await say(h, admin, '!livename add Staff Room | Staff'), /at least one of \{online\}/);
    assert.match(await say(h, admin, '!livename add Staff Room | [cspacer]Online: {online}'), /Channel #13 \("Staff Room"\) will be named like: \[cspacer\]Online: 1\nLive names are off/);
    assert.equal(h.adapter.renames.length, 0, 'nothing is renamed while it is off');

    assert.match(await say(h, admin, '!livename on'), /are on\.$/);
    await until(() => h.adapter.renames.length === 1, 10000, 'the rename');
    assert.deepEqual(h.adapter.renames[0], { id: CH.staff, name: '[cspacer]Online: 1' });

    // someone joins: the next update is held back until updateSeconds, but !livename now does it at once
    join2(h, 10, 'Ann', CH.a);
    assert.match(await say(h, admin, '!livename now'), /Renamed 1 channel\./);
    assert.equal(h.adapter.chans.find((c) => c.id === CH.staff)!.name, '[cspacer]Online: 2');
    assert.match(await say(h, admin, '!livename now'), /already has the right name/);
    // the channel is found by its number, so its changing name does not matter
    assert.match(await say(h, admin, '!livename'), /1\. #13 now "\[cspacer\]Online: 2" <- \[cspacer\]Online: \{online\}/);

    join2(h, 11, 'Bob', CH.a);
    h.adapter.failRename = new Error('insufficient client permissions (failed_permid=86)');
    assert.match(await say(h, admin, '!livename now'), /Could not rename #13: insufficient client permissions/);

    h.adapter.failRename = undefined;
    assert.match(await say(h, admin, '!livename remove 1'), /leave channel #13 alone/);
    assert.match(await say(h, admin, '!livename now'), /no live channels/);
  } finally {
    h.cleanup();
  }
});
