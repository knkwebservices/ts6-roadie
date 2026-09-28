import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import { earnedRank, nextRank } from '../src/cogs/grouptools/index.js';
import { formatHours, HoursStore } from '../src/cogs/grouptools/hours.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const REGULAR = 20;
const VETERAN = 21;
const MOD = 30;
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function makeRig(grouptools: Record<string, unknown> = {}): Promise<Harness> {
  return makeBot({ config: makeConfig({ cogs: ['core', 'grouptools'], grouptools }) });
}

async function say(h: Harness, user: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  const mine = () => h.adapter.sent.slice(n).find((s) => s.kind === 'private' && s.to === user.id);
  h.adapter.say(user, text);
  await until(() => !!mine(), 10000, `an answer to ${text}`);
  return mine()!.text;
}
const to = (h: Harness, user: TsUser) => h.adapter.sent.filter((s) => s.kind === 'private' && s.to === user.id).map((s) => s.text);

test('grouptools settings have safe defaults and are checked', () => {
  const c = buildConfig({});
  assert.equal(c.grouptools.ranks.enabled, false);
  assert.equal(c.grouptools.protect.enabled, false);
  assert.equal(c.grouptools.protect.mode, 'warn');
  assert.throws(() => buildConfig({ grouptools: { ranks: { rules: [{ hours: 0, group: 9, label: 'x' }] } } }), /grouptools\.ranks\.rules/);
  assert.throws(() => buildConfig({ grouptools: { protect: { mode: 'kick' } } }), /grouptools\.protect\.mode/);
});

test('the rank ladder picks the highest rank earned and the next one up', () => {
  const rules = [
    { hours: 50, group: VETERAN, label: 'Veteran' },
    { hours: 10, group: REGULAR, label: 'Regular' },
  ];
  assert.equal(earnedRank(rules, 5 * 3600), undefined);
  assert.equal(earnedRank(rules, 10 * 3600)!.label, 'Regular');
  assert.equal(earnedRank(rules, 80 * 3600)!.label, 'Veteran');
  assert.equal(nextRank(rules, 12 * 3600)!.label, 'Veteran');
  assert.equal(nextRank(rules, 80 * 3600), undefined);
  assert.equal(formatHours(45 * 60), '45 minutes');
  assert.equal(formatHours(3600), '1 hour');
  assert.equal(formatHours(12.56 * 3600), '12.5 hours');
});

test('the hours store adds up time, keeps the latest name, and saves', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'hours-')), 'ranks.json');
  const s = new HoursStore(file);
  s.add('a', 'Ann', 60);
  s.add('a', 'Annie', 30);
  s.add('b', 'Bob', 0);
  assert.deepEqual(s.get('a'), { uid: 'a', name: 'Annie', seconds: 90 });
  assert.equal(s.get('b'), undefined, 'zero time is not a record');
  s.save();
  assert.equal(new HoursStore(file).get('a')!.seconds, 90);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).people.a.name, 'Annie');
});

test('ranks: admins set a ladder, members get the rank they earned (lower ranks replaced), and !rank shows progress', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    const mod = h.adapter.addUser(11, 'Mo', CH.a, 'uid-Mo', [MOD]);
    h.adapter.events.emit('directory');

    assert.match(await say(h, ann, '!rank'), /No ranks are set up/);
    assert.match(await say(h, admin, '!ranks add ten 20 Regular'), /Usage/);
    assert.match(await say(h, admin, '!ranks add 10 20 Regular'), /after 10 hours online, people get server group 20 \("Regular"\)\. Ranks are off/);
    assert.match(await say(h, admin, '!ranks add 50 21 Veteran'), /server group 21/);
    assert.match(await say(h, admin, '!ranks add 60 21 Again'), /already a rank/);
    assert.match(await say(h, admin, '!ranks'), /Ranks are off\. .+\n1\. Regular: 10 hours -> server group 20\n2\. Veteran: 50 hours -> server group 21/);

    assert.match(await say(h, ann, '!rank'), /You've been online 0 minutes \(not counting right now: ranks are off\)\. Rank: none yet\. Next: Regular at 10 hours/);
    assert.match(await say(h, admin, '!ranks on'), /Ranks are on/);

    // give Ann her past time: she is promoted straight away and told
    assert.match(await say(h, admin, '!ranks give Ann 12'), /Ann now has 12 hours counted\. They reached a new rank: Regular\./);
    assert.deepEqual(h.adapter.groupChanges, [{ userId: 10, groupId: REGULAR, op: 'add' }]);
    assert.ok(to(h, ann).some((t) => /reached the rank "Regular"/.test(t)));
    assert.match(await say(h, ann, '!rank'), /online 12 hours\. Rank: Regular\. Next: Veteran at 50 hours \(38 hours to go\)/);

    // reaching Veteran takes Regular away
    assert.match(await say(h, admin, '!ranks give Ann 60'), /new rank: Veteran/);
    assert.deepEqual(h.adapter.groupChanges.slice(1), [
      { userId: 10, groupId: VETERAN, op: 'add' },
      { userId: 10, groupId: REGULAR, op: 'remove' },
    ]);
    assert.match(await say(h, admin, '!rank ann'), /Ann has been online 60 hours\. Rank: Veteran\. That is the top rank\./);
    void mod;

    // a failed change is logged and retried later rather than hammered
    const bob = h.adapter.addUser(12, 'Bob', CH.b);
    h.adapter.failGroupChange = new Error('insufficient client permissions (failed_permid=61)');
    assert.match(await say(h, admin, '!ranks give Bob 11'), /Bob now has 11 hours counted\. But I could not give Bob "Regular" \(server group 20\): insufficient client permissions/);
    assert.ok(!bob.groups.includes(REGULAR));
    h.adapter.failGroupChange = undefined;
    assert.match(await say(h, admin, '!ranks check'), /New ranks: Bob: Regular/);

    assert.match(await say(h, admin, '!ranks remove 1'), /Removed the rank "Regular"/);
    assert.match(await say(h, admin, '!ranks add 1 20 Regular'), /after 1 hour online/);
    assert.match(await say(h, admin, '!ranks off'), /Ranks are off/);
  } finally {
    h.cleanup();
  }
});

test('the client list never hearing about group changes does not make the bot repeat them (as on TeamSpeak 6)', async () => {
  const h = await makeRig({ ranks: { enabled: true, rules: [{ hours: 1, group: REGULAR, label: 'Regular' }, { hours: 3, group: VETERAN, label: 'Veteran' }] } });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.a, 'uid-Ann', [REGULAR]);
    h.adapter.events.emit('directory');
    h.adapter.lagGroupChanges = true; // the client list keeps saying Ann is only Regular
    assert.match(await say(h, admin, '!ranks give Ann 4'), /new rank: Veteran\.$/, 'no "But I could not..." part');
    await pause(100);
    const expected = [
      { userId: 10, groupId: VETERAN, op: 'add' },
      { userId: 10, groupId: REGULAR, op: 'remove' },
    ];
    assert.deepEqual(h.adapter.groupChanges, expected);
    // every later check asks the server, sees Veteran, and does nothing
    assert.match(await say(h, admin, '!ranks check'), /^Checked\. Nobody reached a new rank\.$/);
    assert.match(await say(h, admin, '!ranks check'), /^Checked\. Nobody reached a new rank\.$/);
    assert.deepEqual(h.adapter.groupChanges, expected);
    assert.equal(to(h, ann).filter((t) => /Congratulations/.test(t)).length, 1, 'congratulated once');

    // someone put back in Regular by hand (only the server knows): the next check takes it away quietly
    h.adapter.realGroups.set(10, [REGULAR, VETERAN]);
    assert.match(await say(h, admin, '!ranks check'), /Nobody reached a new rank/);
    assert.deepEqual(h.adapter.groupChanges.at(-1), { userId: 10, groupId: REGULAR, op: 'remove' });
    assert.equal(to(h, ann).filter((t) => /Congratulations/.test(t)).length, 1);
  } finally {
    h.cleanup();
  }
});

test('group protection notices someone added to a protected group while online, which the client list never shows', async () => {
  const h = await makeRig({ protect: { enabled: true, mode: 'remove', groups: [{ group: MOD, allowed: ['uid-Mo'] }] } });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const eve = h.adapter.addUser(13, 'Eve', CH.b, 'uid-Eve', []);
    h.adapter.lagGroupChanges = true;
    h.adapter.events.emit('directory');
    await pause(50);
    // Eve gets the group; the client list still says she has none
    h.adapter.realGroups.set(13, [MOD]);
    h.adapter.say(admin, '!ranks check'); // any full check will do
    await until(() => h.adapter.groupChanges.some((c) => c.userId === 13 && c.op === 'remove'), 10000, 'Eve to be taken out');
    await until(() => to(h, admin).some((t) => /I took Eve out of protected server group 30/.test(t)), 10000, 'the admin note');
    assert.deepEqual(h.adapter.realGroups.get(13), []);
    void eve;
  } finally {
    h.cleanup();
  }
});

test('ranks skip exempt groups', async () => {
  const h = await makeRig({ ranks: { enabled: true, rules: [{ hours: 1, group: REGULAR, label: 'Regular' }], exemptGroups: [MOD] } });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    h.adapter.addUser(11, 'Mo', CH.a, 'uid-Mo', [MOD]);
    h.adapter.events.emit('directory');
    await say(h, admin, '!ranks give Mo 5');
    assert.equal(h.adapter.groupChanges.length, 0, 'staff are left alone');
  } finally {
    h.cleanup();
  }
});

test('group protection: adding a group allows its online members, warn mode only warns, remove mode takes people out', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const mo = h.adapter.addUser(11, 'Mo', CH.a, 'uid-Mo', [MOD]);
    h.adapter.events.emit('directory');

    assert.match(await say(h, admin, '!protect'), /Group protection is off\..+\nNo groups are protected/s);
    assert.match(await say(h, admin, '!protect add 30'), /Server group 30 is protected\. Allowed now \(online in it\): Mo\. Anyone else in the group who is offline right now is NOT allowed yet/);
    assert.match(await say(h, admin, '!protect on'), /on, in warn mode/);

    // someone sneaks into the group
    const eve = h.adapter.addUser(13, 'Eve', CH.b, 'uid-Eve', [MOD]);
    h.adapter.events.emit('directory');
    await until(() => to(h, admin).some((t) => /Warning: Eve is in protected server group 30/.test(t)), 10000, 'the warning');
    assert.equal(h.adapter.groupChanges.length, 0, 'warn mode changes nothing');
    assert.deepEqual(to(h, mo).filter((t) => /Warning/.test(t)), [], 'only bot admins are told');
    assert.match(await say(h, admin, '!protect'), /Online in it: Mo, Eve\. NOT allowed: Eve\./);

    assert.match(await say(h, admin, '!protect mode remove'), /Remove mode/);
    await until(() => !eve.groups.includes(MOD), 10000, 'Eve to be taken out');
    assert.deepEqual(h.adapter.groupChanges, [{ userId: 13, groupId: MOD, op: 'remove' }]);
    assert.ok(mo.groups.includes(MOD), 'Mo is allowed and kept');
    await until(() => to(h, admin).some((t) => /I took Eve out of protected server group 30/.test(t)), 10000, 'the admin note');

    // allowing someone keeps them in
    assert.match(await say(h, admin, '!protect allow 30 Eve'), /Eve may be in server group 30/);
    eve.groups = [MOD];
    h.adapter.events.emit('directory');
    await pause(50);
    assert.equal(h.adapter.groupChanges.length, 1);

    // bot admins are always allowed, even when not listed
    h.adapter.userList.find((u) => u.id === 2)!.groups = [MOD];
    h.adapter.events.emit('directory');
    await pause(50);
    assert.equal(h.adapter.groupChanges.length, 1);

    assert.match(await say(h, admin, '!protect disallow 30 Eve'), /no longer allowed/);
    assert.match(await say(h, admin, '!protect remove 30'), /no longer protected/);
    assert.match(await say(h, mo, '!protect'), /admin/i);
  } finally {
    h.cleanup();
  }
});
