import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { smokeNickname, smokeUid } from '../src/adapter/identity.js';

test("the deploy smoke test's client can be recognised, so it is never counted as a person", () => {
  assert.equal(smokeNickname('TGSC Bot'), 'TGSC Bot-smoke');
  assert.equal(smokeNickname('A very long bot nickname here'), 'A very long bot nickna-smoke');
  const dir = mkdtempSync(join(tmpdir(), 'smoke-'));
  assert.equal(smokeUid(dir), undefined, 'no smoke test has run yet');
  writeFileSync(join(dir, 'smoke-identity.json'), JSON.stringify({ identity: 'x', uid: 'abc123=' }));
  assert.equal(smokeUid(dir), 'abc123=');
  writeFileSync(join(dir, 'smoke-identity.json'), 'not json');
  assert.equal(smokeUid(dir), undefined);
});
