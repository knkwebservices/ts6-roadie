#!/usr/bin/env node
// Builds a pinned copy of the teamspeak-js library and packs it into vendor/.
//
// Why: the library is not published on npm, and building it on the VPS would add
// a fragile step to every deploy. Run this on a dev machine (needs git + npm),
// commit the resulting .tgz, and the bot installs it like any other dependency.
//
// Usage:  node scripts/vendor-teamspeak.mjs <commit-sha-or-tag>
//         (default: the commit recorded in vendor/VENDORED.json)
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = 'https://github.com/EchoSixHIYA/teamspeak-js.git';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const vendorDir = join(root, 'vendor');
const metaFile = join(vendorDir, 'VENDORED.json');
const isWin = process.platform === 'win32';

const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: isWin && cmd === 'npm' });

const previous = existsSync(metaFile) ? JSON.parse(readFileSync(metaFile, 'utf8')) : {};
const ref = process.argv[2] ?? previous.commit;
if (!ref) {
  console.error('Usage: node scripts/vendor-teamspeak.mjs <commit-sha-or-tag>');
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), 'tsjs-'));
try {
  const src = join(work, 'src');
  run('git', ['clone', REPO, src]);
  run('git', ['checkout', ref], src);
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: src }).toString().trim();

  run('npm', ['ci'], src);
  run('npm', ['run', 'build'], src);

  // Stage a minimal package: dist (without maps/test typings), license, sanitized package.json.
  const stage = join(work, 'package');
  mkdirSync(stage);
  cpSync(join(src, 'dist'), join(stage, 'dist'), {
    recursive: true,
    filter: (p) => !p.endsWith('.map') && !/\.test\.d\.ts$/.test(p),
  });
  cpSync(join(src, 'LICENSE'), join(stage, 'LICENSE'));
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  for (const k of ['scripts', 'devDependencies', 'packageManager', 'publishConfig']) delete pkg[k];
  pkg.files = ['dist'];
  writeFileSync(join(stage, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');

  mkdirSync(vendorDir, { recursive: true });
  for (const f of readdirSync(vendorDir)) if (f.endsWith('.tgz')) rmSync(join(vendorDir, f));
  const out = execFileSync('npm', ['pack', '--pack-destination', vendorDir, '--silent'], {
    cwd: stage,
    shell: isWin,
  })
    .toString()
    .trim()
    .split(/\r?\n/)
    .pop();

  writeFileSync(
    metaFile,
    JSON.stringify(
      {
        package: pkg.name,
        version: pkg.version,
        commit,
        repo: REPO,
        tarball: out,
        vendoredAt: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
  );
  console.log(`\nVendored ${pkg.name}@${pkg.version} (${commit.slice(0, 10)}) -> vendor/${out}`);
  console.log(
    'Next: update the "file:" path in package.json if the filename changed, then `npm install`, run the tests and the smoke test.',
  );
} finally {
  rmSync(work, { recursive: true, force: true });
}
