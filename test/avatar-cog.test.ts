import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { CH, makeBot, makeConfig, until } from './helpers.js';

const BUNDLED = readFileSync(resolve(import.meta.dirname, '../assets/roadie-avatar.png'));
const cfg = (avatar: Record<string, unknown> = { applyOnConnect: false }) => makeConfig({ cogs: ['core', 'avatar'], avatar });

test('!avatar (admin) uploads the bundled Roadie icon, forced', async () => {
  const h = await makeBot({ config: cfg() });
  try {
    const admin = h.adapter.addUser(5, 'Admin', CH.home, 'uid-Admin');
    h.adapter.say(admin, '!avatar');
    await until(() => h.adapter.sent.length === 1);
    assert.equal(h.adapter.avatarCalls.length, 1);
    assert.equal(h.adapter.avatarCalls[0]!.force, true);
    assert.ok(h.adapter.avatarCalls[0]!.bytes.equals(BUNDLED), 'must send the bundled image');
    assert.match(h.adapter.lastReply(), /Avatar uploaded/);
  } finally {
    h.cleanup();
  }
});

test('!avatar is for admins only', async () => {
  const h = await makeBot({ config: cfg() });
  try {
    const user = h.adapter.addUser(6, 'Someone', CH.home, 'uid-someone');
    h.adapter.say(user, '!avatar');
    await until(() => h.adapter.sent.length === 1);
    assert.match(h.adapter.lastReply(), /admins only/);
    assert.equal(h.adapter.avatarCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test('!avatar reports the reason when the upload fails', async () => {
  const h = await makeBot({ config: cfg() });
  try {
    h.adapter.avatarError = new Error("the upload failed: could not reach the server's file-transfer port (TCP 30033 on ts.example.com)");
    const admin = h.adapter.addUser(5, 'Admin', CH.home, 'uid-Admin');
    h.adapter.say(admin, '!avatar');
    await until(() => h.adapter.sent.length === 1);
    assert.match(h.adapter.lastReply(), /Could not set the avatar: the upload failed.*30033/);
  } finally {
    h.cleanup();
  }
});

test('!avatar clear removes it', async () => {
  const h = await makeBot({ config: cfg() });
  try {
    const admin = h.adapter.addUser(5, 'Admin', CH.home, 'uid-Admin');
    h.adapter.say(admin, '!avatar clear');
    await until(() => h.adapter.sent.length === 1);
    assert.equal(h.adapter.avatarCleared, 1);
    assert.equal(h.adapter.lastReply(), 'Avatar removed.');
    h.adapter.clearError = new Error('no permission');
    h.adapter.say(admin, '!avatar clear');
    await until(() => h.adapter.sent.length === 2);
    assert.match(h.adapter.lastReply(), /no permission/);
  } finally {
    h.cleanup();
  }
});

test('a custom image in the data folder is used, and a missing one is explained', async () => {
  const h = await makeBot({ config: cfg({ file: 'mine.png', applyOnConnect: false }) });
  try {
    const admin = h.adapter.addUser(5, 'Admin', CH.home, 'uid-Admin');
    h.adapter.say(admin, '!avatar');
    await until(() => h.adapter.sent.length === 1);
    assert.match(h.adapter.lastReply(), /could not read the avatar image at .*mine\.png/);
    assert.equal(h.adapter.avatarCalls.length, 0);

    const custom = Buffer.concat([BUNDLED, Buffer.from('extra')]);
    writeFileSync(join(h.dir, 'mine.png'), custom);
    h.adapter.say(admin, '!avatar');
    await until(() => h.adapter.avatarCalls.length === 1);
    assert.ok(h.adapter.avatarCalls[0]!.bytes.equals(custom));
  } finally {
    h.cleanup();
  }
});

test('applyOnConnect sets it (not forced) after connecting; failures are logged, never chatted; off means off', async () => {
  const on = await makeBot({ config: cfg({ applyOnConnect: true }) });
  const failing = await makeBot({ config: cfg({ applyOnConnect: true }) });
  const off = await makeBot({ config: cfg({ applyOnConnect: false }) });
  try {
    failing.adapter.avatarError = new Error('the server refused the upload');
    for (const h of [on, failing, off]) h.adapter.events.emit('connected');
    await until(() => on.adapter.avatarCalls.length === 1 && failing.adapter.avatarCalls.length === 1, 6_000, 'auto-apply');
    assert.equal(on.adapter.avatarCalls[0]!.force, false, 'on connect it must skip an unchanged avatar');
    assert.ok(on.adapter.avatarCalls[0]!.bytes.equals(BUNDLED));
    assert.equal(failing.adapter.sent.length, 0, 'a failed auto-upload must not chat');
    assert.equal(off.adapter.avatarCalls.length, 0, 'applyOnConnect=false must do nothing');
  } finally {
    for (const h of [on, failing, off]) h.cleanup();
  }
});
