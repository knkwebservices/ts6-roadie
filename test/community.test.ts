import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import type { CommunityService } from '../src/core/services.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const AFK = 20n;
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

/** A bot with the community cog on, an "AFK Room" channel, and fast timers so the tests are quick. */
async function makeRig(community: Record<string, unknown> = {}): Promise<Harness> {
  const h = await makeBot({
    config: makeConfig({
      cogs: ['core', 'community'],
      community: { afk: { minutes: 0.02, warnSeconds: 0.6, checkSeconds: 0.05, ...((community.afk as object) ?? {}) }, welcome: { cooldownSeconds: 60, ...((community.welcome as object) ?? {}) } },
    }),
  });
  h.adapter.chans.push({ id: AFK, name: 'AFK Room', parentId: 0n });
  return h;
}

async function say(h: Harness, user: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  h.adapter.say(user, text);
  await until(() => h.adapter.sent.length > n, 10000, `an answer to ${text}`);
  return h.adapter.sent[n]!.text;
}
const to = (h: Harness, user: TsUser) => h.adapter.sent.filter((s) => s.kind === 'private' && s.to === user.id).map((s) => s.text);
const join = (h: Harness, id: number, name: string, ch = CH.home, uid = `uid-${name}`): TsUser => {
  const u = h.adapter.addUser(id, name, ch, uid);
  h.adapter.events.emit('directory');
  return u;
};

// ---- the welcome message ---------------------------------------------------------------------

test('the welcome message is off until an admin turns it on, then greets each person who joins by name', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const early = h.adapter.addUser(5, 'Early', CH.home);
    h.adapter.events.emit('directory');

    const a = join(h, 10, 'Ann');
    await pause(50);
    assert.deepEqual(to(h, a), [], 'off by default');

    assert.match(await say(h, admin, '!welcome'), /The welcome message is off\. Everyone who joins gets:\nWelcome, \{name\}! I'm the music bot/);
    assert.match(await say(h, admin, '!welcome on'), /is on/);
    const b = join(h, 11, 'Bob');
    await until(() => to(h, b).length === 1, 10000, 'the greeting');
    assert.equal(to(h, b)[0], "Welcome, Bob! I'm the music bot. Send me a private message saying !help to see what I can do.");
    assert.deepEqual(to(h, early), [], 'people who were already there are not greeted');
    assert.deepEqual(to(h, admin).filter((t) => /Welcome, Admin/.test(t)), []);

    // moving between channels is not joining
    b.channelId = CH.a;
    h.adapter.events.emit('directory');
    await pause(50);
    assert.equal(to(h, b).length, 1);
  } finally {
    h.cleanup();
  }
});

test('the welcome text can be changed and tested, is for admins, and is kept', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const alice = h.adapter.addUser(5, 'Alice', CH.home);
    for (const c of ['!welcome', '!welcome on', '!welcome set hi', '!afk', '!afk on']) assert.match(await say(h, alice, c), /admins only/i, c);

    assert.match(await say(h, admin, '!welcome set Hi {name}, read #rules! Have fun, {name}.'), /Saved\. This is what people will see:\nHi Admin, read #rules! Have fun, Admin\./);
    assert.equal(await say(h, admin, '!welcome test'), 'Hi Admin, read #rules! Have fun, Admin.');
    assert.match(await say(h, admin, '!welcome set'), /up to 500 characters/);
    assert.match(await say(h, admin, `!welcome set ${'x'.repeat(501)}`), /up to 500 characters/);
    assert.match(await say(h, admin, '!welcome sideways'), /Usage/);
    assert.deepEqual(h.bot.state.get('community.welcome', null), { enabled: false, message: 'Hi {name}, read #rules! Have fun, {name}.' });

    await say(h, admin, '!welcome on');
    const c = join(h, 12, 'Cy');
    await until(() => to(h, c).length === 1, 10000, 'the greeting');
    assert.equal(to(h, c)[0], 'Hi Cy, read #rules! Have fun, Cy.');
  } finally {
    h.cleanup();
  }
});

test('the same person reconnecting straight away is not greeted twice, but is greeted again later', async () => {
  const h = await makeRig({ welcome: { enabled: true, cooldownSeconds: 0.4 } });
  try {
    const first = join(h, 10, 'Dee', CH.home, 'uid-dee');
    await until(() => to(h, first).length === 1, 10000, 'the first greeting');

    h.adapter.userList.splice(h.adapter.userList.indexOf(first), 1);
    h.adapter.events.emit('directory');
    const again = join(h, 11, 'Dee', CH.home, 'uid-dee'); // a new connection, straight away
    await pause(100);
    assert.deepEqual(to(h, again), [], 'too soon');

    await pause(500);
    h.adapter.userList.splice(h.adapter.userList.indexOf(again), 1);
    h.adapter.events.emit('directory');
    const later = join(h, 12, 'Dee', CH.home, 'uid-dee');
    await until(() => to(h, later).length === 1, 10000, 'the greeting after the wait');
  } finally {
    h.cleanup();
  }
});

test('after the bot reconnects, the people already there are not greeted as if they had just joined', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const here = h.adapter.addUser(5, 'Here', CH.home);
    h.adapter.events.emit('directory'); // (the greeting is still off, so this is not a welcome)
    await say(h, admin, '!welcome on');
    h.bot.events.emit('ready'); // a fresh connection; the list is being rebuilt
    h.adapter.events.emit('directory');
    await pause(100);
    assert.deepEqual(to(h, here), []);

    await pause(2200); // the short settling time after connecting
    const late = join(h, 9, 'Late');
    await until(() => to(h, late).length === 1, 10000, 'the greeting for a genuinely new person');
    assert.deepEqual(to(h, here), []);
  } finally {
    h.cleanup();
  }
});

// ---- the AFK mover -------------------------------------------------------------------------------

const enabled = { afk: { enabled: true } };

test('a person who stays muted is warned, then moved to the AFK channel, and told', async () => {
  const h = await makeRig(enabled);
  try {
    const alice = h.adapter.addUser(5, 'Alice', CH.a);
    const admin = h.adapter.addUser(6, 'Admin', CH.a, 'uid-Admin');
    alice.inputMuted = true;
    admin.inputMuted = true; // admins are never moved

    await until(() => to(h, alice).some((t) => /muted for a while.*"AFK Room"/.test(t)), 10000, 'the warning');
    assert.deepEqual(h.adapter.userMoves, [], 'not moved yet');
    await until(() => h.adapter.userMoves.length === 1, 10000, 'the move');
    assert.deepEqual(h.adapter.userMoves, [{ id: 5, to: AFK }]);
    await until(() => to(h, alice).some((t) => /I moved you to "AFK Room" because you were muted for 0\.02 minutes\. I'll move you back/.test(t)), 10000, 'the message');
    assert.equal(to(h, alice).filter((t) => /muted for a while/.test(t)).length, 1, 'warned once');
    await pause(300);
    assert.equal(h.adapter.userMoves.length, 1, 'nobody else was moved: the admin is exempt');
    assert.deepEqual(to(h, admin), []);
  } finally {
    h.cleanup();
  }
});

test('away counts, speakers muted counts, and a person who comes back in time is left alone', async () => {
  const h = await makeRig({ afk: { enabled: true, minutes: 0.03, warnSeconds: 0.8 } });
  try {
    const away = h.adapter.addUser(5, 'Away', CH.a);
    const deaf = h.adapter.addUser(6, 'Deaf', CH.b);
    const back = h.adapter.addUser(7, 'Back', CH.a);
    away.away = true;
    deaf.outputMuted = true;
    back.away = true;
    await until(() => to(h, back).length === 1, 10000, "Back's warning");
    back.away = false; // in time
    await until(() => h.adapter.userMoves.length === 2, 10000, 'the other two to be moved');
    assert.deepEqual(h.adapter.userMoves.map((m) => m.id).sort(), [5, 6]);
    await pause(500);
    assert.equal(h.adapter.userMoves.length, 2, 'Back stayed');
  } finally {
    h.cleanup();
  }
});

test('idle time counts too, and comes from the server', async () => {
  const h = await makeRig(enabled);
  try {
    const idle = h.adapter.addUser(5, 'Idle', CH.a);
    const busy = h.adapter.addUser(6, 'Busy', CH.a);
    const silent = h.adapter.addUser(7, 'Silent', CH.a); // the server will not say
    h.adapter.idle.set(5, 3600);
    h.adapter.idle.set(6, 0); // (the AFK time in these tests is only a second or so)
    await until(() => h.adapter.userMoves.length === 1, 10000, 'the idle person to be moved');
    assert.deepEqual(h.adapter.userMoves, [{ id: 5, to: AFK }]);
    await pause(300);
    assert.equal(h.adapter.userMoves.length, 1);
    assert.deepEqual([to(h, busy), to(h, silent)], [[], []]);
  } finally {
    h.cleanup();
  }
});

test('an idle time that is out of date is checked again before anyone is moved', async () => {
  const h = await makeRig({ afk: { enabled: true, minutes: 30, warnSeconds: 60 } });
  const realNow = Date.now;
  let offset = 0;
  try {
    Date.now = () => realNow() + offset;
    const alice = h.adapter.addUser(5, 'Alice', CH.a);
    h.adapter.idle.set(5, 25 * 60); // the server says: idle for 25 minutes
    await until(() => h.adapter.idleCalls.length >= 1, 10000, 'the first look');

    h.adapter.idle.set(5, 3); // ...but a minute later she is back at the keyboard
    offset = 6 * 60_000; // (the clock jumps on: by the old figure she would now be at 31 minutes)
    await until(() => h.adapter.idleCalls.length >= 2, 10000, 'a second look before acting');
    await pause(300);
    assert.deepEqual(h.adapter.userMoves, [], 'she was not moved');
    assert.deepEqual(to(h, alice), [], 'and not warned');

    // the same person really staying idle is warned and then moved
    h.adapter.idle.set(5, 40 * 60);
    offset += 10 * 60_000;
    await until(() => h.adapter.userMoves.length === 1, 10000, 'the move for someone who really is idle');
  } finally {
    Date.now = realNow;
    h.cleanup();
  }
});

test('someone who was moved is brought back when they are active again, and only then', async () => {
  const h = await makeRig(enabled);
  try {
    const alice = h.adapter.addUser(5, 'Alice', CH.a);
    alice.inputMuted = true;
    await until(() => h.adapter.userMoves.length === 1, 10000, 'the move');
    assert.equal(alice.channelId, AFK);
    assert.equal(h.bot.services.get<CommunityService>('community')!.state().afk.moved[0]!.name, 'Alice');

    await pause(300);
    assert.equal(h.adapter.userMoves.length, 1, 'still muted: she stays in the AFK channel');

    alice.inputMuted = false;
    h.adapter.idle.set(5, 3600); // unmuted but the server says she has done nothing
    await pause(300);
    assert.equal(h.adapter.userMoves.length, 1, 'no activity yet: she stays');

    h.adapter.idle.set(5, 0);
    await until(() => h.adapter.userMoves.length === 2, 10000, 'the move back');
    assert.deepEqual(h.adapter.userMoves[1], { id: 5, to: CH.a });
    assert.ok(to(h, alice).some((t) => /Welcome back! I moved you back to "Gaming A"/.test(t)));
    assert.deepEqual(h.bot.services.get<CommunityService>('community')!.state().afk.moved, []);
    await pause(300);
    assert.equal(h.adapter.userMoves.length, 2, 'and not again');
  } finally {
    h.cleanup();
  }
});

test('someone who leaves the AFK channel by themselves is not moved back, and people who chose the AFK channel are left alone', async () => {
  const h = await makeRig(enabled);
  try {
    const alice = h.adapter.addUser(5, 'Alice', CH.a);
    const sleeper = h.adapter.addUser(6, 'Sleeper', AFK); // went there on their own
    sleeper.inputMuted = true;
    alice.inputMuted = true;
    await until(() => h.adapter.userMoves.length === 1, 10000, 'the move');
    alice.channelId = CH.b; // she goes somewhere else herself
    alice.inputMuted = false;
    h.adapter.idle.set(5, 0);
    await pause(400);
    assert.equal(h.adapter.userMoves.length, 1, 'not moved back');
    assert.deepEqual(h.bot.services.get<CommunityService>('community')!.state().afk.moved, [], 'and forgotten');
    assert.equal(sleeper.channelId, AFK, 'the one who chose it is left alone');
  } finally {
    h.cleanup();
  }
});

test('exempt people: bot admins, chosen server groups and chosen channels', async () => {
  const h = await makeRig({ afk: { enabled: true, exemptGroups: [9], ignoreChannels: ['Staff Room'] } });
  try {
    const grouped = h.adapter.addUser(5, 'Grouped', CH.a, 'uid-g', [9]);
    const staff = h.adapter.addUser(6, 'Staff', CH.staff);
    const normal = h.adapter.addUser(7, 'Normal', CH.b);
    for (const u of [grouped, staff, normal]) u.inputMuted = true;
    await until(() => h.adapter.userMoves.length === 1, 10000, 'the ordinary move');
    await pause(500);
    assert.deepEqual(h.adapter.userMoves, [{ id: 7, to: AFK }], 'only the ordinary person');
  } finally {
    h.cleanup();
  }
});

test('when a move fails the bot does not crash or pester, and leaves that person alone for a while', async () => {
  const h = await makeRig(enabled);
  try {
    const alice = h.adapter.addUser(5, 'Alice', CH.a);
    alice.inputMuted = true;
    h.adapter.failMoveUser = new Error('insufficient client permissions');
    await until(() => h.adapter.moveUserCalls >= 1, 10000, 'the attempt');
    await pause(400);
    assert.equal(h.adapter.moveUserCalls, 1, 'one attempt, then a wait');
    assert.equal(alice.channelId, CH.a);
    assert.deepEqual(h.bot.services.get<CommunityService>('community')!.state().afk.moved, []);
  } finally {
    h.cleanup();
  }
});

test('the mover asks the server about idle time for only a few people at a time, and gets round to everyone', async () => {
  const h = await makeRig(enabled);
  try {
    const ids = Array.from({ length: 12 }, (_, i) => 100 + i);
    for (const id of ids) {
      h.adapter.addUser(id, `User${id}`, CH.a);
      h.adapter.idle.set(id, 0);
    }
    await pause(120); // about two checks
    assert.ok(h.adapter.idleCalls.length <= 10, `${h.adapter.idleCalls.length} questions in about two checks`);
    await until(() => new Set(h.adapter.idleCalls).size === 12, 10000, 'everybody to have been asked about');
    assert.deepEqual(h.adapter.userMoves, []);
  } finally {
    h.cleanup();
  }
});

test('!afk shows what it is doing and changes its settings, keeping them', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    assert.match(await say(h, admin, '!afk'), /AFK mover is off\. It moves people who have been away, muted or idle for 0\.02 minutes to "AFK Room"\. They get a warning 0\.6 seconds before\./);
    assert.match(await say(h, admin, '!afk minutes 45'), /after 45 minutes/);
    assert.match(await say(h, admin, '!afk minutes 0'), /from 1 to 1440/);
    assert.match(await say(h, admin, '!afk minutes soon'), /from 1 to 1440/);
    assert.match(await say(h, admin, '!afk channel Nowhere'), /cannot find a channel called "Nowhere"/);
    assert.match(await say(h, admin, '!afk channel staff room'), /now "Staff Room"/);
    assert.match(await say(h, admin, '!afk on'), /AFK mover is on: after 45 minutes .* "Staff Room"/);
    assert.deepEqual(h.bot.state.get('community.afk', null), { enabled: true, channel: 'Staff Room', minutes: 45 });
    assert.match(await say(h, admin, '!afk'), /AFK mover is on\..*45 minutes to "Staff Room"\./);
    assert.match(await say(h, admin, '!afk off'), /is off/);
    assert.match(await say(h, admin, '!afk sideways'), /Usage/);
    const svc = h.bot.services.get<CommunityService>('community')!.state();
    assert.deepEqual([svc.afk.enabled, svc.afk.channel, svc.afk.minutes, svc.afk.channelFound], [false, 'Staff Room', 45, true]);
  } finally {
    h.cleanup();
  }
});

test('with no channel of that name the mover refuses to start, and does nothing if configured anyway', async () => {
  const h = await makeRig({ afk: { enabled: true, channel: 'No Such Room' } });
  try {
    const admin = h.adapter.addUser(6, 'Admin', CH.home, 'uid-Admin');
    const u = h.adapter.addUser(5, 'Alice', CH.a);
    u.inputMuted = true;
    await pause(400);
    assert.deepEqual(h.adapter.userMoves, []);
    assert.match(await say(h, admin, '!afk'), /I cannot find that channel!/);
    await say(h, admin, '!afk off');
    assert.match(await say(h, admin, '!afk on'), /cannot find a channel called "No Such Room"/);
  } finally {
    h.cleanup();
  }
});

test('the community settings are checked when the config is read', () => {
  const c = buildConfig({});
  assert.deepEqual([c.community.afk.enabled, c.community.afk.minutes, c.community.afk.channel, c.community.afk.warnSeconds], [false, 30, 'AFK Room', 60]);
  assert.equal(c.community.welcome.enabled, false);
  assert.throws(() => buildConfig({ community: { afk: { minutes: 0 } } }), /afk\.minutes/);
  assert.throws(() => buildConfig({ community: { afk: { minutes: 2000 } } }), /afk\.minutes/);
  assert.throws(() => buildConfig({ community: { afk: { channel: '' } } }), /afk\.channel/);
  assert.throws(() => buildConfig({ community: { afk: { warnSeconds: -1 } } }), /warnSeconds/);
  assert.throws(() => buildConfig({ community: { afk: { exemptGroups: ['x'] } } }), /exemptGroups/);
  assert.throws(() => buildConfig({ community: { afk: { ignoreChannels: [1] } } }), /ignoreChannels/);
  assert.throws(() => buildConfig({ community: { welcome: { message: '' } } }), /welcome\.message/);
  assert.throws(() => buildConfig({ community: { welcome: { message: 'x'.repeat(501) } } }), /welcome\.message/);
  assert.throws(() => buildConfig({ community: { welcome: { cooldownSeconds: -5 } } }), /cooldownSeconds/);
  assert.doesNotThrow(() => buildConfig({ community: { afk: { enabled: true, minutes: 10, exemptGroups: [6, 7], ignoreChannels: ['Music'] }, welcome: { enabled: true, message: 'Hi {name}' } } }));
});
