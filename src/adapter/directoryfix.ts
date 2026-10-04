import type { ClientInfo, DirectoryClientInfo } from '@echosixhiya/teamspeak-client';

/**
 * Corrections to the library's client list, from asking the server directly (`clientlist`).
 *
 * The library keeps its list up to date from the server's notifications. If one is missed (for
 * example someone moving between channels the bot was not subscribed to), its list stays wrong until
 * the next reconnect. These corrections cover the gap, and each one is dropped as soon as the library
 * itself catches up (so a later notification always wins).
 */
export interface DirectoryFixes {
  /** People the library has in the wrong channel: where they really are, and where the library had them. */
  moved: Map<number, { to: bigint; libWas: bigint }>;
  /** People the library still lists who are no longer on the server. */
  ghosts: Set<number>;
  /** People on the server the library doesn't list. */
  missing: Map<number, DirectoryClientInfo>;
}

export const emptyFixes = (): DirectoryFixes => ({ moved: new Map(), ghosts: new Set(), missing: new Map() });

export const fixCount = (f: DirectoryFixes): number => f.moved.size + f.ghosts.size + f.missing.size;

/** Compare the library's list with the server's answer. */
export function computeFixes(lib: DirectoryClientInfo[], server: ClientInfo[]): DirectoryFixes {
  const out = emptyFixes();
  const real = new Map(server.filter((s) => s.id > 0).map((s) => [s.id, s]));
  for (const c of lib) {
    const s = real.get(c.id);
    if (!s) out.ghosts.add(c.id);
    else if (s.channelID !== 0n && s.channelID !== c.channelID) out.moved.set(c.id, { to: s.channelID, libWas: c.channelID });
  }
  const known = new Set(lib.map((c) => c.id));
  for (const s of real.values()) if (!known.has(s.id) && s.channelID !== 0n) out.missing.set(s.id, { ...s, serverGroups: [...s.serverGroups] });
  return out;
}

/** The library's list with the corrections applied. Corrections the library has caught up with are dropped from `fixes`. */
export function applyFixes(lib: DirectoryClientInfo[], fixes: DirectoryFixes): DirectoryClientInfo[] {
  if (!fixCount(fixes)) return lib;
  const ids = new Set(lib.map((c) => c.id));
  for (const id of fixes.ghosts) if (!ids.has(id)) fixes.ghosts.delete(id);
  for (const id of fixes.missing.keys()) if (ids.has(id)) fixes.missing.delete(id);
  const out: DirectoryClientInfo[] = [];
  for (const c of lib) {
    if (fixes.ghosts.has(c.id)) continue;
    const m = fixes.moved.get(c.id);
    if (m) {
      if (c.channelID === m.libWas) {
        out.push({ ...c, channelID: m.to });
        continue;
      }
      fixes.moved.delete(c.id); // the library has heard about a move since: trust it
    }
    out.push(c);
  }
  out.push(...fixes.missing.values());
  return out;
}
