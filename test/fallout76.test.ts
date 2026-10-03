import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { Fallout76Deps } from '../src/cogs/fallout76/index.js';
import { BUILT_IN, noonEastern, parseDay, parsePlace, schedule, visitTimes, whereIs } from '../src/cogs/fallout76/minerva.js';
import { fetchNukeCodes, NukesError, parseCodes, type NukeCodes } from '../src/cogs/fallout76/nukes.js';
import { CH, makeBot, makeConfig, until } from './helpers.js';

const SAMPLE = { date: '2026-10-02 00:00:00Z', since_epoch: 1790899200, ALPHA: '66835244', BRAVO: '06206397', CHARLIE: '17189221' };
const DAY = 24 * 3_600_000;

// ---- nukes.ts ---------------------------------------------------------------------------

test('parseCodes reads NukaCrypt\'s reply and works out the weekly reset', () => {
  const c = parseCodes(SAMPLE);
  assert.equal(c.alpha, '66835244');
  assert.equal(c.bravo, '06206397', 'a leading zero is kept');
  assert.equal(c.charlie, '17189221');
  assert.equal(c.from, Date.parse('2026-10-02T00:00:00Z'));
  assert.equal(c.until, c.from + 7 * DAY);
  // with no usable date, since_epoch is used
  assert.equal(parseCodes({ ...SAMPLE, date: 'soon' }).from, 1790899200 * 1000);
});

test('parseCodes refuses replies that are not codes', () => {
  assert.throws(() => parseCodes(null), NukesError);
  assert.throws(() => parseCodes({ ...SAMPLE, BRAVO: '123' }), /all three codes/);
  assert.throws(() => parseCodes({ ALPHA: '11111111', BRAVO: '22222222', CHARLIE: '33333333' }), /which week/);
});

test('fetchNukeCodes explains HTTP errors and bad JSON in plain English', async () => {
  const ok = async (_url: string, init: RequestInit) => {
    const h = new Headers(init.headers);
    assert.equal(h.get('accept'), null, 'NukaCrypt answers 406 to Accept: application/json');
    return new Response(JSON.stringify(SAMPLE), { status: 200 });
  };
  assert.equal((await fetchNukeCodes(ok as typeof fetch)).alpha, '66835244');
  const down = async () => new Response('busy', { status: 503 });
  await assert.rejects(fetchNukeCodes(down as typeof fetch), /HTTP 503/);
  const junk = async () => new Response('<html>', { status: 200 });
  await assert.rejects(fetchNukeCodes(junk as typeof fetch), /didn't look like JSON/);
  const offline = async () => {
    throw new TypeError('fetch failed');
  };
  await assert.rejects(fetchNukeCodes(offline as typeof fetch), /Could not reach NukaCrypt/);
});

// ---- minerva.ts -------------------------------------------------------------------------

test('noon US Eastern follows daylight saving', () => {
  assert.equal(new Date(noonEastern('2026-10-19')).toISOString(), '2026-10-19T16:00:00.000Z'); // EDT
  assert.equal(new Date(noonEastern('2026-11-02')).toISOString(), '2026-11-02T17:00:00.000Z'); // EST
  assert.ok(Number.isNaN(noonEastern('nope')));
});

test('regular visits are Monday to Wednesday, Big Sales Thursday to Monday', () => {
  const reg = visitTimes({ start: '2026-10-19', place: 'Foundation' });
  assert.equal(new Date(reg.end).toISOString(), '2026-10-21T16:00:00.000Z');
  const sale = visitTimes({ start: '2026-10-08', place: 'Whitespring' });
  assert.equal(new Date(sale.end).toISOString(), '2026-10-12T16:00:00.000Z');
  // every built-in visit starts on the right weekday
  for (const v of BUILT_IN) {
    const wd = new Date(`${v.start}T12:00:00Z`).getUTCDay();
    assert.equal(wd, v.place === 'Whitespring' ? 4 : 1, `${v.start} ${v.place}`);
  }
});

test('places and dates are understood the way people type them', () => {
  assert.equal(parsePlace('fort atlas'), 'Fort Atlas');
  assert.equal(parsePlace('Atlas'), 'Fort Atlas');
  assert.equal(parsePlace('the Crater'), 'Crater');
  assert.equal(parsePlace('Whitespring Resort'), 'Whitespring');
  assert.equal(parsePlace('foundation'), 'Foundation');
  assert.equal(parsePlace('Vault 76'), undefined);
  assert.equal(parseDay('2027-2-1'), '2027-02-01');
  assert.equal(parseDay('2/1/2027'), '2027-02-01');
  assert.equal(parseDay('2027-02-30'), undefined);
  assert.equal(parseDay('Monday'), undefined);
});

test('whereIs finds her current and next visits; additions and removals apply', () => {
  const all = schedule([], []);
  const during = noonEastern('2026-10-09');
  const w = whereIs(all, during);
  assert.equal(w.current?.place, 'Whitespring');
  assert.equal(w.next[0]?.start, '2026-10-19');
  const away = whereIs(all, noonEastern('2026-10-14'));
  assert.equal(away.current, undefined);
  assert.equal(away.next[0]?.place, 'Foundation');

  const changed = schedule([{ start: '2026-10-19', place: 'Crater', list: 5 }, { start: '2027-02-01', place: 'Foundation' }], ['2026-10-26']);
  assert.equal(changed.find((v) => v.start === '2026-10-19')?.place, 'Crater', 'an addition replaces a built-in visit on the same day');
  assert.ok(!changed.some((v) => v.start === '2026-10-26'), 'removed');
  assert.equal(changed.at(-1)?.start, '2027-02-01');
});

// ---- the cog, in a real bot with a fake NukaCrypt and clock ---------------------------

const entry = resolve(import.meta.dirname, '../src/cogs/fallout76/index.ts');

async function makeRig(start: number) {
  let now = start;
  let reply: NukeCodes | Error = parseCodes(SAMPLE);
  let fetches = 0;
  const deps: Fallout76Deps = {
    now: () => now,
    fetchCodes: async () => {
      fetches++;
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
  (globalThis as Record<string, unknown>).__f76Deps = deps;
  const h = await makeBot({
    config: makeConfig({ cogs: ['core', 'f76test'] }),
    customCogs: {
      f76test: `
        import { createFallout76Cog } from ${JSON.stringify('file://' + entry)};
        export const manifest = { name: 'f76test', version: '1', description: 'fallout76 with fakes' };
        export default (bot) => createFallout76Cog(bot, globalThis.__f76Deps);`,
    },
  });
  const ask = async (who: ReturnType<typeof h.adapter.addUser>, text: string): Promise<string> => {
    const n = h.adapter.sent.length;
    h.adapter.say(who, text);
    await until(() => h.adapter.sent.length > n, 5000, `an answer to ${text}`);
    return h.adapter.sent.at(-1)!.text;
  };
  return {
    ...h,
    ask,
    fetches: () => fetches,
    setNow: (t: number) => (now = t),
    setReply: (r: NukeCodes | Error) => (reply = r),
  };
}

test('!nukes shows the codes with credit and fetches only once per week', async () => {
  const r = await makeRig(Date.parse('2026-10-03T12:00:00Z'));
  try {
    const ann = r.adapter.addUser(10, 'Ann', CH.home, 'uid-Ann');
    const out = await r.ask(ann, '!nukes');
    assert.match(out, /nuke codes, good until/);
    assert.match(out, /Alpha: 66835244\nBravo: 06206397\nCharlie: 17189221/);
    assert.match(out, /NukaCrypt \(nukacrypt\.com\)/);
    assert.match(await r.ask(ann, '!nukes bravo'), /Bravo: 06206397/);
    assert.doesNotMatch(r.adapter.lastReply(), /Alpha/);
    assert.equal(r.fetches(), 1, 'the second ask used the saved codes');
    assert.match(await r.ask(ann, '!nukes delta'), /Usage/);
    assert.match(await r.ask(ann, '!nukes refresh'), /admins only/i);
  } finally {
    r.cleanup();
  }
});

test('after the weekly reset it waits for new codes, retrying no more than every 15 minutes', async () => {
  const r = await makeRig(Date.parse('2026-10-03T12:00:00Z'));
  try {
    const ann = r.adapter.addUser(10, 'Ann', CH.home, 'uid-Ann');
    await r.ask(ann, '!nukes');
    // the codes change at 2026-10-09 00:00 UTC, but NukaCrypt still has last week's
    r.setNow(Date.parse('2026-10-09T00:30:00Z'));
    assert.match(await r.ask(ann, '!nukes'), /hasn't posted the new ones yet/);
    assert.equal(r.fetches(), 2);
    await r.ask(ann, '!nukes');
    assert.equal(r.fetches(), 2, 'no new fetch within 15 minutes');
    r.setReply(parseCodes({ ...SAMPLE, date: '2026-10-09 00:00:00Z', ALPHA: '12345678' }));
    r.setNow(Date.parse('2026-10-09T00:46:00Z'));
    assert.match(await r.ask(ann, '!nukes'), /Alpha: 12345678/);
    assert.equal(r.fetches(), 3);
  } finally {
    r.cleanup();
  }
});

test('when NukaCrypt is down, !nukes says so; an admin can force a refresh', async () => {
  const r = await makeRig(Date.parse('2026-10-03T12:00:00Z'));
  try {
    r.setReply(new NukesError('NukaCrypt would not give the codes (HTTP 503).'));
    const admin = r.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    assert.match(await r.ask(admin, '!nukes'), /couldn't get the nuke codes: .*HTTP 503\)\. Try again/);
    r.setReply(parseCodes(SAMPLE));
    assert.match(await r.ask(admin, '!nukes refresh'), /Alpha: 66835244/);
  } finally {
    r.cleanup();
  }
});

test('!minerva tells where she is and when she comes next, and admins can edit the schedule', async () => {
  const r = await makeRig(noonEastern('2026-10-09'));
  try {
    const ann = r.adapter.addUser(10, 'Ann', CH.home, 'uid-Ann');
    const admin = r.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const here = await r.ask(ann, '!minerva');
    assert.match(here, /Minerva is at the Whitespring Resort now for her Big Sale \(list 4\)/);
    assert.match(here, /After that: Foundation, list 5/);
    assert.match(here, /noon US Eastern/);

    r.setNow(noonEastern('2026-10-14'));
    assert.match(await r.ask(ann, '!minerva'), /away right now\.\nNext: Foundation, list 5/);
    assert.match(await r.ask(ann, '!minerva list'), /coming visits[\s\S]*\nFoundation, list 5[\s\S]*\nThe Crater, list 6/);

    assert.match(await r.ask(ann, '!minerva add 2027-02-01 Foundation'), /admins only/i);
    assert.match(await r.ask(admin, '!minerva add 2027-02-01 Vault'), /Usage/);
    assert.match(await r.ask(admin, '!minerva add 2027-02-01 Fort Atlas 17'), /Added: Fort Atlas, list 17/);
    assert.match(await r.ask(admin, '!minerva remove 2026-10-19'), /Removed/);
    assert.match(await r.ask(admin, '!minerva remove 2026-10-20'), /no visit starting/);
    assert.match(await r.ask(ann, '!minerva'), /Next: the Crater, list 6/);

    // past the end of the known schedule
    r.setNow(noonEastern('2027-03-01'));
    assert.match(await r.ask(ann, '!minerva'), /don't know her next visit/);
  } finally {
    r.cleanup();
  }
});
