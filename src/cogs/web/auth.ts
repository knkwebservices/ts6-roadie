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
  /** Wrong-code attempts allowed within the window before further attempts are refused (default 8). */
  maxFailures?: number;
  /** Length of that window in ms (default 5 minutes). */
  failureWindowMs?: number;
  /** Test seam. */
  now?: () => number;
}

/** 32 symbols with nothing that looks like another (no 0/O, no 1/I): 8 of them is about 40 bits. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_SESSIONS = 100;

export type Redeemed = { ok: true; sid: string; session: Session } | { ok: false; reason: 'invalid' | 'locked' };

export class WebAuth {
  readonly #codes = new Map<string, Person & { expires: number }>();
  readonly #sessions = new Map<string, Session>();
  #failures: number[] = [];
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

  /** Trade a code for a session. Wrong guesses are rate-limited so a code cannot be brute-forced. */
  redeem(input: string): Redeemed {
    const now = this.#now();
    this.#sweep();
    const window = this.o.failureWindowMs ?? 5 * 60_000;
    this.#failures = this.#failures.filter((t) => now - t < window);
    if (this.#failures.length >= (this.o.maxFailures ?? 8)) return { ok: false, reason: 'locked' };

    const code = String(input).toUpperCase().replace(/[\s-]/g, '');
    const hit = this.#codes.get(code);
    if (!hit || hit.expires <= now) {
      this.#failures.push(now);
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
