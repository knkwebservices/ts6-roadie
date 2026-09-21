import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { CH, makeBot, makeConfig, until } from './helpers.js';

const cogSource = (name: string, version: string, cmd: string, reply: string, extra = '') => `
export const manifest = { name: '${name}', version: '${version}', description: 'test cog' };
export default () => ({
  commands: [{ name: '${cmd}', description: 'x', run: (ctx) => ctx.reply('${reply}') }],
  ${extra}
});`;

test('core commands: ping, unknown commands stay silent, BBCode is stripped', async () => {
  const h = await makeBot();
  try {
    const u = h.adapter.addUser(5, 'Alice', CH.a);
    h.adapter.say(u, '!ping');
    await until(() => h.adapter.sent.length === 1);
    assert.equal(h.adapter.lastReply(), 'pong');
    h.adapter.say(u, '!doesnotexist');
    h.adapter.say(u, 'just chatting');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.adapter.sent.length, 1, 'no reply to unknown commands or normal chat');
    h.adapter.say(u, '[B]!ping[/B]');
    await until(() => h.adapter.sent.length === 2);
  } finally {
    h.cleanup();
  }
});

test('replies follow the message scope: private -> private, channel -> channel', async () => {
  const h = await makeBot();
  try {
    const u = h.adapter.addUser(5, 'Alice', CH.home);
    h.adapter.say(u, '!ping', 'private');
    h.adapter.say(u, '!ping', 'channel');
    h.adapter.say(u, '!ping', 'server');
    await until(() => h.adapter.sent.length === 3);
    assert.deepEqual(h.adapter.sent.map((s) => s.kind), ['private', 'channel', 'private'], 'server chat is answered privately');
  } finally {
    h.cleanup();
  }
});

test('admin commands are gated by unique ID, not by nickname', async () => {
  const h = await makeBot();
  try {
    const admin = h.adapter.addUser(5, 'Admin', CH.home, 'uid-Admin');
    const imposter = h.adapter.addUser(6, 'Admin', CH.home, 'uid-someone-else'); // same nickname!
    h.adapter.say(imposter, '!restart');
    await until(() => h.adapter.sent.length === 1);
    assert.match(h.adapter.lastReply(), /admins only/);
    assert.equal(h.restarted(), false);
    h.adapter.say(admin, '!restart');
    await until(() => h.restarted(), 10000, 'restart');
  } finally {
    h.cleanup();
  }
});

test('!whoami tells you your unique ID and admin status', async () => {
  const h = await makeBot();
  try {
    const u = h.adapter.addUser(5, 'Alice', CH.b, 'uid-Alice');
    h.adapter.say(u, '!whoami');
    await until(() => h.adapter.sent.length === 1);
    assert.match(h.adapter.lastReply(), /Unique ID: uid-Alice/);
    assert.match(h.adapter.lastReply(), /Bot admin: no/);
    assert.match(h.adapter.lastReply(), /Channel: Gaming B/);
  } finally {
    h.cleanup();
  }
});

test('a per-user cooldown stops command spam', async () => {
  const { Bot } = await import('../src/core/bot.js');
  const { FakeAdapter, SRC_COGS } = await import('./helpers.js');
  const { StateStore } = await import('../src/state.js');
  const { silentLog } = await import('../src/logger.js');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'tsbot-cd-'));
  const adapter = new FakeAdapter();
  const bot = new Bot({ config: makeConfig(), adapter, state: new StateStore(dir), log: silentLog, dataDir: dir, builtinCogsDir: SRC_COGS, cooldownMs: 300 });
  await bot.start();
  const u = adapter.addUser(5, 'Spammer', CH.home);
  for (let i = 0; i < 5; i++) adapter.say(u, '!ping');
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(adapter.sent.length, 1);
  await new Promise((r) => setTimeout(r, 300));
  adapter.say(u, '!ping');
  await until(() => adapter.sent.length === 2);
  await bot.stop();
  rmSync(dir, { recursive: true, force: true });
});

test('a throwing command is contained and reported', async () => {
  const h = await makeBot({
    config: makeConfig({ cogs: ['core', 'boom'] }),
    customCogs: { boom: `export const manifest = { name: 'boom', version: '1', description: 'x' };
      export default () => ({ commands: [{ name: 'boom', description: 'x', run: () => { throw new Error('kaboom'); } }] });` },
  });
  try {
    const u = h.adapter.addUser(5, 'Alice', CH.home);
    h.adapter.say(u, '!boom');
    await until(() => h.adapter.sent.length === 1);
    assert.match(h.adapter.lastReply(), /Something went wrong/);
    h.adapter.say(u, '!ping');
    await until(() => h.adapter.sent.length === 2);
    assert.equal(h.adapter.lastReply(), 'pong', 'the bot keeps working after a failing command');
  } finally {
    h.cleanup();
  }
});

test('cog lifecycle: load, unload, reload picks up edits, protected core, bad names', async () => {
  const h = await makeBot({ customCogs: { hello: cogSource('hello', '1.0.0', 'hi', 'v1') } });
  try {
    const admin = h.adapter.addUser(5, 'Admin', CH.home, 'uid-Admin');
    const ask = async (text: string) => {
      const n = h.adapter.sent.length;
      h.adapter.say(admin, text);
      await until(() => h.adapter.sent.length > n, 10000, `reply to ${text}`);
      return h.adapter.lastReply();
    };

    assert.match(await ask('!load hello'), /Loaded hello 1.0.0/);
    assert.equal(await ask('!hi'), 'v1');
    assert.match(await ask('!load hello'), /already loaded/);

    // Edit the cog on disk, then reload: the new code must actually run.
    const { writeFileSync } = await import('node:fs');
    writeFileSync(join(h.dir, 'cogs', 'hello', 'index.mjs'), cogSource('hello', '2.0.0', 'hi', 'v2'));
    assert.match(await ask('!reload hello'), /Reloaded hello 2.0.0/);
    assert.equal(await ask('!hi'), 'v2');

    // A broken edit must not take the working version away.
    writeFileSync(join(h.dir, 'cogs', 'hello', 'index.mjs'), 'export const manifest = {{{ syntax error');
    assert.match(await ask('!reload hello'), /kept the previous version/);
    assert.equal(await ask('!hi'), 'v2');

    assert.match(await ask('!unload hello'), /Unloaded hello/);
    const n = h.adapter.sent.length;
    h.adapter.say(admin, '!hi');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.adapter.sent.length, n, 'unloaded commands are gone');

    assert.match(await ask('!unload core'), /cannot be unloaded/);
    assert.match(await ask('!load ../../etc'), /not a valid cog name/);
    assert.match(await ask('!load nothere'), /no cog named/);
  } finally {
    h.cleanup();
  }
});

test('two cogs cannot claim the same command; the failed cog leaves no trace', async () => {
  const h = await makeBot({
    customCogs: {
      one: cogSource('one', '1', 'dup', 'from-one'),
      two: cogSource('two', '1', 'dup', 'from-two'),
    },
  });
  try {
    const admin = h.adapter.addUser(5, 'Admin', CH.home, 'uid-Admin');
    await h.bot.loadCog('one');
    await assert.rejects(h.bot.loadCog('two'), /already provided by cog "one"/);
    h.adapter.say(admin, '!dup');
    await until(() => h.adapter.sent.length === 1);
    assert.equal(h.adapter.lastReply(), 'from-one');
    assert.equal(h.bot.listCogs().find((c) => c.manifest.name === 'two')?.loaded, false);
  } finally {
    h.cleanup();
  }
});

test('a cog whose manifest name does not match its folder is rejected', async () => {
  const h = await makeBot({ customCogs: { wrong: cogSource('other', '1', 'x', 'x') } });
  try {
    await assert.rejects(h.bot.loadCog('wrong'), /must match/);
  } finally {
    h.cleanup();
  }
});

test('one broken cog in the start-up list does not stop the bot', async () => {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'ghost'] }) });
  try {
    const u = h.adapter.addUser(5, 'Alice', CH.home);
    h.adapter.say(u, '!ping');
    await until(() => h.adapter.sent.length === 1);
  } finally {
    h.cleanup();
  }
});

test('privilege key is redeemed once on first connect and remembered', async () => {
  const h = await makeBot({ config: makeConfig({ privilegeKey: 'SECRETKEY123' }) });
  try {
    h.adapter.events.emit('connected');
    await until(() => h.adapter.privilegeKeys.length === 1);
    assert.deepEqual(h.adapter.privilegeKeys, ['SECRETKEY123']);
    h.adapter.events.emit('connected'); // reconnect
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(h.adapter.privilegeKeys.length, 1, 'must not redeem again');
    const state = JSON.parse(readFileSync(join(h.dir, 'state.json'), 'utf8'));
    assert.ok(state.privilegeKeyUsed, 'success is persisted so a restart does not retry');
    assert.ok(!JSON.stringify(state).includes('SECRETKEY123'), 'the key itself is never stored');
  } finally {
    h.cleanup();
  }
});

test('health file reflects connection state (deploy.mjs relies on this)', async () => {
  const h = await makeBot();
  try {
    const file = join(h.dir, 'health.json');
    assert.ok(existsSync(file));
    let hp = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(hp.alive, true);
    assert.equal(hp.connected, true);
    assert.equal(typeof hp.startedAt, 'number');
    h.adapter.connected = false;
    h.adapter.events.emit('disconnected', 'test');
    hp = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(hp.connected, false);
  } finally {
    h.cleanup();
  }
});
