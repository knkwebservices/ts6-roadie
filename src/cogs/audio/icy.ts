import http from 'node:http';
import https from 'node:https';
import { isPublicHttpUrl } from './sources.js';

/**
 * Reads the "now playing" song titles an internet radio station announces inside its stream.
 *
 * How ICY works: the client sends "Icy-MetaData: 1". The station answers with an "icy-metaint: N"
 * header, then interleaves the audio with a small message after every N bytes: one length byte
 * (in units of 16 bytes), then that many bytes of text such as  StreamTitle='Artist - Song';
 *
 * ffmpeg asks for this too but throws the titles away (it only ever reports the station's name), so
 * the bot opens its own connection just to read them. That is a second copy of the audio stream, a
 * few KB/s, only while a radio track is playing, and it is discarded unread apart from the titles.
 */

export interface IcyOptions {
  /** Called with a cleaned-up title each time the station announces a different one. */
  onTitle(title: string): void;
  /** Decides whether a redirect target may be followed. Defaults to the public-http(s) check. */
  checkRedirect?: (url: string) => boolean;
  /** Reconnection attempts after a dropped or failed connection (default 5). */
  maxRetries?: number;
  /** Base delay before a reconnect; it grows with each attempt (default 3000 ms). */
  retryDelayMs?: number;
  /** Called with a short reason when the listener gives up or hits a problem. */
  onNote?(note: string): void;
}

const MAX_REDIRECTS = 3;
const IDLE_TIMEOUT_MS = 20_000;

/**
 * Titles come from a remote server and are shown in chat: drop control characters, flatten
 * TeamSpeak's [bracket] formatting, collapse spaces and cap the length.
 */
export function cleanTitle(raw: string): string {
  return raw
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 150);
}

/** Pull the song title out of one ICY metadata block. Undefined if the block has none. */
export function parseStreamTitle(block: Buffer): string | undefined {
  // Most stations send UTF-8; older ones send Latin-1. Fall back when UTF-8 comes out garbled.
  let text = block.toString('utf8');
  if (text.includes('\ufffd')) text = block.toString('latin1');
  const m = /StreamTitle='(.*?)';/s.exec(text.replace(/\0+$/, ''));
  const title = m ? cleanTitle(m[1]!) : '';
  return title || undefined;
}

/** Start listening. Returns a function that stops listening and closes the connection. */
export function startIcyTitles(url: string, opts: IcyOptions): () => void {
  const maxRetries = opts.maxRetries ?? 5;
  const retryDelay = opts.retryDelayMs ?? 3_000;
  const okToFollow = opts.checkRedirect ?? isPublicHttpUrl;
  let stopped = false;
  let req: http.ClientRequest | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let attempts = 0;
  let last: string | undefined;

  const retry = (why: string): void => {
    if (stopped) return;
    attempts++;
    if (attempts > maxRetries) {
      opts.onNote?.(`gave up on song titles after ${maxRetries} retries (${why})`);
      return;
    }
    retryTimer = setTimeout(() => connect(url, 0), retryDelay * attempts);
    retryTimer.unref?.();
  };

  const connect = (target: string, hops: number): void => {
    if (stopped) return;
    let lib: typeof http;
    try {
      lib = new URL(target).protocol === 'https:' ? (https as unknown as typeof http) : http;
    } catch {
      return void opts.onNote?.('bad station address');
    }
    let done = false; // one retry per connection, however it ends
    const finish = (why: string): void => {
      if (done) return;
      done = true;
      retry(why);
    };

    const r = lib.get(target, { headers: { 'Icy-MetaData': '1', 'User-Agent': 'TS6Roadie', Accept: '*/*' } }, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        done = true;
        let next: string;
        try {
          next = new URL(res.headers.location, target).toString();
        } catch {
          return;
        }
        if (hops >= MAX_REDIRECTS || !okToFollow(next)) return void opts.onNote?.('did not follow a redirect');
        return connect(next, hops + 1);
      }
      if (status !== 200) {
        res.resume();
        return finish(`HTTP ${status}`);
      }

      const metaint = Number(res.headers['icy-metaint']);
      if (!Number.isInteger(metaint) || metaint <= 0) {
        // This station does not announce titles. That is normal, so stay quiet and do not retry.
        done = true;
        res.destroy();
        return void opts.onNote?.('this station does not announce song titles');
      }

      attempts = 0; // a good connection resets the retry ladder
      // state machine: audio (metaint bytes) -> length byte -> metadata (length*16 bytes) -> audio ...
      let phase: 'audio' | 'len' | 'meta' = 'audio';
      let audioLeft = metaint;
      let metaLeft = 0;
      let meta: Buffer[] = [];

      res.on('data', (chunk: Buffer) => {
        let i = 0;
        while (i < chunk.length && !stopped) {
          if (phase === 'audio') {
            const n = Math.min(audioLeft, chunk.length - i);
            i += n;
            audioLeft -= n;
            if (audioLeft === 0) phase = 'len';
          } else if (phase === 'len') {
            metaLeft = chunk[i++]! * 16;
            if (metaLeft === 0) {
              phase = 'audio';
              audioLeft = metaint;
            } else {
              phase = 'meta';
              meta = [];
            }
          } else {
            const n = Math.min(metaLeft, chunk.length - i);
            meta.push(chunk.subarray(i, i + n));
            i += n;
            metaLeft -= n;
            if (metaLeft === 0) {
              const title = parseStreamTitle(Buffer.concat(meta));
              if (title && title !== last) {
                last = title;
                opts.onTitle(title);
              }
              phase = 'audio';
              audioLeft = metaint;
            }
          }
        }
      });
      res.on('error', () => finish('connection error'));
      res.on('close', () => finish('connection closed'));
    });
    req = r;
    r.setTimeout(IDLE_TIMEOUT_MS, () => r.destroy());
    r.on('error', () => finish('could not connect'));
  };

  connect(url, 0);

  return () => {
    stopped = true;
    if (retryTimer) clearTimeout(retryTimer);
    req?.destroy();
  };
}
