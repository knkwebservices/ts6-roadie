#!/usr/bin/env node
// Install, update and roll back the bot on the VPS.
//
//   node scripts/deploy.mjs --root C:\tsbot --from <folder | .zip | git-url> [options]
//   node scripts/deploy.mjs --root C:\tsbot --rollback
//
// Layout it manages:
//   <root>\releases\<timestamp>-<version>\   each deploy is a complete, separate copy
//   <root>\current                           junction to the active release (the service runs from here)
//   <root>\data\                             config.json, identity.json, logs...  (never touched by a deploy)
//
// A deploy: stage -> install deps -> (build) -> smoke test against the real TeamSpeak server ->
// stop service -> repoint `current` -> start service -> wait for the bot to report "connected".
// If the smoke test fails nothing is touched. If the new release doesn't come up healthy, the
// previous release is put back automatically.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const isWin = process.platform === 'win32';
const { values: opt } = parseArgs({
  options: {
    root: { type: 'string' },
    from: { type: 'string' },
    ref: { type: 'string' },
    service: { type: 'string', default: 'tsbot' },
    ctl: { type: 'string', default: 'nssm' },
    'no-service': { type: 'boolean', default: false },
    'skip-smoke': { type: 'boolean', default: false },
    rollback: { type: 'boolean', default: false },
    keep: { type: 'string', default: '3' },
    'health-timeout': { type: 'string', default: '90' },
    'health-any': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

const log = (m) => console.log(`[deploy] ${m}`);
const die = (m, code = 1) => {
  console.error(`[deploy] ERROR: ${m}`);
  process.exit(code);
};

if (opt.help || !opt.root || (!opt.from && !opt.rollback)) {
  console.log(`Usage:
  node scripts/deploy.mjs --root <install dir> --from <folder|zip|git-url> [--ref <tag>]
  node scripts/deploy.mjs --root <install dir> --rollback

Options:
  --service <name>      service name (default: tsbot)
  --ctl <program>       service controller, called as "<program> start|stop <name>" (default: nssm)
  --no-service          don't stop/start a service or wait for health (first install, or testing)
  --skip-smoke          skip the smoke test (not recommended)
  --keep <n>            releases to keep (default 3)
  --health-timeout <s>  seconds to wait for the new bot to connect (default 90)
  --health-any          count a live bot as healthy even if it is not connected to TeamSpeak`);
  process.exit(opt.help ? 0 : 2);
}

const root = resolve(opt.root);
const releasesDir = join(root, 'releases');
const currentLink = join(root, 'current');
const dataDir = join(root, 'data');
const healthFile = join(dataDir, 'health.json');
const keep = Math.max(2, Number(opt.keep) || 3);
const healthTimeoutMs = Math.max(1, Number(opt['health-timeout'])) * 1000;

mkdirSync(releasesDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

// ---- small helpers ------------------------------------------------------------------------

function run(cmd, args, o = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', shell: isWin && ['npm', 'npx'].includes(cmd), ...o });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function currentTarget() {
  try {
    return lstatSync(currentLink).isSymbolicLink() ? resolve(dirname(currentLink), readlinkSync(currentLink)) : undefined;
  } catch {
    return undefined;
  }
}

function pointCurrentAt(dir) {
  try {
    unlinkSync(currentLink);
  } catch (e) {
    if (e.code !== 'ENOENT') rmSync(currentLink, { recursive: true, force: true });
  }
  symlinkSync(dir, currentLink, 'junction'); // 'junction' needs no admin rights on Windows
}

function listReleases() {
  return readdirSync(releasesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^\d{14}-/.test(d.name))
    .map((d) => join(releasesDir, d.name))
    .sort(); // timestamp prefix => chronological
}

function service(action) {
  if (opt['no-service']) return true;
  try {
    execFileSync(opt.ctl, [action, opt.service], { stdio: 'inherit' });
    return true;
  } catch (e) {
    log(`warning: "${opt.ctl} ${action} ${opt.service}" failed (${e.message.split('\n')[0]})`);
    return false;
  }
}

function readHealth() {
  try {
    return JSON.parse(readFileSync(healthFile, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Wait until a bot process started after `since` reports it is running (and connected). */
async function waitHealthy(since) {
  if (opt['no-service']) return true;
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    const h = readHealth();
    if (h && h.alive && h.startedAt >= since && Date.now() - h.updatedAt < 30_000 && (opt['health-any'] || h.connected)) return h;
    await sleep(1000);
  }
  return false;
}

// ---- staging --------------------------------------------------------------------------------

function findProjectRoot(dir) {
  if (existsSync(join(dir, 'package.json'))) return dir;
  const subs = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory());
  if (subs.length === 1 && existsSync(join(dir, subs[0].name, 'package.json'))) return join(dir, subs[0].name);
  throw new Error(`no package.json found in ${dir}`);
}

function stage(src) {
  const tmp = mkdtempSync(join(tmpdir(), 'tsbot-stage-'));
  const work = join(tmp, 'src');
  mkdirSync(work);
  if (/^(https?:\/\/|git@|ssh:\/\/)/.test(src) || src.endsWith('.git')) {
    log(`cloning ${src}${opt.ref ? ` @ ${opt.ref}` : ''}`);
    run('git', ['clone', '--depth', '1', ...(opt.ref ? ['--branch', opt.ref] : []), src, work]);
    rmSync(join(work, '.git'), { recursive: true, force: true });
    return { tmp, dir: work };
  }
  const p = resolve(src);
  if (!existsSync(p)) throw new Error(`source not found: ${p}`);
  if (p.toLowerCase().endsWith('.zip')) {
    log(`extracting ${p}`);
    // bsdtar ships with Windows 10 / Server 2019+ and reads zip; elsewhere use unzip.
    if (isWin) run('tar', ['-xf', p, '-C', work]);
    else run('unzip', ['-q', p, '-d', work]);
    return { tmp, dir: findProjectRoot(work) };
  }
  log(`copying ${p}`);
  cpSync(p, work, {
    recursive: true,
    filter: (f) => !['node_modules', '.git', 'data', 'releases'].includes(basename(f)) || f === p,
  });
  return { tmp, dir: work };
}

function prepare(dir) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const prebuilt = existsSync(join(dir, 'dist', 'index.js'));
  if (prebuilt) {
    log('release ships a built dist/ - installing production dependencies only');
    run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir });
  } else {
    log('no dist/ in the release - installing, building, then pruning dev dependencies');
    run('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir });
    run('npm', ['run', 'build'], { cwd: dir });
    run('npm', ['prune', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir });
  }
  return pkg.version;
}

function smokeTest(dir) {
  if (opt['skip-smoke']) return log('skipping smoke test');
  log('running smoke test against the TeamSpeak server (a second, throwaway client connects briefly)...');
  const r = spawnSync(process.execPath, [join('dist', 'smoke.js')], { cwd: dir, stdio: 'inherit', env: { ...process.env, TSBOT_DATA: dataDir } });
  if (r.status !== 0) throw new Error('smoke test failed - the live bot has not been touched');
}

// ---- switching ------------------------------------------------------------------------------

async function switchTo(target, previous) {
  const since = Date.now();
  log(`stopping service "${opt.service}"`);
  service('stop');
  pointCurrentAt(target);
  log(`current -> ${basename(target)}`);
  log(`starting service "${opt.service}"`);
  const started = service('start');
  const healthy = started && (await waitHealthy(since));
  if (healthy) return { ok: true, health: healthy };

  if (!previous || previous === target) return { ok: false, rolledBack: false };
  log(`the new release did not come up healthy within ${healthTimeoutMs / 1000}s - rolling back to ${basename(previous)}`);
  const since2 = Date.now();
  service('stop');
  pointCurrentAt(previous);
  service('start');
  const back = await waitHealthy(since2);
  log(back ? 'previous release is running again' : 'WARNING: the previous release did not report healthy either - check the logs in data\\logs');
  return { ok: false, rolledBack: true };
}

async function main() {
  if (opt.rollback) {
    const cur = currentTarget();
    const all = listReleases();
    const idx = cur ? all.indexOf(cur) : -1;
    const prev = idx > 0 ? all[idx - 1] : undefined;
    if (!prev) die('there is no older release to roll back to');
    log(`rolling back ${basename(cur)} -> ${basename(prev)}`);
    const r = await switchTo(prev, undefined);
    if (!r.ok) die('the older release did not report healthy - check data\\logs');
    return log('rollback complete');
  }

  const previous = currentTarget();
  const { tmp, dir } = stage(opt.from);
  let target;
  try {
    const version = prepare(dir);
    smokeTest(dir);
    target = join(releasesDir, `${stamp()}-${version}`);
    renameSync(dir, target);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    die(e.message);
  }
  rmSync(tmp, { recursive: true, force: true });

  const r = await switchTo(target, previous);
  if (!r.ok) {
    if (r.rolledBack) rmSync(target, { recursive: true, force: true });
    die(r.rolledBack ? 'deploy failed and was rolled back' : 'deploy finished, but the bot did not report healthy - check data\\logs');
  }

  // Keep the newest few releases (always including the active one and the one before it).
  const all = listReleases();
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    if (old !== target && old !== previous) rmSync(old, { recursive: true, force: true });
  }
  log(`deployed ${basename(target)}${r.health && r.health.version ? ` (bot ${r.health.version} connected)` : ''}`);
}

main().catch((e) => die(e.stack ?? e.message));
