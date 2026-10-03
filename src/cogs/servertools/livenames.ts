/** TeamSpeak refuses channel names longer than this. */
export const MAX_CHANNEL_NAME = 40;

export interface LiveValues {
  /** People online now (not counting the bot). */
  online: number;
  /** The most people online at once. */
  record: number;
  /** What the bot is playing, or empty when nothing is. */
  song: string;
  /** Staff (bot admins and servertools.staffGroups) online now. */
  staff?: number;
  /** Their names, comma-separated, or empty. */
  staffNames?: string;
}

/** The placeholders a live channel name may use. */
export const PLACEHOLDERS = ['{online}', '{record}', '{song}', '{staff}', '{staffnames}'] as const;

const shorten = (s: string, room: number): string => (room >= 4 ? `${s.slice(0, room - 3).trimEnd()}...` : '');

/**
 * Fill in a live name template, then make it fit: TeamSpeak allows at most 40 characters, so a long
 * song title (then a long staff list) is shortened with "..." (and the whole name is cut, as a last resort).
 */
export function renderLiveName(template: string, v: LiveValues): string {
  const fill = (song: string, names: string): string =>
    template
      .replace(/\{online\}/gi, String(v.online))
      .replace(/\{record\}/gi, String(v.record))
      .replace(/\{staffnames\}/gi, names)
      .replace(/\{staff\}/gi, String(v.staff ?? 0))
      .replace(/\{song\}/gi, song)
      .replace(/[\r\n\t]+/g, ' ');
  let song = v.song.trim() || '-';
  let names = (v.staffNames ?? '').trim() || 'none';
  let out = fill(song, names);
  if (out.length > MAX_CHANNEL_NAME && /\{song\}/i.test(template)) {
    // Only the song part shrinks, so "Now playing: " and the like stay readable.
    song = shorten(song, MAX_CHANNEL_NAME - fill('', names).length);
    out = fill(song, names);
  }
  if (out.length > MAX_CHANNEL_NAME && /\{staffnames\}/i.test(template)) {
    names = shorten(names, MAX_CHANNEL_NAME - fill(song, '').length);
    out = fill(song, names);
  }
  if (out.length > MAX_CHANNEL_NAME) out = out.slice(0, MAX_CHANNEL_NAME);
  return out.trim() ? out : '-';
}
