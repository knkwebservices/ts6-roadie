import type { Socket } from 'node:net';

/**
 * Sends one file over a TeamSpeak file-transfer connection.
 *
 * The transfer is a plain TCP connection to the server's file-transfer port: the client sends
 * the transfer key (which `dial` does) followed by the file's bytes, and the server closes the
 * connection when it has stored the file. The protocol library's own helper returns as soon as
 * the bytes are written; here we wait for the server to confirm by closing, because setting the
 * avatar hash before the file is stored would point it at nothing.
 */

export interface TransferTicket {
  port: number;
  key: string;
}

/** Opens the connection and sends the key. In production this is the protocol library's `dialFileTransfer`. */
export type Dial = (host: string, port: number, key: string) => Promise<Socket>;

export interface SendOptions {
  /** After we have finished sending, how long to wait for the server to close before carrying on. */
  closeWaitMs?: number;
  /** Give up on the whole transfer after this long. */
  totalMs?: number;
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function sendOverTransfer(dial: Dial, host: string, ticket: TransferTicket, bytes: Buffer, opts: SendOptions = {}): Promise<void> {
  const closeWaitMs = opts.closeWaitMs ?? 4_000;
  const totalMs = opts.totalMs ?? 20_000;

  let socket: Socket;
  try {
    socket = await dial(host, ticket.port, ticket.key);
  } catch (e) {
    throw new Error(
      `could not reach the server's file-transfer port (TCP ${ticket.port} on ${host}): ${msg(e)}. ` +
        'That port has to be open to the bot in the server\'s firewall.',
    );
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let sent = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (err?: Error): void => {
      if (settled) return;
      settled = true;
      for (const t of timers) clearTimeout(t);
      socket.destroy();
      if (err) reject(err);
      else resolve();
    };

    timers.push(setTimeout(() => done(new Error(`timed out after ${Math.round(totalMs / 1000)}s`)), totalMs));
    socket.on('error', (e) => done(new Error(`connection error: ${e.message}`)));
    // The server closing after we have sent everything is the "stored it" signal. Closing earlier is a failure.
    socket.on('close', () => done(sent ? undefined : new Error('the server closed the connection before all the data was sent')));
    // Drain anything the server says so the socket can close promptly.
    socket.resume();

    socket.once('finish', () => {
      sent = true;
      // Some servers keep the connection open; don't wait forever for a close that may never come.
      timers.push(setTimeout(() => done(), closeWaitMs));
    });
    socket.write(bytes, (err) => {
      if (err) return done(new Error(`send failed: ${err.message}`));
      socket.end(); // half-close: nothing more from us
    });
  });
}

/** "host", "host:port", "[::1]:9987" -> the host part, for connecting to the file-transfer port. */
export function hostFromAddress(address: string): string {
  const a = address.trim();
  if (a.startsWith('[')) {
    const end = a.indexOf(']');
    return end > 0 ? a.slice(1, end) : a;
  }
  const first = a.indexOf(':');
  // exactly one colon means host:port; more than one is a bare IPv6 address
  return first > 0 && first === a.lastIndexOf(':') ? a.slice(0, first) : a;
}
