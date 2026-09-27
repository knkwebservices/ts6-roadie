import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fetchPlayerSummaries, isSteamId64, SteamError, type SteamPlayer } from '../src/cogs/steam/api.js';
import type { SteamDeps } from '../src/cogs/steam/index.js';
import { STEAM_SERVICE, type SteamService } from '../src/core/services.js';
import { CH, makeBot, makeConfig, until } from './helpers.js';

const ALICE = '76561197960287930';
const BOB = '76561197960265729';

// ---- api.ts: parsing and validation, with a fake fetch (no real network in tests) ----------

test('isSteamId64 accepts only a 17-digit number', () => {
  assert.ok(isSteamId64('76561197960287930'));
  assert.ok(isSteamId64('  76561197960287930  ')); // whitespace is trimmed
  assert.ok(!isSteamId64('gaben'));
  assert.ok(!isSteamId64('7656119796028793')); // 16 digits
  assert.ok(!isSteamId64('765611979602879300')); // 18 digits
});

test('fetchPlayerSummaries parses a normal response', async () => {
  const fake = async (url: string) => {
    assert.match(url, /key=test-key/);
    assert.match(url, new RegExp(ALICE));
    return new Response(
      JSON.stringify({
        response: {
          players: [
            { steamid: ALICE, personaname: 'Gaben', personastate: 1, gameid: '440', gameextrainfo: 'Team Fortress 2' },
            { steamid: BOB, personaname: 'Bob', personastate: 0 },
          ],
        },
      }),
      { status: 200 },
    );
  };
  const players = await fetchPlayerSummaries('test-key', [ALICE, BOB], fake as typeof fetch);
  assert.deepEqual(players, [
    { steamId: ALICE, name: 'Gaben', state: 1, game: 'Team Fortress 2', appId: '440' },
    { steamId: BOB, name: 'Bob', state: 0, game: undefined, appId: undefined },
  ]);
});

test('fetchPlayerSummaries rejects with a plain-English message and never leaks the key', async () => {
  const fake = async () => new Response('nope', { status: 403 });
  await assert.rejects(fetchPlayerSummaries('secret-key', [ALICE], fake as typeof fetch), (e: unknown) => {
    assert.ok(e instanceof SteamError);
    assert.match(e.message, /rejected the API key/);
    assert.ok(!e.message.includes('secret-key'));
    return true;
  });
});

test('fetchPlayerSummaries with no key or no ids is refused or a no-op', async () => {
  const fake = async () => new Response('should not be called', { status: 200 });
  await assert.rejects(fetchPlayerSummaries('', [ALICE], fake as typeof fetch), SteamError);
  assert.deepEqual(await fetchPlayerSummaries('key', [], fake as typeof fetch), []);
});

test('fetchPlayerSummaries copes with a malformed response', async () => {
  const fake = async () => new Response(JSON.stringify({ response: {} }), { status: 200 });
  await assert.rejects(fetchPlayerSummaries('key', [ALICE], fake as typeof fetch), /didn't look like a player list/);
});

// ---- the cog: wired into a real bot, with a fake Steam API -------------------------------

const steamEntry = resolve(import.meta.dirname, '../src/cogs/steam/index.ts');

async function makeSteamRig(configOver: Record<string, unknown> = {}, deps: Partial<SteamDeps> = {}) {
  const calls: string[][] = [];
  let players: SteamPlayer[] = [];
  let fail: string | undefined;
  const fakeDeps: SteamDeps = {
    fetchPlayers: async (_key, ids) => {
      calls.push(ids);
      if (fail) throw new SteamError(fail);
      return deps.fetchPlayers ? deps.fetchPlayers('', ids) : players.filter((p) => ids.includes(p.steamId));
    },
  };
  (globalThis as Record<string, unknown>).__steamDeps = fakeDeps;
  const h = await makeBot({
    config: makeConfig({
      cogs: ['core', 'steamtest'],
      steam: { enabled: true, apiKey: 'test-key', pollSeconds: 30, players: [{ steamId: ALICE, label: 'Alice' }] },
      ...configOver,
    }),
    customCogs: {
      steamtest: `
        import { createSteamCog } from ${JSON.stringify('file://' + steamEntry)};
        export const manifest = { name: 'steamtest', version: '1', description: 'steam with fakes' };
        export default (bot) => createSteamCog(bot, globalThis.__steamDeps);`,
    },
  });
  return {
    ...h,
    calls,
    setPlayers: (p: SteamPlayer[]) => (players = p),
    setFail: (msg: string | undefined) => (fail = msg),
  };
}

test('announces when a tracked player starts a game, but not on the first (warm-up) check', async () => {
  const r = await makeSteamRig();
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.setPlayers([{ steamId: ALICE, name: 'Gaben', state: 1, game: 'Team Fortress 2', appId: '440' }]);
    r.adapter.say(admin, '!steam check');
    await until(() => r.calls.length >= 1, 5000, 'first check to finish');
    assert.ok(!r.adapter.sent.some((s) => /started playing/.test(s.text)), 'already-in-progress game is not announced on the first check');

    r.setPlayers([{ steamId: ALICE, name: 'Gaben', state: 1, game: 'Portal 2', appId: '620' }]);
    r.adapter.say(admin, '!steam check');
    await until(() => r.adapter.sent.some((s) => s.kind === 'channel' && /Alice started playing Portal 2/.test(s.text)), 5000, 'game change to be announced');
  } finally {
    r.cleanup();
  }
});

test('!steam lists tracked players and their status', async () => {
  const r = await makeSteamRig();
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.setPlayers([{ steamId: ALICE, name: 'Gaben', state: 1, game: 'Team Fortress 2', appId: '440' }]);
    r.adapter.say(admin, '!steam check');
    await until(() => r.calls.length >= 1, 5000, 'check to finish');
    const alice = r.adapter.addUser(5, 'Alice', CH.home, 'uid-Alice');
    r.adapter.say(alice, '!steam');
    assert.match(r.adapter.lastReply(), /Alice: playing Team Fortress 2/);
  } finally {
    r.cleanup();
  }
});

test('!steam add/remove need admin, validate the SteamID64, and update the service state', async () => {
  const r = await makeSteamRig();
  try {
    const bob = r.adapter.addUser(6, 'Bob', CH.home, 'uid-Bob');
    r.adapter.say(bob, '!steam add 76561197960265729 Bob');
    assert.match(r.adapter.lastReply(), /admins only/i);

    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!steam add not-an-id Bob');
    assert.match(r.adapter.lastReply(), /doesn't look like a SteamID64/);

    r.adapter.say(admin, `!steam add ${BOB} Bob`);
    assert.match(r.adapter.lastReply(), /Now tracking Bob/);

    const svc = r.bot.services.get<SteamService>(STEAM_SERVICE);
    assert.ok(svc);
    assert.deepEqual(
      svc!.state().players.map((p) => p.label),
      ['Alice', 'Bob'],
    );

    r.adapter.say(admin, '!steam remove Bob');
    assert.match(r.adapter.lastReply(), /Stopped tracking Bob/);
    assert.deepEqual(
      svc!.state().players.map((p) => p.label),
      ['Alice'],
    );
  } finally {
    r.cleanup();
  }
});

test('a failed check is reported in !steam, and does not crash the poller', async () => {
  const r = await makeSteamRig();
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.setFail('Steam rejected the API key (steam.apiKey). Get a fresh one at https://steamcommunity.com/dev/apikey.');
    r.adapter.say(admin, '!steam check');
    await until(() => /Check failed: Steam rejected the API key/.test(r.adapter.lastReply()), 5000, 'failed check to be reported');
    const alice = r.adapter.addUser(5, 'Alice', CH.home, 'uid-Alice');
    r.adapter.say(alice, '!steam');
    assert.match(r.adapter.lastReply(), /last check failed: Steam rejected the API key/);
  } finally {
    r.cleanup();
  }
});
