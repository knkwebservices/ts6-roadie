import { appendFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Log {
  debug(msg: string, ...extra: unknown[]): void;
  info(msg: string, ...extra: unknown[]): void;
  warn(msg: string, ...extra: unknown[]): void;
  error(msg: string, ...extra: unknown[]): void;
  child(scope: string): Log;
}

export interface LoggerOptions {
  level?: Level;
  /** Directory for daily log files. Omit to log to the console only. */
  dir?: string;
  keepDays?: number;
  scope?: string;
}

function fmtExtra(extra: unknown[]): string {
  if (!extra.length) return '';
  return (
    ' ' +
    extra
      .map((e) => {
        if (e instanceof Error) return e.stack ?? e.message;
        if (typeof e === 'string') return e;
        try {
          return JSON.stringify(e, (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
        } catch {
          return String(e);
        }
      })
      .join(' ')
  );
}

export function createLogger(opts: LoggerOptions = {}): Log {
  const min = ORDER[opts.level ?? 'info'];
  if (opts.dir) {
    mkdirSync(opts.dir, { recursive: true });
    pruneOldLogs(opts.dir, opts.keepDays ?? 14);
  }
  const make = (scope?: string): Log => {
    const write = (level: Level, msg: string, extra: unknown[]) => {
      if (ORDER[level] < min) return;
      const now = new Date();
      const line = `${now.toISOString()} ${level.toUpperCase().padEnd(5)}${scope ? ` [${scope}]` : ''} ${msg}${fmtExtra(extra)}`;
      (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
      if (opts.dir) {
        try {
          appendFileSync(join(opts.dir, `tsbot-${now.toISOString().slice(0, 10)}.log`), line + '\n');
        } catch {
          /* logging must never take the bot down */
        }
      }
    };
    return {
      debug: (m, ...e) => write('debug', m, e),
      info: (m, ...e) => write('info', m, e),
      warn: (m, ...e) => write('warn', m, e),
      error: (m, ...e) => write('error', m, e),
      child: (s) => make(scope ? `${scope}:${s}` : s),
    };
  };
  return make(opts.scope);
}

function pruneOldLogs(dir: string, keepDays: number): void {
  const cutoff = Date.now() - keepDays * 86_400_000;
  try {
    for (const f of readdirSync(dir)) {
      if (!/^tsbot-\d{4}-\d{2}-\d{2}\.log$/.test(f)) continue;
      const p = join(dir, f);
      if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
    }
  } catch {
    /* best effort */
  }
}

export const silentLog: Log = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return silentLog;
  },
};
