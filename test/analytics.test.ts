import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { HistoryEntry } from '../src/core/services.js';
import { AUDIO_SERVICE, type AudioService } from '../src/core/services.js';
import { CH, makeBot, makeConfig } from './helpers.js';

const entryEntry = resolve(import.meta.dirname, '../src/cogs/analytics/index.ts');

/** A minimal fake AudioService, providing only what analytics reads: history(). */
function fakeAudioCogSource(entries: HistoryEntry[]): string {
  return `
    import { AUDIO_SERVICE } from ${JSON.stringify('file://' + resolve(import.meta.dirname, '../src/core/services.ts'))};
    export const manifest = { name: 'audiotest', version: '1', description: 'fake audio service' };
    export default (bot) => ({
      commands: [],
      onLoad() {
        this._unprovide = bot.services.provide(AUDIO_SERVICE, { history: () => globalThis.__fakeHistory ?? [] });
      },
      onUnload() { this._unprovide?.(); },
    });`;
}

async function makeAnalyticsRig(configOver: Record<string, unknown> = {}, opts: { withAudio?: HistoryEntry[] } = {}) {
  if (opts.withAudio) (globalThis as Record<string, unknown>).__fakeHistory = opts.withAudio;
  const customCogs: Record<string, string> = {
    analyticstest: `
      import { createAnalyticsCog } from ${JSON.stringify('file://' + entryEntry)};
      export const manifest = { name: 'analyticstest', version: '1', description: 'analytics' };
      export default (bot) => createAnalyticsCog(bot);`,
  };
  if (opts.withAudio) customCogs.audiotest = fakeAudioCogSource(opts.withAudio);
  const h = await makeBot({
    config: makeConfig({
      cogs: opts.withAudio ? ['core', 'audiotest', 'analyticstest'] : ['core', 'analyticstest'],
      analytics: { enabled: true, pollSeconds: 60 },
      ...configOver,
    }),
    customCogs,
  });
  return h;
}

test('!analytics on a fresh bot reports there is not enough data yet', async () => {
  const r = await makeAnalyticsRig();
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!analytics');
    assert.match(r.adapter.lastReply(), /Analytics is on/);
    assert.match(r.adapter.lastReply(), /not enough data yet/);
  } finally {
    r.cleanup();
  }
});

test('!analytics check samples who is online, and reports the busiest channel and hour', async () => {
  const r = await makeAnalyticsRig();
  try {
    r.adapter.addUser(1, 'Alice', CH.a, 'uid-Alice');
    r.adapter.addUser(2, 'Bob', CH.a, 'uid-Bob');
    r.adapter.addUser(3, 'Carl', CH.staff, 'uid-Carl');
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');

    r.adapter.say(admin, '!analytics check');
    assert.match(r.adapter.lastReply(), /Checked now/);

    r.adapter.say(admin, '!analytics channels');
    const reply = r.adapter.lastReply();
    assert.match(reply, /Gaming A/);
    // Gaming A had 2 people, Staff Room had 1: Gaming A should be listed first.
    assert.ok(reply.indexOf('Gaming A') < reply.indexOf('Staff Room'));

    r.adapter.say(admin, '!analytics hours');
    assert.match(r.adapter.lastReply(), /avg/);
  } finally {
    r.cleanup();
  }
});

test('!analytics songs pulls from the audio cog\'s play history, without double-counting on repeated checks', async () => {
  const history: HistoryEntry[] = [
    { id: 1, at: Date.now(), kind: 'media', title: 'Track One', url: 'https://example.com/1', byName: 'Alice' },
    { id: 2, at: Date.now(), kind: 'media', title: 'Track Two', url: 'https://example.com/2', byName: 'Bob' },
    { id: 3, at: Date.now(), kind: 'media', title: 'Track One', url: 'https://example.com/1', byName: 'Carl' },
  ];
  const r = await makeAnalyticsRig({}, { withAudio: history });
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!analytics check');
    r.adapter.say(admin, '!analytics check'); // a second, identical check should not double-count

    r.adapter.say(admin, '!analytics songs');
    const reply = r.adapter.lastReply();
    assert.match(reply, /"Track One" \(2x\)/);
    assert.match(reply, /"Track Two" \(1x\)/);
    assert.ok(reply.indexOf('Track One') < reply.indexOf('Track Two'), 'the more-played track is listed first');
  } finally {
    r.cleanup();
  }
});

test('!analytics songs says plainly when the audio cog is not loaded', async () => {
  const r = await makeAnalyticsRig();
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!analytics songs');
    assert.match(r.adapter.lastReply(), /audio cog, which is not loaded/);
  } finally {
    r.cleanup();
  }
});

test('!analytics on/off/interval/reset need admin and take effect', async () => {
  const r = await makeAnalyticsRig();
  try {
    const bob = r.adapter.addUser(6, 'Bob', CH.home, 'uid-Bob');
    r.adapter.say(bob, '!analytics off');
    assert.match(r.adapter.lastReply(), /admins only/i);

    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!analytics off');
    assert.match(r.adapter.lastReply(), /tracking is off/);

    r.adapter.say(admin, '!analytics interval 90');
    assert.match(r.adapter.lastReply(), /every 90 seconds/);

    r.adapter.say(admin, '!analytics interval 30'); // below the 60s minimum
    assert.match(r.adapter.lastReply(), /60 to 3600/);

    r.adapter.say(admin, '!analytics reset');
    assert.match(r.adapter.lastReply(), /Cleared/);
  } finally {
    r.cleanup();
  }
});

test('uptime is tracked across a load and unload as a session', async () => {
  const r = await makeAnalyticsRig();
  try {
    const admin = r.adapter.addUser(9, 'Admin', CH.home, 'uid-Admin');
    r.adapter.say(admin, '!analytics check');
    r.adapter.say(admin, '!analytics');
    assert.match(r.adapter.lastReply(), /Uptime: .* total across 1 run/);
  } finally {
    r.cleanup();
  }
});
