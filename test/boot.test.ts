import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(import.meta.dirname, '..');

/**
 * Regression test for a real bug: with the TeamSpeak server unreachable the process used to
 * exit silently (nothing was keeping the event loop alive). It must stay up and keep retrying.
 */
test('the bot process stays alive and retries when the server is unreachable, and exits cleanly on SIGTERM', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsbot-boot-'));
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({ server: { address: '127.0.0.1:9', nickname: 'Boot Test', homeChannel: 'Lobby', identityLevel: 4 } }),
  );
  const child = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/index.ts')], {
    env: { ...process.env, TSBOT_DATA: dir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  let exited: number | null | undefined;
  child.on('exit', (code) => (exited = code));

  try {
    await new Promise((r) => setTimeout(r, 4500));
    assert.equal(exited, undefined, `process exited early (code ${exited}):\n${out}`);
    assert.match(out, /loaded cog core/);
    assert.match(out, /loaded cog audio/);
    assert.match(out, /Bot identity UID: \S+=/);
    assert.match(out, /reconnecting in \d+s/);
    assert.ok(existsSync(join(dir, 'identity.json')));
    const health = JSON.parse(readFileSync(join(dir, 'health.json'), 'utf8'));
    assert.equal(health.alive, true);
    assert.equal(health.connected, false);

    child.kill('SIGTERM');
    await new Promise<void>((res) => child.once('exit', () => res()));
    assert.equal(exited, 0, `expected a clean exit, got ${exited}`);
    assert.equal(JSON.parse(readFileSync(join(dir, 'health.json'), 'utf8')).alive, false);
  } finally {
    child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a bad config makes the bot exit with a clear message instead of starting half-configured', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsbot-badcfg-'));
  writeFileSync(join(dir, 'config.json'), JSON.stringify({ prefix: 'way too long', cogs: ['audio'] }));
  try {
    const result = await new Promise<{ code: number | null; out: string }>((res) => {
      const c = spawn(process.execPath, ['--import', 'tsx', join(root, 'src/index.ts')], { env: { ...process.env, TSBOT_DATA: dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      c.stdout.on('data', (d) => (out += d));
      c.stderr.on('data', (d) => (out += d));
      c.on('exit', (code) => res({ code, out }));
    });
    assert.equal(result.code, 2);
    assert.match(result.out, /prefix/);
    assert.match(result.out, /"core"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
