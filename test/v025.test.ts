import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import { staleChannels } from '../src/cogs/privchannels/index.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const CLAIM = 60n;
const ZONE = 61n;
const DAY = 86_400_000;

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

async function rig(): Promise<Harness> {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'privchannels'] }) });
  h.adapter.chans.push({ id: CLAIM, name: 'Get a Channel', parentId: 0n }, { id: ZONE, name: 'Squad Rooms', parentId: 0n });
  return h;
}

test('settings are checked', () => {
  const c = buildConfig({});
  assert.equal(c.privchannels.enabled, false);
  assert.equal(c.privchannels.cleaner.enabled, false);
  assert.throws(() => buildConfig({ privchannels: { nameTemplate: 'no placeholder' } }), /privchannels\.nameTemplate/);
  assert.throws(() => buildConfig({ privchannels: { cleaner: { days: 0 } } }), /privchannels\.cleaner/);
});

test('staleChannels never picks occupied channels, ones with sub-channels, or unseen ones', () => {
  const now = 100 * DAY;
  const chans = [1n, 2n, 3n, 4n, 5n].map((id) => ({ id, name: `c${id}`, parentId: 0n }));
  const used = { '1': now - 20 * DAY, '2': now - 20 * DAY, '3': now - 20 * DAY, '4': now - 2 * DAY };
  const out = staleChannels(chans, used, { days: 14, now, occupied: new Set([2n]), hasChildren: new Set([3n]) });
  assert.deepEqual(out.map((c) => c.name), ['c1']);
});

test('joining "Get a Channel" makes a permanent channel; joining again takes you back; !mychannel works', async () => {
  const h = await rig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    assert.match(await say(h, ann, '!privchannels on'), /admins only/i);
    assert.match(await say(h, admin, '!privchannels on'), /Private channels are on/);
    moveTo(h, ann, CLAIM);
    await until(() => to(h, ann).some((t) => /Here's your own channel, "Ann's Channel"\. It stays when you leave/.test(t)), 5000, 'the channel');
    const made = h.adapter.created.at(-1)!;
    assert.equal(made.deleteDelaySec, -1, 'permanent, not temporary');
    assert.equal(made.parentId, CLAIM);
    assert.equal(ann.channelId, made.id);
    assert.deepEqual(h.adapter.channelGroups.at(-1), { userId: 10, channelId: made.id, groupId: 5 });

    moveTo(h, ann, CH.b);
    moveTo(h, ann, CLAIM);
    await until(() => to(h, ann).some((t) => /already have a channel/.test(t)), 5000, 'moved back');
    assert.equal(h.adapter.created.filter((c) => c.deleteDelaySec === -1).length, 1);
    moveTo(h, ann, CH.b);
    assert.match(await say(h, ann, '!mychannel'), /Moved you to "Ann's Channel"/);
    assert.match(await say(h, admin, '!privchannels list'), /1 so far:\n"Ann's Channel" - Ann, last used just now/);
    assert.match(await say(h, ann, '!mychannel giveup'), /is gone/);
    assert.ok(h.adapter.deleted.includes(made.id));
    assert.match(await say(h, ann, '!mychannel'), /don't have a channel yet\. Join "Get a Channel"/);
  } finally {
    h.cleanup();
  }
});

test('the cleaner removes only unused, empty channels it watches, and previews first', async () => {
  const h = await rig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    h.adapter.chans.push({ id: 70n, name: 'Squad 1', parentId: ZONE }, { id: 71n, name: 'Squad 2', parentId: ZONE }, { id: 72n, name: 'Other', parentId: 0n });
    assert.match(await say(h, admin, '!cleaner add Squad Rooms'), /watch the sub-channels of "Squad Rooms"/);
    assert.match(await say(h, admin, '!cleaner preview'), /Nothing to remove\. Watching 2 channels/);

    // pretend Squad 1 was last used 20 days ago; Squad 2 has someone in it
    const used = h.bot.state.get<Record<string, number>>('cleaner.lastUsed', {});
    h.bot.state.set('cleaner.lastUsed', { ...used, '70': Date.now() - 20 * DAY, '71': Date.now() - 20 * DAY });
    await h.bot.reloadCog('privchannels');
    h.adapter.addUser(11, 'Sam', 71n);
    assert.match(await say(h, admin, '!cleaner preview'), /Would remove \(the cleaner is off\): "Squad 1" \(last used 20 d ago\)/);
    assert.match(await say(h, admin, '!cleaner run'), /The cleaner is off/);
    assert.equal(h.adapter.deleted.length, 0);
    assert.match(await say(h, admin, '!cleaner on'), /cleaner is on/);
    assert.match(await say(h, admin, '!cleaner run'), /Removed: Squad 1\./);
    assert.deepEqual(h.adapter.deleted, [70n]);
    assert.ok(h.adapter.chans.some((c) => c.id === 72n), 'unwatched channels are never touched');
    assert.ok(h.adapter.chans.some((c) => c.id === ZONE), 'the zone itself is never removed');
  } finally {
    h.cleanup();
  }
});

test('the AFK mover leaves people in the jail channel alone', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'community'], community: { afk: { enabled: true, minutes: 1, warnSeconds: 0, checkSeconds: 5 } } }) });
  try {
    h.adapter.chans.push({ id: 77n, name: 'Jail', parentId: 0n }, { id: 78n, name: 'AFK Room', parentId: 0n });
    const bob = h.adapter.addUser(10, 'Bob', 77n);
    bob.away = true;
    h.adapter.events.emit('directory');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(bob.channelId, 77n);
  } finally {
    h.cleanup();
  }
});
