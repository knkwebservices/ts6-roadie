import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { AUDIO_SERVICE, type AudioService, type NowPlaying } from '../src/core/services.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const track = (id: number): NowPlaying => ({ id, kind: 'media', title: `Song ${id}`, url: `https://www.youtube.com/watch?v=s${id}`, durationSec: 100 });

async function setup(threshold?: number, listeners = 3, withAudio = true) {
  const h = await makeBot({ config: makeConfig({ cogs: ['core', 'voteskip'], ...(threshold === undefined ? {} : { voteskip: { threshold } }) }) });
  const state = { current: track(1) as NowPlaying | undefined, skips: 0 };
  const svc: AudioService = {
    snapshot: () => ({ current: state.current, upcoming: [] }),
    queue: async () => {},
    skip: () => {
      state.skips++;
      return true;
    },
    resolve: async () => [],
  };
  if (withAudio) h.bot.services.provide<AudioService>(AUDIO_SERVICE, svc);
  const users = ['Alice', 'Bob', 'Cara', 'Dan'].slice(0, listeners).map((n, i) => h.adapter.addUser(5 + i, n, CH.home));
  return { h, state, users };
}

async function ask(h: Harness, u: TsUser, text = '!voteskip'): Promise<string> {
  const n = h.adapter.sent.length;
  h.adapter.say(u, text);
  await until(() => h.adapter.sent.length > n, 10000, `a reply to "${text}"`);
  return h.adapter.lastReply();
}

test('alone with the bot, one vote skips at once', async () => {
  const { h, state, users } = await setup(undefined, 1);
  try {
    assert.match(await ask(h, users[0]!), /Vote passed.*Skipping: Song 1/);
    assert.equal(state.skips, 1);
  } finally {
    h.cleanup();
  }
});

test('with three listeners it takes two votes (more than half), and the vote is announced', async () => {
  const { h, state, users } = await setup();
  try {
    assert.match(await ask(h, users[0]!), /Alice voted to skip\. 1\/2 needed/);
    assert.equal(state.skips, 0);
    assert.match(await ask(h, users[1]!, '!vs'), /Vote passed \(2 of 3\)/);
    assert.equal(state.skips, 1);
  } finally {
    h.cleanup();
  }
});

test('one person voting twice counts once', async () => {
  const { h, state, users } = await setup();
  try {
    await ask(h, users[0]!);
    assert.match(await ask(h, users[0]!), /already voted\. 1\/2/);
    assert.equal(state.skips, 0);
  } finally {
    h.cleanup();
  }
});

test('a vote stops counting when its voter leaves the channel', async () => {
  const { h, state, users } = await setup(undefined, 3);
  try {
    await ask(h, users[0]!); // Alice votes: 1/2
    users[0]!.channelId = CH.a; // Alice walks away, so two people are left listening: 2 needed
    assert.match(await ask(h, users[1]!), /Bob voted to skip\. 1\/2 needed/);
    assert.equal(state.skips, 0);
    assert.match(await ask(h, users[2]!), /Vote passed/);
    assert.equal(state.skips, 1);
  } finally {
    h.cleanup();
  }
});

test('a new track starts a fresh vote', async () => {
  const { h, state, users } = await setup();
  try {
    await ask(h, users[0]!); // 1/2 on track 1
    state.current = track(2);
    assert.match(await ask(h, users[1]!), /Bob voted to skip\. 1\/2 needed/, 'Alice\'s vote was for the previous track');
    assert.equal(state.skips, 0);
  } finally {
    h.cleanup();
  }
});

test('the threshold is configurable: 0 means a single vote is enough', async () => {
  const { h, state, users } = await setup(0, 4);
  try {
    assert.match(await ask(h, users[0]!), /Vote passed/);
    assert.equal(state.skips, 1);
  } finally {
    h.cleanup();
  }
});

test('you must be in the bot\'s channel; nothing playing and a missing audio cog are explained', async () => {
  const { h, state, users } = await setup();
  try {
    const outsider = h.adapter.addUser(20, 'Zed', CH.b);
    assert.match(await ask(h, outsider), /need to be in my channel/);
    state.current = undefined;
    assert.match(await ask(h, users[0]!), /Nothing is playing/);
    assert.equal(state.skips, 0);
  } finally {
    h.cleanup();
  }
  const bare = await setup(undefined, 1, false);
  try {
    assert.match(await ask(bare.h, bare.users[0]!), /audio cog is not loaded/);
  } finally {
    bare.h.cleanup();
  }
});
