import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { after, before, test } from 'node:test';

const deployScript = resolve(import.meta.dirname, '../scripts/deploy.mjs');
let base: string;
let root: string;
let ctl: string;

/** A stand-in for a bot release: writes health.json like the real bot does, then idles. */
function makeRelease(name: string, version: string, opts: { connected?: boolean; smokeOk?: boolean } = {}): string {
  const dir = join(base, 'src-' + name);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'ts6-roadie', version, private: true }));
  writeFileSync(join(dir, 'package-lock.json'), JSON.stringify({ name: 'ts6-roadie', version, lockfileVersion: 3, requires: true, packages: { '': { name: 'ts6-roadie', version } } }));
  writeFileSync(
    join(dir, 'dist', 'index.js'),
    `const fs=require('fs'),path=require('path');
     const f=path.join(process.env.TSBOT_DATA,'health.json'); const startedAt=Date.now();
     const w=()=>fs.writeFileSync(f,JSON.stringify({pid:process.pid,version:'${version}',startedAt,updatedAt:Date.now(),alive:true,connected:${opts.connected !== false}}));
     w(); setInterval(w,500);`,
  );
  writeFileSync(join(dir, 'dist', 'smoke.js'), `process.exit(${opts.smokeOk === false ? 1 : 0});`);
  return dir;
}

function deploy(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, [deployScript, '--root', root, '--ctl', ctl, '--service', 'fake', '--health-timeout', '6', ...args], {
    encoding: 'utf8',
    env: { ...process.env, FAKE_ROOT: root },
  });
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}

const health = () => JSON.parse(readFileSync(join(root, 'data', 'health.json'), 'utf8')) as { pid: number; version: string; startedAt: number };
const currentName = () => basename(readlinkSync(join(root, 'current')));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const releases = () => readdirSync(join(root, 'releases')).sort();

before(() => {
  base = mkdtempSync(join(tmpdir(), 'tsbot-deploy-'));
  root = join(base, 'install');
  // Fake service controller: `start` launches whatever `current` points at, `stop` kills it.
  writeFileSync(
    join(base, 'ctl.cjs'),
    `const {spawn}=require('child_process'),fs=require('fs'),path=require('path');
     const root=process.env.FAKE_ROOT, pidf=path.join(root,'fake.pid'); const [action]=process.argv.slice(2);
     if(action==='start'){ const c=spawn(process.execPath,[path.join(root,'current','dist','index.js')],{detached:true,stdio:'ignore',env:{...process.env,TSBOT_DATA:path.join(root,'data')}}); c.unref(); fs.writeFileSync(pidf,String(c.pid)); }
     else if(action==='stop'){ try{ process.kill(Number(fs.readFileSync(pidf,'utf8'))); }catch{} try{fs.unlinkSync(pidf)}catch{} }`,
  );
  ctl = join(base, 'ctl.sh');
  writeFileSync(ctl, `#!/bin/sh\nexec "${process.execPath}" "${join(base, 'ctl.cjs')}" "$@"\n`);
  chmodSync(ctl, 0o755);
  mkdirSync(root, { recursive: true });
});

after(() => {
  spawnSync(ctl, ['stop', 'fake'], { env: { ...process.env, FAKE_ROOT: root } });
  rmSync(base, { recursive: true, force: true });
});

test('deploy → update → bad update rolls back → failed smoke test touches nothing → manual rollback', { timeout: 120_000 }, async () => {
  // 1. First deploy.
  let r = deploy(['--from', makeRelease('v1', '1.0.0')]);
  assert.equal(r.code, 0, r.out);
  assert.equal(health().version, '1.0.0');
  assert.match(currentName(), /^\d{14}-1\.0\.0$/);
  const v1 = currentName();

  // 2. Healthy update.
  await new Promise((res) => setTimeout(res, 1100)); // release ids are timestamped to the second
  r = deploy(['--from', makeRelease('v2', '2.0.0')]);
  assert.equal(r.code, 0, r.out);
  assert.equal(health().version, '2.0.0');
  const v2 = currentName();
  assert.notEqual(v1, v2);
  assert.ok(releases().includes(v1), 'the previous release is kept for rollback');

  // 3. A release that starts but never connects must be rolled back automatically.
  await new Promise((res) => setTimeout(res, 1100));
  r = deploy(['--from', makeRelease('v3', '3.0.0', { connected: false })]);
  assert.notEqual(r.code, 0, 'a failed deploy must exit non-zero');
  assert.match(r.out, /rolling back/);
  assert.equal(currentName(), v2, 'current points at the previous release again');
  await until(() => health().version === '2.0.0', 8000);
  assert.ok(!releases().some((n) => n.endsWith('-3.0.0')), 'the failed release is removed');

  // 4. A release whose smoke test fails must not touch the running bot at all.
  const pidBefore = health().pid;
  await new Promise((res) => setTimeout(res, 1100));
  r = deploy(['--from', makeRelease('v4', '4.0.0', { smokeOk: false })]);
  assert.notEqual(r.code, 0);
  assert.match(r.out, /smoke test failed/);
  assert.equal(currentName(), v2);
  assert.equal(health().pid, pidBefore, 'the live bot was not restarted');
  assert.ok(alive(pidBefore));
  assert.ok(!releases().some((n) => n.endsWith('-4.0.0')));

  // 5. Manual rollback to the older release.
  r = deploy(['--rollback']);
  assert.equal(r.code, 0, r.out);
  assert.equal(currentName(), v1);
  assert.equal(health().version, '1.0.0');
  r = deploy(['--rollback']);
  assert.notEqual(r.code, 0, 'nothing older than the first release to roll back to');
});

test('old releases are pruned but the active and previous ones stay', { timeout: 120_000 }, async () => {
  for (const v of ['5.0.0', '6.0.0', '7.0.0']) {
    await new Promise((res) => setTimeout(res, 1100));
    const r = deploy(['--from', makeRelease('p' + v, v), '--keep', '2']);
    assert.equal(r.code, 0, r.out);
  }
  const names = releases();
  assert.ok(names.length <= 3, `expected pruning, still have: ${names.join(', ')}`);
  assert.ok(names.some((n) => n.endsWith('-7.0.0')) && names.some((n) => n.endsWith('-6.0.0')));
  assert.equal(health().version, '7.0.0');
});

test('the data folder is never touched by a deploy', { timeout: 60_000 }, async () => {
  writeFileSync(join(root, 'data', 'config.json'), '{"keep":"me"}');
  await new Promise((res) => setTimeout(res, 1100));
  const r = deploy(['--from', makeRelease('d', '8.0.0')]);
  assert.equal(r.code, 0, r.out);
  assert.equal(readFileSync(join(root, 'data', 'config.json'), 'utf8'), '{"keep":"me"}');
  assert.ok(existsSync(join(root, 'data')));
});

test('a .zip source works too', { timeout: 60_000 }, async () => {
  const src = makeRelease('z', '9.0.0');
  const zip = join(base, 'bot.zip');
  const z = spawnSync('zip', ['-qr', zip, 'ts6-roadie'], { cwd: join(base), encoding: 'utf8' });
  // zip the release under a top-level folder, as a real release archive would be
  const wrap = join(base, 'ts6-roadie');
  spawnSync('cp', ['-r', src, wrap]);
  const z2 = spawnSync('zip', ['-qr', zip, 'ts6-roadie'], { cwd: base, encoding: 'utf8' });
  assert.equal(z2.status, 0, z.stderr + z2.stderr);
  await new Promise((res) => setTimeout(res, 1100));
  const r = deploy(['--from', zip]);
  assert.equal(r.code, 0, r.out);
  assert.equal(health().version, '9.0.0');
});

async function until(cond: () => boolean, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (cond()) return;
    } catch {
      /* not there yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}
