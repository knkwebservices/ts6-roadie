import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import { blockedWordIn } from '../src/cogs/nickfilter/index.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const AFK = 20n;
const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function makeRig(nickfilter: Record<string, unknown> = {}): Promise<Harness> {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'nickfilter'], nickfilter: { graceSeconds: 1, ...nickfilter } }) });
  h.adapter.chans.push({ id: AFK, name: 'AFK Room', parentId: 0n });
  return h;
}
async function say(h: Harness, user: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  const mine = () => h.adapter.sent.slice(n).find((s) => s.kind === 'private' && s.to === user.id);
  h.adapter.say(user, text);
  await until(() => !!mine(), 10000, `an answer to ${text}`);
  return mine()!.text;
}
const to = (h: Harness, u: TsUser) => h.adapter.sent.filter((s) => (s.kind === 'private' || s.kind === 'poke') && s.to === u.id).map((s) => `${s.kind}: ${s.text}`);
const join = (h: Harness, id: number, name: string, ch = CH.a): TsUser => {
  const u = h.adapter.addUser(id, name, ch, `uid-${id}`);
  h.adapter.events.emit('directory');
  return u;
};

test('blocked words are found ignoring case and common letter swaps', () => {
  const words = ['noob', 'badword'];
  assert.equal(blockedWordIn('xX_N00B_Xx', words), 'noob');
  assert.equal(blockedWordIn('B4dW0rd', words), 'badword');
  assert.equal(blockedWordIn('b.a.d.w.o.r.d', words), 'badword');
  assert.equal(blockedWordIn('GoodPlayer', words), undefined);
  assert.equal(blockedWordIn('anything', []), undefined);
});

test('nickfilter settings have safe defaults and are checked', () => {
  const c = buildConfig({});
  assert.equal(c.nickfilter.enabled, false);
  assert.equal(c.nickfilter.action, 'warn');
  assert.throws(() => buildConfig({ nickfilter: { action: 'ban' } }), /nickfilter\.action/);
  assert.throws(() => buildConfig({ nickfilter: { words: ['x'] } }), /nickfilter\.words/);
});

test('warn mode: the person is poked and told, and the admins are told if they keep the name; renaming clears it', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    assert.match(await say(h, admin, '!nickfilter on'), /Add a word first/);
    assert.match(await say(h, admin, '!nickfilter add noob'), /"noob" is blocked in nicknames\. The filter is off/);
    assert.match(await say(h, admin, '!nickfilter on'), /on \(warn mode\)/);

    const n = join(h, 10, 'TheN00b');
    await until(() => to(h, n).length === 2, 10000, 'the warning');
    assert.match(to(h, n)[0]!, /^poke: Please change your nickname/);
    assert.match(to(h, n)[1]!, /^private: Your nickname has a word that isn't allowed here\. Please change it within 1 seconds, please\.$/);

    await pause(1100);
    h.adapter.events.emit('directory');
    await until(() => h.adapter.sent.some((s) => s.to === 2 && /TheN00b has a blocked word \("noob"\)/.test(s.text)), 10000, 'the admin note');
    h.adapter.events.emit('directory');
    await pause(50);
    assert.equal(h.adapter.sent.filter((s) => s.to === 2 && /blocked word/.test(s.text)).length, 1, 'told once');

    // renaming clears it; the bot admin is never checked
    n.name = 'ThePro';
    admin.name = 'NoobAdmin';
    h.adapter.events.emit('directory');
    await pause(50);
    assert.match(await say(h, admin, '!nickfilter'), /Blocked words \(1\): noob$/);
  } finally {
    h.cleanup();
  }
});

test('move and kick modes act after the grace time; "move" needs a channel that exists', async () => {
  const h = await makeRig();
  try {
    const admin = h.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    await say(h, admin, '!nickfilter add badword');
    assert.match(await say(h, admin, '!nickfilter channel Nowhere'), /cannot find/);
    assert.match(await say(h, admin, '!nickfilter action move'), /moved to "AFK Room"/);
    await say(h, admin, '!nickfilter on');

    const m = join(h, 10, 'B4dW0rd Guy');
    await until(() => to(h, m).length >= 2, 10000, 'the warning');
    assert.match(to(h, m).at(-1)!, /or you will be moved to "AFK Room"/);
    await pause(1100);
    h.adapter.events.emit('directory');
    await until(() => m.channelId === AFK, 10000, 'the move');
    // wanders back out with the same name: moved again
    m.channelId = CH.a;
    h.adapter.events.emit('directory');
    await until(() => m.channelId === AFK, 10000, 'the second move');

    assert.match(await say(h, admin, '!nickfilter action kick'), /Kick mode/);
    const k = join(h, 11, 'badword2');
    await pause(1100);
    h.adapter.events.emit('directory');
    await until(() => h.adapter.kicks.some((x) => x.id === 11), 10000, 'the kick');
    assert.equal(h.adapter.kicks[0]!.reason, 'Nickname not allowed on this server');
    void k;

    assert.match(await say(h, admin, '!nickfilter remove badword'), /allowed again/);
    assert.match(await say(h, admin, '!nickfilter off'), /off/);
  } finally {
    h.cleanup();
  }
});
