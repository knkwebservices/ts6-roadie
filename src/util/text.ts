/** Text helpers shared by the core and cogs. */

/**
 * TeamSpeak wraps pasted links in BBCode ("[URL]https://…[/URL]"). Strip formatting so
 * commands see plain text. "[URL=link]label[/URL]" keeps the link, drops the label.
 */
export function stripBbcode(s: string): string {
  return s
    .replace(/\[url=([^\]]+)\][\s\S]*?\[\/url\]/gi, '$1')
    .replace(/\[\/?[a-z]+(?:=[^\]]*)?\]/gi, '')
    .trim();
}

export interface ParsedCommand {
  name: string;
  args: string[];
  /** Everything after the command name, untouched apart from trimming. */
  rest: string;
}

export function parseCommandLine(text: string, prefix: string): ParsedCommand | null {
  if (!text.startsWith(prefix)) return null;
  const body = text.slice(prefix.length).trim();
  if (!body) return null;
  const m = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body);
  if (!m) return null;
  const name = m[1]!.toLowerCase();
  const rest = (m[2] ?? '').trim();
  return { name, args: rest ? rest.split(/\s+/) : [], rest };
}

/** Split long replies so each chat message stays well under TeamSpeak's ~1024 byte limit. */
export function chunkText(s: string, max = 800): string[] {
  const out: string[] = [];
  let cur = '';
  const push = () => {
    if (cur) out.push(cur);
    cur = '';
  };
  for (const line of s.split('\n')) {
    let l = line;
    while (l.length > max) {
      const cut = l.lastIndexOf(' ', max);
      const at = cut > max * 0.5 ? cut : max;
      if (cur) push();
      out.push(l.slice(0, at));
      l = l.slice(at).trimStart();
    }
    if (cur.length + l.length + 1 > max) push();
    cur = cur ? `${cur}\n${l}` : l;
  }
  push();
  return out.length ? out : [''];
}

export function formatDuration(totalSec: number | undefined): string {
  if (totalSec === undefined || !Number.isFinite(totalSec)) return 'live';
  const s = Math.max(0, Math.round(totalSec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}

export function formatUptime(totalSec: number): string {
  const d = Math.floor(totalSec / 86400);
  const h = Math.floor((totalSec % 86400) / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return [d ? `${d}d` : '', h ? `${h}h` : '', `${m}m`].filter(Boolean).join(' ');
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** "just now", "5 min ago", "3 h ago", "2 d ago": how long ago something was. */
export function formatAgo(thenMs: number, nowMs = Date.now()): string {
  const s = Math.max(0, Math.floor((nowMs - thenMs) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
