/** TeamSpeak reports server groups as text ("6", or "6,9" in some places). Keep only valid whole-number group IDs. */
export function parseGroupIds(raw: string | string[] | undefined): number[] {
  const parts = Array.isArray(raw) ? raw : (raw ?? '').split(',');
  const out: number[] = [];
  for (const p of parts) {
    const t = p.trim();
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      if (!out.includes(n)) out.push(n);
    }
  }
  return out;
}
