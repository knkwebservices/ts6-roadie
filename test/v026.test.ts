import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { autoMoveRule } from '../src/cogs/grouptools/index.js';
import { channelBlockedWord } from '../src/cogs/nickfilter/index.js';
import { planSpares } from '../src/cogs/rooms/index.js';
import { applyFixes, computeFixes, emptyFixes, fixCount } from '../src/adapter/directoryfix.js';
import { renderLiveName } from '../src/cogs/servertools/livenames.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

async function say(h: Harness, user: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  const mine = () => h.adapter.sent.slice(n).find((s) => s.kind === 'private' && s.to === user.id);
  h.adapter.say(user, text);
  await until(() => !!mine(), 10000, `an answer to ${text}`);
  return mine()!.text;
}
const dir = (h: Harness): void => void h.adapter.events.emit('directory');

// ---- always one empty channel ----------------------------------------------------------------------

test('planSpares makes the next free number, keeps one empty and removes extra empties after the wait', () => {
  const now = 1_000_000;
  assert.deepEqual(planSpares([], { max: 5, now }), { make: 1, remove: [] });
  assert.deepEqual(planSpares([{ id: 'a', n: 1, occupied: true }], { max: 5, now }), { make: 2, remove: [] });
  assert.deepEqual(planSpares([{ id: 'a', n: 2, occupied: true }], { max: 5, now }), { make: 1, remove: [] }, 'reuses the lowest free number');
  assert.deepEqual(planSpares([{ id: 'a', n: 1, occupied: true }], { max: 1, now }), { remove: [] }, 'stops at max');
  assert.deepEqual(planSpares([{ id: 'a', n: 1, occupied: true }, { id: 'b', n: 2, occupied: false, emptySince: now }], { max: 5, now }), { remove: [] });
  const twoEmpty = [
    { id: 'a', n: 1, occupied: false, emptySince: now - 60_000 },
    { id: 'b', n: 2, occupied: false, emptySince: now - 60_000 },
    { id: 'c', n: 3, occupied: false, emptySince: now - 1_000 },
  ];
  assert.deepEqual(planSpares(twoEmpty, { max: 5, now }), { remove: ['b'] }, 'keeps the lowest, waits for the one just emptied');
});

test('!rooms spare keeps one empty channel and tidies up when switched off', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'rooms'] }) });
  try {
    h.adapter.chans.push({ id: 80n, name: 'Squads', parentId: 0n });
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    assert.match(await say(h, admin, '!rooms spare on'), /Pick where they go first/);
    assert.match(await say(h, admin, '!rooms spare under Squads'), /go under "Squads"/);
    assert.match(await say(h, admin, '!rooms spare name Squad {n}'), /named like "Squad 1"/);
    const onReply = await say(h, admin, '!rooms spare on');
    assert.match(onReply, /is on[\s\S]*"Squad 1" \(empty\)/);
    assert.equal(onReply.match(/is on/g)?.length, 1, 'says "is on" once');
    const first = h.adapter.created.at(-1)!;
    assert.equal(first.name, 'Squad 1');
    assert.equal(first.deleteDelaySec, -1, 'permanent');
    assert.equal(first.parentId, 80n);

    // someone takes the empty one: another appears
    const ann = h.adapter.addUser(10, 'Ann', first.id);
    dir(h);
    await until(() => h.adapter.created.some((c) => c.name === 'Squad 2'), 5000, 'Squad 2');
    // nothing more while one is empty
    dir(h);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.adapter.created.length, 2);

    // off: the empty one goes, the one in use stays
    assert.match(await say(h, admin, '!rooms spare off'), /is off/);
    const second = h.adapter.created.at(-1)!;
    assert.deepEqual(h.adapter.deleted, [second.id]);
    assert.ok(h.adapter.chans.some((c) => c.id === first.id));
    ann.channelId = CH.a;
    dir(h);
    await until(() => h.adapter.deleted.includes(first.id), 5000, 'the last spare to go once empty');
  } finally {
    h.cleanup();
  }
});

// ---- bad channel names -------------------------------------------------------------------------------

test('channelBlockedWord matches spaced-out words but does not read numbers as letters', () => {
  assert.equal(channelBlockedWord('Room 455', ['ass']), undefined);
  assert.equal(channelBlockedWord('My B.A.D-W O R D room', ['badword']), 'badword');
  assert.equal(channelBlockedWord('Nice Place', ['badword']), undefined);
  assert.equal(channelBlockedWord('[cspacer]--------', ['spacer']), undefined, 'spacer tags are not part of the name');
});

test('!channelfilter leaves existing channels alone, renames new bad ones, and can remove empty ones', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'nickfilter'] }) });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    h.adapter.chans.push({ id: 90n, name: 'badword lounge', parentId: 0n });
    assert.match(await say(h, admin, '!channelfilter on'), /Add a blocked word first/);
    await say(h, admin, '!nickfilter add badword');
    assert.match(await say(h, admin, '!channelfilter on'), /left these existing channels alone: "badword lounge"/);
    dir(h);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.adapter.renames.length, 0);

    // someone makes a new bad channel and sits in it
    h.adapter.chans.push({ id: 91n, name: 'b a d w o r d s', parentId: 0n });
    const sam = h.adapter.addUser(11, 'Sam', 91n);
    dir(h);
    await until(() => h.adapter.renames.some((r) => r.id === 91n && r.name === 'Renamed Channel'), 5000, 'the rename');
    await until(() => h.adapter.sent.some((s) => s.to === sam.id && /renamed your channel/.test(s.text)), 5000, 'Sam told');
    await until(() => h.adapter.sent.some((s) => s.to === admin.id && /Channel name filter: renamed "b a d w o r d s"/.test(s.text)), 5000, 'admin told');

    // delete mode removes an empty one
    assert.match(await say(h, admin, '!channelfilter action delete'), /removed/);
    h.adapter.chans.push({ id: 92n, name: 'BADWORD 2', parentId: 0n });
    dir(h);
    await until(() => h.adapter.deleted.includes(92n), 5000, 'the empty bad channel removed');

    // check fixes the ones that were left alone too (renamed: empty-or-not, it has a unique name now)
    assert.match(await say(h, admin, '!channelfilter check'), /removed "badword lounge"/);
  } finally {
    h.cleanup();
  }
});

// ---- the server name and the support channel ---------------------------------------------------------

test('renderLiveName takes a longer limit for the server name', () => {
  const v = { online: 3, record: 9, song: '' };
  assert.equal(renderLiveName('TGSC Gaming Community | {online} online (record {record})', v, 64), 'TGSC Gaming Community | 3 online (record 9)');
  assert.equal(renderLiveName('TGSC Gaming Community | {online} online (record {record})', v).length, 40);
});

test('!servername keeps the server name live, and explains a missing permission', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'servertools'] }) });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    h.adapter.addUser(10, 'Ann', CH.a);
    dir(h);
    assert.match(await say(h, admin, '!servername on'), /Set the template first/);
    assert.match(await say(h, admin, '!servername set TGSC'), /Put at least one of/);
    assert.match(await say(h, admin, '!servername set TGSC | {online} online (record {record})'), /named like: TGSC \| 2 online \(record 2\)/);
    assert.equal(h.adapter.serverRenames.length, 0, 'nothing happens while off');
    assert.match(await say(h, admin, '!servername on'), /It's now: TGSC \| 2 online \(record 2\)/);
    assert.deepEqual(h.adapter.serverRenames, ['TGSC | 2 online (record 2)']);
    h.adapter.failServerRename = new Error('insufficient client permissions (id=2568)');
    assert.match(await say(h, admin, '!servername now'), /b_virtualserver_modify_name/);
    assert.match(await say(h, admin, '!servername off'), /is off/);
  } finally {
    h.cleanup();
  }
});

test('!support opens the support channel while staff are here and closes it when they go away', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'servertools'] }) });
  try {
    h.adapter.chans.push({ id: 81n, name: 'Support', parentId: 0n });
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    assert.match(await say(h, admin, '!support on'), /Pick the channel first/);
    assert.match(await say(h, admin, '!support channel Support'), /support channel is "Support"/);
    assert.match(await say(h, admin, '!support names Support | Support (closed)'), /"Support" when open and "Support \(closed\)"/);
    assert.match(await say(h, admin, '!support delay 0'), /right away/);
    assert.match(await say(h, admin, '!support on'), /"Support" is open now \(staff here: 1\)/);
    assert.deepEqual(h.adapter.limitCalls.at(-1), { id: 81n, max: null });

    // the only staff member goes away: closed, and renamed
    admin.away = true;
    dir(h);
    await until(() => h.adapter.limitCalls.at(-1)?.max === 0, 10000, 'closed');
    await until(() => h.adapter.chans.find((c) => c.id === 81n)?.name === 'Support (closed)', 5000, 'renamed closed');

    // back: open again
    admin.away = false;
    dir(h);
    await until(() => h.adapter.limitCalls.at(-1)?.max === null && h.adapter.chans.find((c) => c.id === 81n)?.name === 'Support', 10000, 'open again');

    // a member of a staff group counts too
    assert.match(await say(h, admin, '!staff add 6'), /now count as staff/);
    assert.match(await say(h, admin, '!support'), /Staff here now \(online and not away\): Admin\./);

    assert.match(await say(h, admin, '!support off'), /is off, and "Support" is open to everyone/);
  } finally {
    h.cleanup();
  }
});

// ---- auto-move by group ------------------------------------------------------------------------------

test('autoMoveRule picks the first rule that fits', () => {
  const rules = [{ group: 14, channel: '#1' }, { group: 15, channel: '#2' }];
  assert.equal(autoMoveRule([15, 14], rules)?.channel, '#1');
  assert.equal(autoMoveRule([15], rules)?.channel, '#2');
  assert.equal(autoMoveRule([99], rules), undefined);
});

test('!automove moves people in a group when they connect, and only then', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'grouptools'] }) });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    dir(h);
    assert.match(await say(h, admin, '!automove on'), /Add a rule first/);
    assert.match(await say(h, admin, '!automove add 14 | Gaming B'), /server group 14 who connect will be moved to "Gaming B"/);
    assert.match(await say(h, admin, '!automove on'), /is on/);

    const bob = h.adapter.addUser(10, 'Bob', CH.home, 'uid-Bob', [14]);
    const dan = h.adapter.addUser(11, 'Dan', CH.home, 'uid-Dan', [99]);
    dir(h);
    await until(() => h.adapter.userMoves.some((m) => m.id === bob.id && m.to === CH.b), 5000, 'Bob moved');
    await until(() => h.adapter.sent.some((s) => s.to === bob.id && /Welcome! I moved you to "Gaming B"/.test(s.text)), 5000, 'Bob told');
    assert.ok(!h.adapter.userMoves.some((m) => m.id === dan.id));

    // moving around later is left alone
    bob.channelId = CH.home;
    dir(h);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(h.adapter.userMoves.filter((m) => m.id === bob.id).length, 1);

    assert.match(await say(h, admin, '!automove'), /1\. server group 14 -> "Gaming B"/);
    assert.match(await say(h, admin, '!automove remove 1'), /no longer moved/);
  } finally {
    h.cleanup();
  }
});

// ---- the client list safety net ------------------------------------------------------------------------

test('computeFixes/applyFixes correct a stale client list until the library catches up', () => {
  const c = (id: number, ch: bigint) => ({ id, nickname: `n${id}`, uid: `u${id}`, serverGroups: [], channelID: ch, type: 0 });
  const lib = [c(1, 10n), c(2, 10n), c(3, 11n)];
  const server = [c(1, 12n), c(3, 11n), c(4, 10n)];
  const fixes = computeFixes(lib, server);
  assert.equal(fixCount(fixes), 3, 'one moved, one gone, one not listed');
  const view = applyFixes(lib, fixes);
  assert.deepEqual(view.map((x) => [x.id, x.channelID]), [[1, 12n], [3, 11n], [4, 10n]]);

  // the library hears about a later move for 1, sees 4 arrive and 2 leave: its own view wins
  const later = [c(1, 13n), c(3, 11n), c(4, 10n)];
  assert.deepEqual(applyFixes(later, fixes).map((x) => [x.id, x.channelID]), [[1, 13n], [3, 11n], [4, 10n]]);
  assert.equal(fixCount(fixes), 0, 'every correction dropped once the library caught up');
  assert.equal(applyFixes(lib, emptyFixes()), lib);
});
