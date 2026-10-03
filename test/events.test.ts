import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import { EVENTS_SERVICE, type EventsService } from '../src/core/services.js';
import { formatUntil, parseWhen } from '../src/cogs/events/when.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function makeRig(over: Record<string, unknown> = {}): Promise<Harness> {
  return makeBot({ config: makeConfig({ cogs: ['core', 'events'], ...over }) });
}
async function say(h: Harness, user: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  const mine = () => h.adapter.sent.slice(n).find((s) => s.kind === 'private' && s.to === user.id);
  h.adapter.say(user, text);
  await until(() => !!mine(), 10000, `an answer to ${text}`);
  return mine()!.text;
}
const posted = (h: Harness, kind: 'channel' | 'server' = 'channel') => h.adapter.sent.filter((s) => s.kind === kind).map((s) => s.text);
const pokes = (h: Harness, u: TsUser) => h.adapter.sent.filter((s) => s.kind === 'poke' && s.to === u.id).map((s) => s.text);
const svc = (h: Harness) => h.bot.services.get<EventsService>(EVENTS_SERVICE)!;

// ---- reading "when" ---------------------------------------------------------------------------------

// Wednesday 2026-09-30, 15:00 local time
const NOW = new Date(2026, 8, 30, 15, 0, 0);
const parsed = (s: string) => {
  const w = parseWhen(s, NOW);
  assert.ok(typeof w !== 'string', `"${s}" should parse, got: ${w}`);
  return w;
};
const local = (d: Date) => `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;

test('when: day names, today, tomorrow, bare times, dates, "in", and weekly', () => {
  assert.equal(local(parsed('Friday 8pm').at), '2026-10-2 20:00');
  assert.equal(local(parsed('fri 20:00').at), '2026-10-2 20:00');
  assert.equal(local(parsed('wednesday 9pm').at), '2026-9-30 21:00', 'later today');
  assert.equal(local(parsed('wed 2pm').at), '2026-10-7 14:00', 'already passed today: next week');
  assert.equal(local(parsed('tomorrow 7:30pm').at), '2026-10-1 19:30');
  assert.equal(local(parsed('today 6 pm').at), '2026-9-30 18:00');
  assert.equal(local(parsed('8pm').at), '2026-9-30 20:00');
  assert.equal(local(parsed('9am').at), '2026-10-1 9:00', 'a bare time already gone today is tomorrow');
  assert.equal(local(parsed('10/31 8pm').at), '2026-10-31 20:00');
  assert.equal(local(parsed('2026-12-25 noon').at), '2026-12-25 12:00');
  assert.equal(local(parsed('3/1 8pm').at), '2027-3-1 20:00', 'a past date with no year is next year');
  assert.equal(parsed('in 2h').at.getTime() - NOW.getTime(), 2 * 3_600_000);
  assert.equal(parsed('in 1h30m').at.getTime() - NOW.getTime(), 90 * 60_000);
  assert.equal(parsed('in 45 minutes').at.getTime() - NOW.getTime(), 45 * 60_000);
  const wk = parsed('weekly Friday 8pm');
  assert.equal(wk.weekly, true);
  assert.equal(local(wk.at), '2026-10-2 20:00');
  assert.equal(parsed('every sat 9pm').weekly, true);
});

test('when: things that are not understood say so', () => {
  assert.match(String(parseWhen('', NOW)), /Say when/);
  assert.match(String(parseWhen('Friday', NOW)), /couldn't find a time/);
  assert.match(String(parseWhen('friday 8', NOW)), /couldn't find a time/, 'a bare "8" is ambiguous');
  assert.match(String(parseWhen('someday 8pm', NOW)), /didn't understand the day/);
  assert.match(String(parseWhen('today 9am', NOW)), /already passed/);
  assert.match(String(parseWhen('2/30 8pm', NOW)), /no date/);
  assert.match(String(parseWhen('in soon', NOW)), /didn't understand/);
  assert.match(String(parseWhen('25:00', NOW)), /couldn't find a time/);
  assert.equal(formatUntil(30_000), 'now');
  assert.equal(formatUntil(12 * 60_000), 'in 12 min');
  assert.equal(formatUntil(5 * 3_600_000 + 20 * 60_000), 'in 5 h 20 min');
  assert.equal(formatUntil(3 * 86_400_000), 'in 3 days');
});

test('events settings have safe defaults and are checked', () => {
  const c = buildConfig({});
  assert.equal(c.events.enabled, true);
  assert.equal(c.events.whoCanAdd, 'admins');
  assert.equal(c.announcements.enabled, false);
  assert.throws(() => buildConfig({ events: { whoCanAdd: 'mods' } }), /events\.whoCanAdd/);
  assert.throws(() => buildConfig({ announcements: { everyMinutes: 1 } }), /announcements\.everyMinutes/);
  assert.equal(c.events.postTo, 'channel');
  assert.throws(() => buildConfig({ events: { postTo: 'everywhere' } }), /events\.postTo/);
});

test('with postTo "server", announcements go to the server-wide chat', async () => {
  const h = await makeRig({ announcements: { postTo: 'server' } });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    await say(h, admin, '!announce add Hello everyone');
    await say(h, admin, '!announce now');
    assert.deepEqual(posted(h, 'server'), ['Hello everyone']);
    assert.deepEqual(posted(h, 'channel'), []);
  } finally {
    h.cleanup();
  }
});

// ---- events -----------------------------------------------------------------------------------------

test('events: admins add them, people sign up, a reminder is posted before and the going list is poked at the start', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    const bob = h.adapter.addUser(11, 'Bob', CH.b);

    assert.match(await say(h, ann, '!events'), /^No events coming up\.$/);
    assert.match(await say(h, ann, '!event add tomorrow 8pm | Nope'), /Only bot admins can add events/);
    assert.match(await say(h, admin, '!event add tomorrow 8pm'), /Usage/);
    assert.match(await say(h, admin, '!event add someday 8pm | Raid'), /didn't understand the day/);
    assert.match(await say(h, admin, '!event add in 90m | Nuke run'), /^Added #1: Nuke run, .+ \(in 1 h 30 min\)\. I'll post a reminder 60 min before\. People can send !going 1\.$/);

    // with only one event, !going needs no number
    assert.match(await say(h, ann, '!going'), /You're going to Nuke run/);
    assert.match(await say(h, ann, '!going 1'), /already down/);
    assert.match(await say(h, bob, '!going 1'), /You're going/);
    assert.match(await say(h, bob, '!notgoing'), /off the list/);
    assert.match(await say(h, bob, '!events'), /Coming up:\n#1 Nuke run: .+ \(in 1 h 30 min\), 1 going/);
    assert.match(await say(h, bob, '!event 1'), /Added by Admin\. Going: Ann\./);

    // nothing is due yet
    await svc(h).check();
    assert.deepEqual(posted(h), []);

    // 59 minutes before: the reminder goes out once
    const ev = h.bot.state.get<{ at: number }[]>('events.list', [])[0]!;
    ev.at = Date.now() + 59 * 60_000;
    await svc(h).check();
    await svc(h).check();
    assert.equal(posted(h).length, 1);
    assert.match(posted(h)[0]!, /^Reminder: Nuke run starts in 59 min \(.+\)\. Send me !going 1 to get a poke when it starts\.$/);
    // the people going are told privately too, wherever they are
    assert.ok(h.adapter.sent.some((x) => x.kind === 'private' && x.to === 10 && /^Reminder: Nuke run starts in 59 min .+ You said you're going\.$/.test(x.text)));
    assert.ok(!h.adapter.sent.some((x) => x.kind === 'private' && x.to === 11 && /^Reminder/.test(x.text)), 'Bob is not going');

    // start time: posted, the going list is poked, and the one-off event is gone
    ev.at = Date.now() - 1000;
    await svc(h).check();
    assert.equal(posted(h).at(-1), 'Starting now: Nuke run!');
    assert.deepEqual(pokes(h, ann), ['Nuke run is starting now!']);
    assert.deepEqual(pokes(h, bob), []);
    assert.deepEqual(svc(h).upcoming(), []);
  } finally {
    h.cleanup();
  }
});

test('events: weekly events roll on to next week with a fresh going list, and a start missed while the bot was down is not announced late', async () => {
  const h = await makeRig({ events: { whoCanAdd: 'everyone' } });
  try {
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    assert.match(await say(h, ann, '!event add weekly friday 8pm | Nuke Friday'), /every week/);
    assert.match(await say(h, ann, '!going'), /going/);
    const list = h.bot.state.get<{ at: number; going: unknown[] }[]>('events.list', []);
    const first = list[0]!.at;
    list[0]!.at = Date.now() - 1000;
    await svc(h).check();
    assert.equal(posted(h).at(-1), 'Starting now: Nuke Friday!');
    const next = svc(h).upcoming()[0]!;
    assert.equal(next.going.length, 0, 'a new week, a new list');
    assert.ok(next.at > Date.now() && next.at - Date.now() <= 7 * 86_400_000);
    void first;

    // the bot was down at the start: skipped quietly
    const before = posted(h).length;
    h.bot.state.get<{ at: number }[]>('events.list', [])[0]!.at = Date.now() - 2 * 3_600_000;
    await svc(h).check();
    assert.equal(posted(h).length, before);
    assert.ok(svc(h).upcoming()[0]!.at > Date.now());

    // only the person who added it (or an admin) can remove it
    const bob = h.adapter.addUser(11, 'Bob', CH.b);
    const id = svc(h).upcoming()[0]!.id;
    assert.match(await say(h, bob, `!event remove ${id}`), /Only the person who added it/);
    assert.match(await say(h, ann, `!event remove ${id}`), /Removed #1/);
  } finally {
    h.cleanup();
  }
});

// ---- announcements ----------------------------------------------------------------------------------

test('announcements rotate through the messages, only when someone is online', async () => {
  const h = await makeRig({ announcements: { everyMinutes: 5 } });
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const ann = h.adapter.addUser(10, 'Ann', CH.a);
    assert.match(await say(h, ann, '!announce'), /admin/i);
    assert.match(await say(h, admin, '!announce on'), /Add a message first/);
    assert.match(await say(h, admin, '!announce add Visit tgscgaming.com'), /Added as message 1/);
    assert.match(await say(h, admin, '!announce add Be nice'), /Added as message 2/);
    assert.match(await say(h, admin, '!announce every 2'), /from 5 to 1440/);
    assert.match(await say(h, admin, '!announce on'), /first one goes out in 5 minutes/);

    await svc(h).check();
    assert.deepEqual(posted(h), [], 'not yet');
    const set = () => h.bot.state.get<{ lastAt: number }>('announce.settings', { lastAt: 0 });
    set().lastAt = 0;
    await svc(h).check();
    set().lastAt = 0;
    await svc(h).check();
    set().lastAt = 0;
    await svc(h).check();
    assert.deepEqual(posted(h), ['Visit tgscgaming.com', 'Be nice', 'Visit tgscgaming.com']);

    assert.match(await say(h, admin, '!announce now'), /Posted/);
    assert.equal(posted(h).at(-1), 'Be nice');

    // nobody online: nothing posted
    h.adapter.userList = [];
    set().lastAt = 0;
    const n = posted(h).length;
    await svc(h).check();
    assert.equal(posted(h).length, n);
    void pause;
  } finally {
    h.cleanup();
  }
});
