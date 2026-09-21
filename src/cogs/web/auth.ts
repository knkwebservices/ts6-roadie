import { randomBytes } from 'node:crypto';

/**
 * Login for the dashboard, tied to TeamSpeak identities.
 *
 * A person types !weblogin in TeamSpeak and the bot privately sends them a short one-time code.
 * Typing that code into the dashboard signs them in as themselves: no passwords exist to store or
 * leak, and the dashboard never has more rights than that person has in chat.
 *
 * Everything here lives in memory: restarting the bot signs everyone out, which is fine.
 */

export interface Person {
  uid: string;
  name: string;
}

export interface Session extends Person {
  expires: number;
}

export interface AuthOptions {
  /** How long a login code stays valid, in ms. */
  codeTtlMs: number;
  /** How long a signed-in session lasts, in ms. */
  sessionTtlMs: number;
  /** Wrong-code attempts allowed from one address within the window before that address is refused (default 8). */
  maxFailures?: number;
  /** Wrong-code attempts allowed from everyone together within the window (default 5 times maxFailures). */
  maxTotalFailures?: number;
  /** Length of that window in ms (default 5 minutes). */
  failureWindowMs?: number;
  /** Test seam. */
  now?: () => number;
}

/** 32 symbols with nothing that looks like another (no 0/O, no 1/I): 8 of them is about 40 bits. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_SESSIONS = 100;
/** Remember at most this many addresses' failures, so a flood of made-up addresses cannot fill memory. */
const MAX_TRACKED_CLIENTS = 1000;

export type Redeemed = { ok: true; sid: string; session: Session } | { ok: false; reason: 'invalid' | 'locked' };

export class WebAuth {
  readonly #codes = new Map<string, Person & { expires: number }>();
  readonly #sessions = new Map<string, Session>();
  /** Recent wrong guesses, per client address. */
  readonly #failures = new Map<string, number[]>();
  readonly #now: () => number;

  constructor(private readonly o: AuthOptions) {
    this.#now = o.now ?? Date.now;
  }

  /** A fresh single-use code for this person, shown as XXXX-XXXX. Any earlier unused code of theirs stops working. */
  issueCode(person: Person): string {
    this.#sweep();
    for (const [c, p] of this.#codes) if (p.uid === person.uid) this.#codes.delete(c);
    const bytes = randomBytes(8);
    let raw = '';
    for (const b of bytes) raw += ALPHABET[b % 32]; // 256 is a multiple of 32, so every symbol is equally likely
    this.#codes.set(raw, { ...person, expires: this.#now() + this.o.codeTtlMs });
    return `${raw.slice(0, 4)}-${raw.slice(4)}`;
  }

  /**
   * Trade a code for a session. Wrong guesses are rate-limited so a code cannot be brute-forced:
   * each client address gets its own allowance, so a stranger guessing cannot lock out the real users,
   * and a shared allowance for everyone together still stops guessing that is spread over many addresses.
   */
  redeem(input: string, client = 'local'): Redeemed {
    const now = this.#now();
    this.#sweep();
    const window = this.o.failureWindowMs ?? 5 * 60_000;
    const perClient = this.o.maxFailures ?? 8;
    const total = this.o.maxTotalFailures ?? perClient * 5;
    const mine = (this.#failures.get(client) ?? []).filter((t) => now - t < window);
    let all = 0;
    for (const [k, list] of this.#failures) {
      const recent = list.filter((t) => now - t < window);
      if (recent.length === 0) this.#failures.delete(k);
      else {
        this.#failures.set(k, recent);
        all += recent.length;
      }
    }
    if (mine.length >= perClient || all >= total) return { ok: false, reason: 'locked' };

    const code = String(input).toUpperCase().replace(/[\s-]/g, '');
    const hit = this.#codes.get(code);
    if (!hit || hit.expires <= now) {
      if (!this.#failures.has(client) && this.#failures.size >= MAX_TRACKED_CLIENTS) this.#failures.delete(this.#failures.keys().next().value!);
      this.#failures.set(client, [...mine, now]);
      return { ok: false, reason: 'invalid' };
    }
    this.#codes.delete(code); // single use

    const sid = randomBytes(32).toString('base64url');
    const session: Session = { uid: hit.uid, name: hit.name, expires: now + this.o.sessionTtlMs };
    if (this.#sessions.size >= MAX_SESSIONS) this.#sessions.delete(this.#sessions.keys().next().value!);
    this.#sessions.set(sid, session);
    return { ok: true, sid, session };
  }

  session(sid: string | undefined): Session | undefined {
    if (!sid) return undefined;
    const s = this.#sessions.get(sid);
    if (!s) return undefined;
    if (s.expires <= this.#now()) {
      this.#sessions.delete(sid);
      return undefined;
    }
    return s;
  }

  end(sid: string | undefined): void {
    if (sid) this.#sessions.delete(sid);
  }

  #sweep(): void {
    const now = this.#now();
    for (const [c, p] of this.#codes) if (p.expires <= now) this.#codes.delete(c);
    for (const [k, s] of this.#sessions) if (s.expires <= now) this.#sessions.delete(k);
  }
}
