import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ServiceRegistry } from '../src/core/services.js';

test('a provided service can be fetched, and unknown names give undefined', () => {
  const reg = new ServiceRegistry();
  const svc = { hello: () => 'hi' };
  reg.provide('greeter', svc);
  assert.equal(reg.get<typeof svc>('greeter'), svc);
  assert.equal(reg.get('nothing'), undefined);
});

test('two cogs cannot provide the same name', () => {
  const reg = new ServiceRegistry();
  reg.provide('audio', {});
  assert.throws(() => reg.provide('audio', {}), /already provided/);
});

test('the returned function withdraws the service, and only that registration', () => {
  const reg = new ServiceRegistry();
  const first = {};
  const offFirst = reg.provide('audio', first);
  offFirst();
  assert.equal(reg.get('audio'), undefined);

  // A late "unload" from an old instance must not remove a newer one registered after a reload.
  const second = {};
  reg.provide('audio', second);
  offFirst();
  assert.equal(reg.get('audio'), second);
});
