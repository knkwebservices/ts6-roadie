import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildConfig, CONFIG_VERSION, ConfigError, loadConfig, migrations } from '../src/config.js';

test('defaults fill in what config.json leaves out', () => {
  const c = buildConfig({ server: { address: 'ts.example.com', nickname: 'Bot!' } });
  assert.equal(c.server.address, 'ts.example.com');
  assert.equal(c.prefix, '!');
  assert.equal(c.audio.codec, 5);
  assert.deepEqual(c.cogs, ['core', 'audio']);
  assert.ok(Object.keys(c.audio.radioStations).length > 0);
});

test('a partial audio block merges instead of replacing', () => {
  const c = buildConfig({ audio: { defaultVolume: 20 } });
  assert.equal(c.audio.defaultVolume, 20);
  assert.equal(c.audio.bitrate, 64_000);
});

test('user radio stations replace the defaults entirely', () => {
  const c = buildConfig({ audio: { radioStations: { mine: { name: 'Mine', url: 'https://x.example/stream' } } } });
  assert.deepEqual(Object.keys(c.audio.radioStations), ['mine']);
});

test('validation reports every problem at once', () => {
  assert.throws(
    () => buildConfig({ server: { nickname: 'x' }, prefix: 'too long', audio: { defaultVolume: 500 }, cogs: ['audio'] }),
    (e: Error) =>
      e instanceof ConfigError && /nickname/.test(e.message) && /prefix/.test(e.message) && /defaultVolume/.test(e.message) && /"core"/.test(e.message),
  );
});

test('a config from a newer bot is refused, not silently misread', () => {
  assert.throws(() => buildConfig({ configVersion: CONFIG_VERSION + 1 }), /newer|only understands/);
});

test('migrations run in order, and the file is backed up then upgraded on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsbot-cfg-'));
  try {
    // Simulate a future schema: pretend the current version is 1 and a v0 file exists.
    migrations[0] = (c) => ({ ...c, prefix: '.', server: { ...(c.server as object), nickname: 'Migrated Bot' } });
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ configVersion: 0, prefix: '?' }));
    const cfg = loadConfig(dir);
    assert.equal(cfg.prefix, '.');
    assert.equal(cfg.server.nickname, 'Migrated Bot');
    assert.equal(cfg.configVersion, CONFIG_VERSION);
    assert.ok(existsSync(join(dir, 'config.json.v0.bak')));
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).configVersion, CONFIG_VERSION);
  } finally {
    delete migrations[0];
    rmSync(dir, { recursive: true, force: true });
  }
});

test('missing or broken config gives a helpful error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tsbot-cfg-'));
  try {
    assert.throws(() => loadConfig(dir), /config.example.json/);
    writeFileSync(join(dir, 'config.json'), '{ nope');
    assert.throws(() => loadConfig(dir), /not valid JSON/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config.example.json is itself valid', () => {
  const raw = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  assert.doesNotThrow(() => buildConfig(raw));
});
