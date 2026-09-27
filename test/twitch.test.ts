import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { fetchAppToken, fetchLiveStreams, isTwitchLogin, TwitchAuthError, TwitchError, type AppToken, type TwitchStream } from '../src/cogs/twitch/api.js';
import type { TwitchDeps } from '../src/cogs/twitch/index.js';
import { TWITCH_SERVICE, type TwitchService } from '../src/core/services.js';
import { CH, makeBot, makeConfig, until } from './helpers.js';

const ALICE = 'tgsckrazyice';
const BOB = 'imsdot';

// ---- api.ts: parsing and validation, with a fake fetch (no real network in tests) ----------

test('isTwitchLogin accepts only 4-25 letters, digits or underscores', () => {
  assert.ok(isTwitchLogin('tgsckrazyice'));
  assert.ok(isTwitchLogin('  imsdot  ')); // whitespace is trimmed
  assert.ok(!isTwitchLogin('ab')); // too short
  assert.ok(!isTwitchLogin('not a name')); // spaces
  assert.ok(!isTwitchLogin('a'.repeat(26))); // too long
});

test('fetchAppToken parses a normal response', async () => {
  const fake = async (url: string, init: RequestInit) => {
    assert.match(url, /oauth2\/token/);
    const body = (init.body as URLSearchParams).toString();
    assert.match(body, /client_id=test-id/);
    assert.match(body, /client_secret=test-secret/);
    return new Response(JSON.stringify({ access_token: 'tok-123', expires_in: 3600 }), { status: 200 });
  };
  const t = await fetchAppToken('test-id', 'test-secret', fake as typeof fetch);
  assert.equal(t.token, 'tok-123');
  assert.ok(t.expiresAt > Date.now());
});

test('fetchAppToken rejects with a plain-English message and never leaks the secret', async () => {
  const fake = async () => new Response('nope', { status: 403 });
  await assert.rejects(fetchAppToken('id', 'super-secret-value', fake as typeof fetch), (e: unknown) => {
    assert.ok(e instanceof TwitchAuthError);
    assert.match(e.message, /rejected the client ID\/secret/);
    assert.ok(!e.message.includes('super-secret-value'));
    return true;
  });
});

test('fetchAppToken with no id or secret is refused', async () => {
  const fake = async () => new Response('should not be called', { status: 200 });
  await assert.rejects(fetchAppToken('', 'secret', fake as typeof fetch), TwitchError);
  await assert.rejects(fetchAppToken('id', '', fake as typeof fetch), TwitchError);
});

test('fetchLiveStreams parses only the live entries, and no ids for offline channels', async () => {
  const fake = async (url: string) => {
    assert.match(url, new RegExp(ALICE));
    return new Response(
      JSON.stringify({
        data: [{ user_login: ALICE, user_name: 'TgscKrazyIce', game_name: 'Once Human', title: 'chill stream', viewer_count: 12, started_at: '2026-01-01T00:00:00Z' }],
      }),
      { status: 200 },
    );
  };
  const streams = await fetchLiveStreams('id', 'tok', [ALICE, BOB], fake as typeof fetch);
  assert.equal(streams.length, 1);
  assert.equal(streams[0]?.login, ALICE);
  assert.equal(streams[0]?.game, 'Once Human');
});

test('fetchLiveStreams treats a 401 as an auth error, and other failures as a plain message', async () => {
  const fake401 = async () => new Response('', { status: 401 });
  await assert.rejects(fetchLiveStreams('id', 'expired', [ALICE], fake401 as typeof fetch), TwitchAuthError);

  const fake500 = async () => new Response('', { status: 500 });
  await assert.rejects(fetchLiveStreams('id', 'tok', [ALICE], fake500 as typeof fetch), /HTTP 500/);
});

test('fetchLiveStreams with no channels is a no-op', async () => {
  const fake = async () => new Response('should not be called', { status: 200 });
  assert.deepEqual(await fetchLiveStreams('id', 'tok', [], fake as typeof fetch), []);
});

// ---- the cog: wired into a real bot, with a fake Twitch API -------------------------------

const twitchEntry = resolve(import.meta.dirname, '../src/cogs/twitch/index.ts');

async function makeTwitchRig(configOver: Record<string, unknown> = {}, deps: Partial<TwitchDeps> = {}) {
  const calls: string[][] = [];
  let live: TwitchStream[] = [];
  let fail: string | undefined;
  let tokenCalls = 0;
  const fakeDeps: TwitchDeps = {
    fetchToken: async (id, secret) => {
      tokenCalls++;
      return deps.fetchToken ? deps.fetchToken(id, secret) : { token: 'tok', expiresAt: Date.now() + 3_600_000 };
    },
    fetchStreams: async (id, tok, logins) => {
      calls.push(logins);
      if (fail) throw new TwitchError(fail);
      return deps.fetchStreams ? deps.fetchStreams(id, tok, logins) : live.filter((s) => logins.includes(s.login));
    },
  };
  (globalThis as Record<string, unknown>).__twitchDeps = fakeDeps;
  const h = await makeBot({
    config: makeConfig({
      cogs: ['core', 'twitchtest'],
      twitch: { enabled: true, clientId: 'id', clientSecret: 'secret', pollSeconds: 30, channels: [{ login: ALICE, label: 'Ice' }] },
      ...configOver,
    }),
    customCogs: {
      twitchtest: `
        import { createTwitchCog } from ${JSON.stringify('file://' + twitchEntry)};
        export const manifest = { name: 'twitchtest', version: '1', description: 'twitch with fakes' };
        export default (bot) => createTwitchCog(bot, globalThis.__twitchDeps);`,
    },
  });
  return {
    ...h,
    calls,
    tokenCalls: () => tokenCalls,
    setLive: (s: TwitchStream[]) => (live = s),
    setFail: (msg: string | undefined) => (fail = msg),
  };
}

test('announces when a tracked channel goes live, but not on the first (warm-up) check', async () => {
  const r = await makeTwitchRig();
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.setLive([{ login: ALICE, name: 'TgscKrazyIce', game: 'Once Human', title: 'chill', startedAt: Date.now() }]);
    r.adapter.say(admin, '!twitch check');
    await until(() => r.calls.length >= 1, 5000, 'first check to finish');
    assert.ok(!r.adapter.sent.some((s) => /is live/.test(s.text)), 'already-live channel is not announced on the first check');

    r.setLive([]); // goes offline, then back live below
    r.adapter.say(admin, '!twitch check');
    await until(() => r.calls.length >= 2, 5000, 'second check to finish');

    r.setLive([{ login: ALICE, name: 'TgscKrazyIce', game: 'Once Human', title: 'round two', startedAt: Date.now() }]);
    r.adapter.say(admin, '!twitch check');
    await until(() => r.adapter.sent.some((s) => s.kind === 'channel' && /Ice is live/.test(s.text)), 5000, 'going live to be announced');
  } finally {
    r.cleanup();
  }
});

test('!twitch lists tracked channels and their status', async () => {
  const r = await makeTwitchRig();
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.setLive([{ login: ALICE, name: 'TgscKrazyIce', game: 'Once Human', startedAt: Date.now() }]);
    r.adapter.say(admin, '!twitch check');
    await until(() => r.calls.length >= 1, 5000, 'check to finish');
    const viewer = r.adapter.addUser(5, 'Viewer', CH.home, 'uid-Viewer');
    r.adapter.say(viewer, '!twitch');
    assert.match(r.adapter.lastReply(), /Ice: LIVE playing Once Human/);
  } finally {
    r.cleanup();
  }
});

test('!twitch add/remove need admin, validate the channel name, and update the service state', async () => {
  const r = await makeTwitchRig();
  try {
    const bob = r.adapter.addUser(6, 'Bob', CH.home, 'uid-Bob');
    r.adapter.say(bob, `!twitch add ${BOB} Dot`);
    assert.match(r.adapter.lastReply(), /admins only/i);

    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!twitch add a Dot'); // too short
    assert.match(r.adapter.lastReply(), /doesn't look like a Twitch channel name/);

    r.adapter.say(admin, `!twitch add ${BOB} Dot`);
    assert.match(r.adapter.lastReply(), /Now tracking Dot/);

    const svc = r.bot.services.get<TwitchService>(TWITCH_SERVICE);
    assert.ok(svc);
    assert.deepEqual(
      svc!.state().channels.map((c) => c.label),
      ['Ice', 'Dot'],
    );

    r.adapter.say(admin, '!twitch remove Dot');
    assert.match(r.adapter.lastReply(), /Stopped tracking Dot/);
    assert.deepEqual(
      svc!.state().channels.map((c) => c.label),
      ['Ice'],
    );
  } finally {
    r.cleanup();
  }
});

test('an expired token is refreshed once and the check still succeeds', async () => {
  let issued = 0;
  const r = await makeTwitchRig(
    {},
    {
      fetchToken: async (_id, _secret) => ({ token: `tok-${++issued}`, expiresAt: Date.now() + 3_600_000 }),
      fetchStreams: async (_id, tok, logins) => {
        if (tok === 'tok-1') throw new TwitchAuthError('stale');
        return logins.map((login) => ({ login, name: login, startedAt: Date.now() }));
      },
    },
  );
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!twitch check');
    await until(() => /LIVE/.test(r.adapter.lastReply()), 5000, 'check to recover after a token refresh');
    assert.equal(issued, 2, 'fetched a fresh token exactly once after the auth error');
  } finally {
    r.cleanup();
  }
});

test('a failed check is reported in !twitch, and does not crash the poller', async () => {
  const r = await makeTwitchRig();
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.setFail('Twitch would not list streams (HTTP 500).');
    r.adapter.say(admin, '!twitch check');
    await until(() => /Check failed: Twitch would not list streams/.test(r.adapter.lastReply()), 5000, 'failed check to be reported');
    const viewer = r.adapter.addUser(5, 'Viewer', CH.home, 'uid-Viewer');
    r.adapter.say(viewer, '!twitch');
    assert.match(r.adapter.lastReply(), /last check failed: Twitch would not list streams/);
  } finally {
    r.cleanup();
  }
});
