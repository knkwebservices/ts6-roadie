import assert from 'node:assert/strict';
import { test } from 'node:test';
import { WebAuth } from '../src/cogs/web/auth.js';

const alice = { uid: 'uid-alice', name: 'Alice' };
function make(over: Partial<ConstructorParameters<typeof WebAuth>[0]> = {}) {
  const clock = { t: 1_000_000 };
  const auth = new WebAuth({ codeTtlMs: 5 * 60_000, sessionTtlMs: 12 * 3_600_000, now: () => clock.t, ...over });
  return { auth, clock };
}

test('a code looks like XXXX-XXXX from an unambiguous alphabet, and each one is different', () => {
  const { auth } = make();
  const seen = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const c = auth.issueCode({ uid: `u${i}`, name: 'n' });
    assert.match(c, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/);
    seen.add(c);
  }
  assert.equal(seen.size, 200, 'no repeats');
});

test('a code signs you in as the person it was issued to, and only once', () => {
  const { auth } = make();
  const code = auth.issueCode(alice);
  const r = auth.redeem(code);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.session.uid, 'uid-alice');
  assert.equal(r.session.name, 'Alice');
  assert.equal(auth.session(r.sid)?.uid, 'uid-alice');
  assert.deepEqual(auth.redeem(code), { ok: false, reason: 'invalid' }, 'a used code is dead');
});

test('typing the code is forgiving about case, spaces and the dash', () => {
  const variants = [(c: string) => c.toLowerCase(), (c: string) => c.replace('-', ''), (c: string) => ` ${c} `, (c: string) => c.replace('-', ' '), (c: string) => c.toLowerCase().replace('-', ' ')];
  for (const [i, tweak] of variants.entries()) {
    const { auth } = make();
    const code = auth.issueCode(alice);
    assert.ok(auth.redeem(tweak(code)).ok, `variant ${i}: ${tweak(code)}`);
  }
});

test('a code expires', () => {
  const { auth, clock } = make();
  const code = auth.issueCode(alice);
  clock.t += 5 * 60_000 + 1;
  assert.deepEqual(auth.redeem(code), { ok: false, reason: 'invalid' });
});

test('asking for a new code cancels the old one', () => {
  const { auth } = make();
  const first = auth.issueCode(alice);
  const second = auth.issueCode(alice);
  assert.equal(auth.redeem(first).ok, false);
  assert.equal(auth.redeem(second).ok, true);
});

test('SAFETY: repeated wrong codes lock guessing out, even for the right code, until the window passes', () => {
  const { auth, clock } = make({ maxFailures: 3, failureWindowMs: 60_000 });
  const code = auth.issueCode(alice);
  for (let i = 0; i < 3; i++) assert.deepEqual(auth.redeem('WRONG-COD'), { ok: false, reason: 'invalid' });
  assert.deepEqual(auth.redeem(code), { ok: false, reason: 'locked' }, 'locked out: even the right code is refused');
  clock.t += 60_001;
  assert.equal(auth.redeem(code).ok, true, 'after the window the right code works again');
});

test('sessions expire and can be ended; junk ids give nothing', () => {
  const { auth, clock } = make({ sessionTtlMs: 1000 });
  const r = auth.redeem(auth.issueCode(alice));
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.ok(auth.session(r.sid));
  auth.end(r.sid);
  assert.equal(auth.session(r.sid), undefined);

  const r2 = auth.redeem(auth.issueCode(alice));
  if (!r2.ok) throw new Error('unexpected');
  clock.t += 1001;
  assert.equal(auth.session(r2.sid), undefined, 'expired');
  for (const junk of [undefined, '', 'nope', '../etc']) assert.equal(auth.session(junk), undefined);
});

test('session ids are long and unpredictable', () => {
  const { auth } = make();
  const ids = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const r = auth.redeem(auth.issueCode({ uid: `u${i}`, name: 'n' }));
    if (r.ok) {
      assert.ok(r.sid.length >= 43, 'at least 256 bits, base64url');
      ids.add(r.sid);
    }
  }
  assert.equal(ids.size, 50);
});

test('SAFETY: one visitor guessing wrongly does not lock out everyone else', () => {
  const { auth } = make({ maxFailures: 3, failureWindowMs: 60_000 });
  const code = auth.issueCode(alice);
  for (let i = 0; i < 3; i++) assert.deepEqual(auth.redeem('WRONG-COD', '203.0.113.9'), { ok: false, reason: 'invalid' });
  assert.deepEqual(auth.redeem('WRONG-COD', '203.0.113.9'), { ok: false, reason: 'locked' }, 'the guesser is locked out');
  assert.equal(auth.redeem(code, '198.51.100.7').ok, true, 'a different visitor can still sign in');
});

test('SAFETY: guessing spread over many addresses is stopped by the shared allowance', () => {
  const { auth } = make({ maxFailures: 3, maxTotalFailures: 6, failureWindowMs: 60_000 });
  const code = auth.issueCode(alice);
  for (let i = 0; i < 6; i++) assert.deepEqual(auth.redeem('WRONG-COD', `192.0.2.${i}`), { ok: false, reason: 'invalid' });
  assert.deepEqual(auth.redeem(code, '198.51.100.7'), { ok: false, reason: 'locked' }, 'everyone waits, even a brand-new address');
});

test('a flood of made-up addresses cannot make the bot remember them all', () => {
  const { auth } = make({ maxFailures: 3, maxTotalFailures: 1_000_000, failureWindowMs: 60_000 });
  for (let i = 0; i < 3000; i++) auth.redeem('WRONG-COD', `10.0.${i >> 8}.${i & 255}`);
  const code = auth.issueCode(alice);
  assert.equal(auth.redeem(code, '198.51.100.7').ok, true, 'still working after the flood');
});
