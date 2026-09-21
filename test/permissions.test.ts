import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseGroupIds } from '../src/adapter/groups.js';
import { buildConfig } from '../src/config.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';
import type { TsUser } from '../src/adapter/types.js';

const DJ = 12;
const MOD = 7;

async function ask(h: Harness, u: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  h.adapter.say(u, text);
  await until(() => h.adapter.sent.length > n, 10000, `a reply to "${text}"`);
  return h.adapter.lastReply();
}

async function setup(commands: Record<string, unknown>) {
  const h = await makeBot({ config: makeConfig({ permissions: { commands } }) });
  return {
    h,
    dj: h.adapter.addUser(5, 'Dee', CH.home, 'uid-dj', [DJ, 6]),
    plain: h.adapter.addUser(6, 'Pat', CH.home, 'uid-plain', [6]),
    named: h.adapter.addUser(7, 'Nia', CH.home, 'uid-named', []),
    admin: h.adapter.addUser(8, 'Admin', CH.home, 'uid-Admin', []),
  };
}

test('with no rule, defaults are unchanged: everyday commands open, admin commands admin-only', async () => {
  const { h, plain, admin } = await setup({});
  try {
    assert.equal(await ask(h, plain, '!ping'), 'pong');
    assert.match(await ask(h, plain, '!status'), /admins only/);
    assert.match(await ask(h, admin, '!status'), /Bot .* TS library/);
  } finally {
    h.cleanup();
  }
});

test('a group rule limits an everyday command to that group, listed users, and admins', async () => {
  const { h, dj, plain, named, admin } = await setup({ ping: { groups: [DJ], uids: ['uid-named'] } });
  try {
    assert.equal(await ask(h, dj, '!ping'), 'pong', 'a member of the group');
    assert.equal(await ask(h, named, '!ping'), 'pong', 'a listed unique ID');
    assert.equal(await ask(h, admin, '!ping'), 'pong', 'bot admins always pass');
    assert.match(await ask(h, plain, '!ping'), /don't have permission to use !ping/);
  } finally {
    h.cleanup();
  }
});

test('a rule on an admin command delegates it to a group (and others get the permission message)', async () => {
  const { h, dj, plain } = await setup({ status: { groups: [MOD] } });
  try {
    const mod = h.adapter.addUser(9, 'Mo', CH.home, 'uid-mod', [MOD]);
    assert.match(await ask(h, mod, '!status'), /TS library/);
    assert.match(await ask(h, dj, '!status'), /don't have permission to use !status/);
    assert.match(await ask(h, plain, '!status'), /don't have permission/);
  } finally {
    h.cleanup();
  }
});

test('an empty rule means admins only, and a rule keyed by an alias applies to the command', async () => {
  const { h, plain, admin } = await setup({ ping: {}, commands: { groups: [DJ] } });
  try {
    assert.match(await ask(h, plain, '!ping'), /don't have permission/);
    assert.equal(await ask(h, admin, '!ping'), 'pong');
    // "commands" is an alias of !help
    assert.match(await ask(h, plain, '!help'), /don't have permission to use !help/);
  } finally {
    h.cleanup();
  }
});

test('rules that match no command are reported (almost always a typo)', async () => {
  const { h } = await setup({ pign: { groups: [1] }, ping: { groups: [1] }, help: {} });
  try {
    assert.deepEqual(h.bot.unknownPermissionRules(), ['pign']);
  } finally {
    h.cleanup();
  }
});

test('!whoami shows your server groups so you can find the IDs to use in rules', async () => {
  const { h, dj, named } = await setup({});
  try {
    assert.match(await ask(h, dj, '!whoami'), /Server groups: 12, 6/);
    assert.match(await ask(h, named, '!whoami'), /Server groups: none reported/);
  } finally {
    h.cleanup();
  }
});

test('config validation for permission rules and the vote threshold', () => {
  assert.throws(() => buildConfig({ permissions: { commands: { play: { groups: [-1] } } } }), /play\.groups/);
  assert.throws(() => buildConfig({ permissions: { commands: { play: { groups: ['x'] } } } }), /play\.groups/);
  assert.throws(() => buildConfig({ permissions: { commands: { play: { uids: [5] } } } }), /play\.uids/);
  assert.throws(() => buildConfig({ permissions: { commands: { play: 'dj' } } }), /play must be an object/);
  assert.doesNotThrow(() => buildConfig({ permissions: { commands: { play: { groups: [12], uids: ['abc='] } } } }));
  assert.throws(() => buildConfig({ voteskip: { threshold: 1 } }), /threshold/);
  assert.throws(() => buildConfig({ voteskip: { threshold: -0.1 } }), /threshold/);
  assert.equal(buildConfig({ voteskip: { threshold: 0 } }).voteskip.threshold, 0);
});

test('parseGroupIds keeps whole-number IDs only', () => {
  assert.deepEqual(parseGroupIds(['6', '9']), [6, 9]);
  assert.deepEqual(parseGroupIds('6,9,9'), [6, 9]);
  assert.deepEqual(parseGroupIds(['x', '-2', '', ' 7 ']), [7]);
  assert.deepEqual(parseGroupIds(undefined), []);
  assert.deepEqual(parseGroupIds(''), []);
});
