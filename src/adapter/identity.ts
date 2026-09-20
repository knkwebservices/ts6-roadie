import { existsSync, readFileSync } from 'node:fs';
import { getUidFromPublicKey, identityFromString, generateIdentity, type Identity } from '@echosixhiya/teamspeak-client';
import type { Log } from '../logger.js';
import { writeJsonAtomic } from '../util/fs.js';

export interface LoadedIdentity {
  identity: Identity;
  uid: string;
}

/**
 * Load the bot's identity from disk, creating (and saving) one on first run.
 * The identity is what TeamSpeak knows the bot as: keep the file, keep the
 * server-group assignment. Losing it means a new UID and a new group setup.
 */
export async function loadOrCreateIdentity(file: string, level: number, log: Log): Promise<LoadedIdentity> {
  let identity: Identity;
  let dirty = false;

  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { identity: string };
    identity = identityFromString(saved.identity);
  } else {
    log.info(`No identity found - generating a new one (security level ${level}). This can take a moment...`);
    identity = generateIdentity(0);
    dirty = true;
  }

  if (identity.securityLevel() < level) {
    log.info(`Raising identity security level from ${identity.securityLevel()} to ${level}...`);
    const t0 = Date.now();
    await identity.upgradeToLevel(level);
    log.info(`Identity security level ${identity.securityLevel()} reached in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    dirty = true;
  }

  const uid = getUidFromPublicKey(identity.publicKeyBase64());
  if (dirty) {
    writeJsonAtomic(file, { identity: identity.toString(), uid, createdAt: new Date().toISOString() });
    log.info(`Identity saved to ${file}`);
  }
  return { identity, uid };
}
