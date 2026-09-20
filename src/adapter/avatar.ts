import { createHash } from 'node:crypto';
import type { AvatarResult } from './types.js';

/**
 * How a TeamSpeak client avatar works (verified against the TSLib implementation in TS3AudioBot):
 *   1. upload the image to channel 0 of the server's file area as "/avatar" (overwriting), then
 *   2. tell the server which file is current: `clientupdate client_flag_avatar=<md5 of the file>`.
 * Other clients fetch the image when they see a new hash, so the hash is what makes it show up.
 *
 * This file holds that sequence and the checks around it. It never touches the protocol library:
 * everything it needs is passed in as `AvatarIo`, which keeps it easy to test.
 */

/** An error whose message is safe and useful to show to a bot admin. */
export class AvatarError extends Error {}

/** Sanity cap only. The server enforces its own (often smaller) limit and says so when it refuses. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

export type ImageKind = 'png' | 'jpeg' | 'gif';

export function detectImage(b: Buffer): ImageKind | undefined {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6) {
    const head = b.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  return undefined;
}

export const md5Hex = (b: Buffer): string => createHash('md5').update(b).digest('hex');

export interface AvatarIo<T> {
  /** The avatar hash the server currently shows for the bot ("" if none); undefined if it can't be read. */
  currentHash(): Promise<string | undefined>;
  /** Ask the server for an upload slot for `size` bytes. */
  initUpload(size: number): Promise<T>;
  /** Send the bytes over the upload slot and wait until the server has taken them. */
  send(ticket: T, bytes: Buffer): Promise<void>;
  /** Set the bot's avatar hash ("" clears it). */
  setFlag(hash: string): Promise<void>;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function applyAvatar<T>(io: AvatarIo<T>, image: Buffer, opts: { force?: boolean } = {}): Promise<AvatarResult> {
  if (image.length === 0) throw new AvatarError('the avatar file is empty');
  if (image.length > MAX_AVATAR_BYTES) {
    throw new AvatarError(`the avatar file is too big (${Math.round(image.length / 1024)} KB, the limit here is ${MAX_AVATAR_BYTES / 1024} KB)`);
  }
  if (!detectImage(image)) throw new AvatarError('the avatar file is not a PNG, JPEG or GIF image');

  const md5 = md5Hex(image);

  if (!opts.force) {
    const current = await io.currentHash().catch(() => undefined);
    if (current !== undefined && current.toLowerCase() === md5) return { status: 'unchanged', md5, bytes: image.length };
  }

  let ticket: T;
  try {
    ticket = await io.initUpload(image.length);
  } catch (e) {
    throw new AvatarError(`the server refused the upload: ${msg(e)}`);
  }

  try {
    await io.send(ticket, image);
  } catch (e) {
    // Deliberately do NOT set the hash: it would point at a file that never arrived.
    throw new AvatarError(`the upload failed: ${msg(e)}`);
  }

  try {
    await io.setFlag(md5);
  } catch (e) {
    throw new AvatarError(`the image was uploaded, but the server would not switch to it: ${msg(e)}`);
  }
  return { status: 'uploaded', md5, bytes: image.length };
}

/**
 * Remove the bot's avatar by resetting its hash. The uploaded file stays in the server's file
 * area (a few KB); the next upload simply overwrites it.
 */
export async function clearAvatar(io: Pick<AvatarIo<unknown>, 'setFlag'>): Promise<void> {
  try {
    await io.setFlag('');
  } catch (e) {
    throw new AvatarError(`could not clear the avatar: ${msg(e)}`);
  }
}
