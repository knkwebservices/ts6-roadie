import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import { describeMinutes, parseMinutes, splitTarget } from '../src/cogs/modtools/index.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const JAIL = 77n;
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function say(h: Harness, user: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  const mine = () => h.adapter.sent.slice(n).find((s) => s.kind === 'private' && s.to === user.id);
  h.adapter.say(user, text);
  await until(() => !!mine(), 10000, `an answer to ${text}`);
  return mine()!.text;
}
const to = (h: Harness, user: TsUser) => h.adapter.sent.filter((s) => s.kind === 'private' && s.to === user.id).map((s) => s.text);
const pokes = (h: Harness, user: TsUser) => h.adapter.sent.filter((s) => s.kind === 'poke' && s.to === user.id).map((s) => s.text);

async function rig(): Promise<Harness> {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'modtools'] }) });
  h.adapter.chans.push({ id: JAIL, name: 'Jail', parentId: 0n });
  return h;
}

test('durations and names are understood', () => {
  assert.equal(parseMinutes('30'), 30);
  assert.equal(parseMinutes('2h'), 120);
  assert.equal(parseMinutes('1d'), 1440);
  assert.equal(parseMinutes('forever'), 0);
  assert.equal(parseMinutes('spamming'), undefined);
  assert.equal(describeMinutes(90), '90 minutes');
  assert.equal(describeMinutes(120), '2 hours');
  assert.equal(describeMinutes(1440), '1 day');
  const users = [
    { id: 1, uid: 'a', name: 'Big Mike', channelId: 1n, groups: [] },
    { id: 2, uid: 'b', name: 'Mikey', channelId: 1n, groups: [] },
    { id: 3, uid: 'c', name: 'Ann', channelId: 1n, groups: [] },
  ];
  assert.equal(splitTarget(['Big', 'Mike', '30', 'spam'], users)?.user.name, 'Big Mike');
  assert.deepEqual(splitTarget(['Big', 'Mike', '30', 'spam'], users)?.rest, ['30', 'spam']);
  assert.equal(splitTarget(['an', '10'], users)?.user.name, 'Ann');
  assert.equal(splitTarget(['mike', '10'], users), undefined, 'two people match part of the name');
  assert.throws(() => buildConfig({ modtools: { jailChannel: '' } }), /modtools\.jailChannel/);
});

test('!jail moves someone to jail, brings them back if they leave, and lets them out', async () => {
  const h = await rig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const bob = h.adapter.addUser(10, 'Bob', CH.a);
    assert.match(await say(h, bob, '!jail Admin'), /admins only/i);
    assert.match(await say(h, admin, '!jail Admin'), /Bot admins can't be jailed/);
    assert.match(await say(h, admin, '!jail Nobody 10'), /can't tell who/);
    assert.match(await say(h, admin, '!jail bob 2h spamming the radio'), /Bob is in "Jail" for 2 hours/);
    assert.equal(bob.channelId, JAIL);
    assert.match(to(h, bob).at(-1)!, /put in jail for 2 hours: spamming the radio\. Leaving won't help/);

    await pause(3100);
    bob.channelId = CH.b;
    h.adapter.events.emit('directory');
    await until(() => bob.channelId === JAIL, 5000, 'Bob back in jail');
    await until(() => pokes(h, bob).some((t) => /You're in jail for 2 hours more|You're in jail for 1\d\d minutes more/.test(t)), 5000, 'the poke');

    assert.match(await say(h, admin, '!jailed'), /In jail:\nBob: 1\d\d min left \(by Admin, just now\) - spamming the radio/);
    assert.match(await say(h, admin, '!unjail bo'), /Bob is out of jail/);
    assert.match(to(h, bob).at(-1)!, /let out of jail/);
    bob.channelId = CH.a;
    h.adapter.events.emit('directory');
    await pause(200);
    assert.equal(bob.channelId, CH.a, 'free to go');
    assert.match(await say(h, admin, '!jailed'), /Nobody is in jail/);
  } finally {
    h.cleanup();
  }
});

test('jail time runs out on its own, and a missing jail channel is explained', async () => {
  const h = await rig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const bob = h.adapter.addUser(10, 'Bob', CH.a);
    await say(h, admin, '!jail Bob 5');
    // pretend the time is up
    const list = h.bot.state.get<{ until: number }[]>('modtools.jail', []);
    h.bot.state.set('modtools.jail', list.map((j) => ({ ...j, until: Date.now() - 1 })));
    await h.bot.reloadCog('modtools');
    h.adapter.events.emit('directory');
    await until(() => to(h, bob).some((t) => /jail time is over/.test(t)), 5000, 'the release');

    h.adapter.chans = h.adapter.chans.filter((c) => c.id !== JAIL);
    assert.match(await say(h, admin, '!jail Bob'), /There's no channel called "Jail"/);
  } finally {
    h.cleanup();
  }
});

test('!report reaches the staff online, is kept for !reports, and has a cooldown', async () => {
  const h = await rig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const mod = h.adapter.addUser(3, 'Mo', CH.staff, 'uid-Mo', [9]);
    h.bot.state.set('servertools.staffGroups', [9]);
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    const bob = h.adapter.addUser(11, 'Bob', CH.b);
    assert.match(await say(h, ann, '!report Bob'), /Usage/);
    assert.match(await say(h, ann, '!report bob keeps blasting music'), /went to 2 staff members online/);
    await until(() => to(h, mod).some((t) => /Report #1 from Ann about Bob \(in "Gaming B"\): keeps blasting music/.test(t)), 5000, 'the staff told');
    assert.ok(pokes(h, admin).some((t) => /Report #1: Ann reported Bob/.test(t)));
    assert.match(await say(h, ann, '!report bob again'), /just sent a report/);
    assert.match(await say(h, bob, '!reports'), /admins only/i);
    assert.match(await say(h, admin, '!reports'), /#1 just now: Ann about Bob: keeps blasting music/);

    // someone offline can be reported by name; with no staff online it's saved
    h.adapter.userList = h.adapter.userList.filter((u) => u.id !== admin.id && u.id !== mod.id);
    assert.match(await say(h, bob, '!report Zed was rude earlier'), /No staff are online right now, so it's saved/);
    assert.equal(h.bot.state.get<unknown[]>('modtools.reports', []).length, 2);
  } finally {
    h.cleanup();
  }
});

test('!meeting brings the staff to your channel', async () => {
  const h = await rig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const mod = h.adapter.addUser(3, 'Mo', CH.staff, 'uid-Mo', [9]);
    h.bot.state.set('servertools.staffGroups', [9]);
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    assert.match(await say(h, admin, '!meeting'), /Brought 1 of 1 staff to "Lobby"/);
    assert.equal(mod.channelId, CH.home);
    assert.equal(ann.channelId, CH.a, 'not staff, not moved');
    assert.match(await say(h, admin, '!meeting'), /already here/);
  } finally {
    h.cleanup();
  }
});
