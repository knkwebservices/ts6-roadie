import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import { roomName, uniqueName } from '../src/cogs/rooms/index.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const CREATE = 40n;
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function makeRig(rooms: Record<string, unknown> = {}): Promise<Harness> {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'rooms'], rooms: { cooldownSeconds: 0, ...rooms } }) });
  h.adapter.chans.push({ id: CREATE, name: 'Create a Room', parentId: 0n });
  return h;
}

/** Send a command and return the bot's answer to that person. */
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

test('rooms settings have safe defaults and are checked', () => {
  const c = buildConfig({});
  assert.equal(c.rooms.enabled, false);
  assert.equal(c.rooms.creatorChannel, 'Create a Room');
  assert.throws(() => buildConfig({ rooms: { deleteDelaySeconds: 1 } }), /rooms\.deleteDelaySeconds/);
  assert.throws(() => buildConfig({ rooms: { nameTemplate: '' } }), /rooms\.nameTemplate/);
});

test('room names fit in 40 characters and never clash with a sibling', () => {
  assert.equal(roomName("{name}'s Room", 'Ann'), "Ann's Room");
  const long = roomName("{name}'s Room", 'A'.repeat(60));
  assert.equal(long.length, 40);
  assert.match(long, /'s Room$/);
  assert.equal(uniqueName("Ann's Room", ['Lobby']), "Ann's Room");
  assert.equal(uniqueName("Ann's Room", ["ann's room"]), "Ann's Room (2)");
  assert.equal(uniqueName("Ann's Room", ["Ann's Room", "Ann's Room (2)"]), "Ann's Room (3)");
});

test('joining the create channel makes a private room, moves you in, makes you its admin, and puts the bot back', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    h.adapter.events.emit('directory');

    // off by default: nothing happens
    moveTo(h, ann, CREATE);
    await pause(50);
    assert.equal(h.adapter.created.length, 0);
    moveTo(h, ann, CH.a);

    assert.match(await say(h, admin, '!rooms'), /Rooms are off\.\nJoin "Create a Room" to get a room\./);
    h.adapter.moveCreatorIntoNewChannel = true; // like a server that moves the creator into the new channel
    assert.match(await say(h, admin, '!rooms on'), /Rooms are on/);

    moveTo(h, ann, CREATE);
    await until(() => to(h, ann).some((t) => /Here's your room/.test(t)), 10000, 'the room');
    const made = h.adapter.created[0]!;
    assert.equal(made.name, "Ann's Room");
    assert.equal(made.parentId, CREATE, 'a sub-channel of the create channel by default');
    assert.equal(made.deleteDelaySec, 60);
    assert.equal(ann.channelId, made.id, 'Ann was moved in');
    assert.deepEqual(h.adapter.channelGroups, [{ userId: 10, channelId: made.id, groupId: 5 }]);
    assert.equal(h.adapter.chan, CH.home, 'the bot went back to where it was');
    assert.match(to(h, ann).at(-1)!, /You are its channel admin/);

    // joining again takes her back to the same room instead of making another
    moveTo(h, ann, CREATE);
    await until(() => to(h, ann).some((t) => /already have a room/.test(t)), 10000, 'the move back');
    assert.equal(h.adapter.created.length, 1);
    assert.equal(ann.channelId, made.id);

    // !room from anywhere
    moveTo(h, ann, CH.b);
    assert.match(await say(h, ann, '!room'), /Moved you to your room, "Ann's Room"/);
    assert.match(await say(h, admin, '!room'), /You don't have a room\. Join "Create a Room"/);

    // once the server deletes the empty room, the next join makes a fresh one
    h.adapter.chans = h.adapter.chans.filter((c) => c.id !== made.id);
    moveTo(h, ann, CREATE);
    await until(() => to(h, ann).filter((t) => /Here's your room/.test(t)).length === 2, 10000, 'a second room');
    assert.match(await say(h, admin, '!rooms'), /Open now \(1\): "Ann's Room" \(Ann, just now\)/);
  } finally {
    h.cleanup();
  }
});

test('rooms go under a chosen channel, get unique names, and respect the cooldown and the room limit', async () => {
  const h = await makeRig({ cooldownSeconds: 60, maxRooms: 2 });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    h.adapter.chans.push({ id: 50n, name: 'Private Rooms', parentId: 0n });
    h.adapter.chans.push({ id: 51n, name: "Bob's Room", parentId: 50n });
    assert.match(await say(h, admin, '!rooms under Nowhere'), /cannot find/);
    assert.match(await say(h, admin, '!rooms under Private Rooms'), /made under "Private Rooms"/);
    assert.match(await say(h, admin, '!rooms name {name} hangout'), /named like "Admin hangout"/);
    assert.match(await say(h, admin, '!rooms name {name}\'s Room'), /Admin's Room/);
    assert.match(await say(h, admin, '!rooms on'), /on/);

    const bob = h.adapter.addUser(11, 'Bob', CREATE);
    h.adapter.events.emit('directory');
    await until(() => to(h, bob).some((t) => /Here's your room/.test(t)), 10000, "Bob's room");
    assert.equal(h.adapter.created[0]!.parentId, 50n);
    assert.equal(h.adapter.created[0]!.name, "Bob's Room (2)", 'a channel of that name already existed');

    // Bob's room closes (the server deleted it), and he asks for another straight away: too soon
    h.adapter.chans = h.adapter.chans.filter((c) => c.id !== h.adapter.created[0]!.id);
    moveTo(h, bob, CREATE);
    await until(() => to(h, bob).some((t) => /Please wait/.test(t)), 10000, 'the cooldown note');
    assert.equal(h.adapter.created.length, 1);

    // the room limit
    const c = h.adapter.addUser(12, 'Cy', CREATE);
    h.adapter.events.emit('directory');
    await until(() => to(h, c).some((t) => /Here's your room/.test(t)), 10000, "Cy's room");
    const d = h.adapter.addUser(13, 'Di', CH.a);
    h.adapter.chans.push({ id: 60n, name: 'Extra', parentId: 50n });
    // pretend there are two rooms open: Cy's, plus one recorded for Admin
    h.bot.state.set('rooms.owned', { ...h.bot.state.get('rooms.owned', {}), '60': { uid: 'uid-Admin', name: 'Admin', at: Date.now() } });
    moveTo(h, d, CREATE);
    await until(() => to(h, d).some((t) => /already 2 rooms/.test(t)), 10000, 'the full note');
    void c;
  } finally {
    h.cleanup();
  }
});

test('a refused channel create is explained to the person, and rooms are for admins to set up', async () => {
  const h = await makeRig({ enabled: true });
  try {
    const user = h.adapter.addUser(5, 'Pat', CH.home);
    h.adapter.failCreate = new Error('insufficient client permissions (failed_permid=4)');
    moveTo(h, user, CREATE);
    await until(() => to(h, user).some((t) => /couldn't make you a room \(insufficient client permissions/.test(t)), 10000, 'the refusal');
    assert.match(await say(h, user, '!rooms off'), /admin/i);
  } finally {
    h.cleanup();
  }
});
