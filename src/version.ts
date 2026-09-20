import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function findPackageJson(startDir: string, name?: string): { version?: string; name?: string } | undefined {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const f = join(dir, 'package.json');
    if (existsSync(f)) {
      try {
        const pkg = JSON.parse(readFileSync(f, 'utf8'));
        if (!name || pkg.name === name) return pkg;
      } catch {
        /* keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

const here = dirname(fileURLToPath(import.meta.url));

export const BOT_VERSION: string = findPackageJson(here, 'ts6-roadie')?.version ?? 'unknown';

/** Version of the vendored TeamSpeak protocol library (its package.json is not in its exports map). */
export function tsLibVersion(): string {
  try {
    const entry = fileURLToPath(import.meta.resolve('@echosixhiya/teamspeak-client'));
    return findPackageJson(dirname(entry), '@echosixhiya/teamspeak-client')?.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
