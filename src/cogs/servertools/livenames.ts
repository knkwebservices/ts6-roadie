/** TeamSpeak refuses channel names longer than this. */
export const MAX_CHANNEL_NAME = 40;

export interface LiveValues {
  /** People online now (not counting the bot). */
  online: number;
  /** The most people online at once. */
  record: number;
  /** What the bot is playing, or empty when nothing is. */
  song: string;
}

/** The placeholders a live channel name may use. */
export const PLACEHOLDERS = ['{online}', '{record}', '{song}'] as const;

/**
 * Fill in a live name template, then make it fit: TeamSpeak allows at most 40 characters, so a long
 * song title is shortened with "..." (and the whole name is cut, as a last resort, if it is still too long).
 */
export function renderLiveName(template: string, v: LiveValues): string {
  const fill = (song: string): string =>
    template
      .replace(/\{online\}/gi, String(v.online))
      .replace(/\{record\}/gi, String(v.record))
      .replace(/\{song\}/gi, song)
      .replace(/[\r\n\t]+/g, ' ');
  const song = v.song.trim() || '-';
  let out = fill(song);
  if (out.length > MAX_CHANNEL_NAME && /\{song\}/i.test(template)) {
    // Only the song part shrinks, so "Now playing: " and the like stay readable.
    const room = MAX_CHANNEL_NAME - fill('').length;
    out = fill(room >= 4 ? `${song.slice(0, room - 3).trimEnd()}...` : '');
  }
  if (out.length > MAX_CHANNEL_NAME) out = out.slice(0, MAX_CHANNEL_NAME);
  return out.trim() ? out : '-';
}
