/**
 * Reading "when" for events, the way people type it in chat, in the bot machine's own time zone:
 *
 *   Friday 8pm   fri 20:00   tomorrow 7:30pm   today 9pm   8pm (the next 8 pm)
 *   10/31 8pm   10/31/2026 20:00   2026-10-31 8pm   in 2h   in 45m   in 1h30m
 *   weekly Friday 8pm   every fri 8pm   (repeats each week)
 */

const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

export interface When {
  at: Date;
  weekly: boolean;
}

/** A day name, or its first three letters or more ("fri", "frid", "friday"). */
function dayIndex(word: string): number {
  const w = word.toLowerCase().replace(/[.,]$/, '');
  if (w.length < 3) return -1;
  return DAYS.findIndex((d) => d.startsWith(w));
}

/** "8pm", "8:30pm", "8 pm", "20:00", "noon", "midnight" -> [hours, minutes], or undefined. */
function parseTime(text: string): [number, number] | undefined {
  const t = text.trim().toLowerCase().replace(/\s+/g, '');
  if (t === 'noon') return [12, 0];
  if (t === 'midnight') return [0, 0];
  const m = /^(\d{1,2})(?::(\d{2}))?(am|pm|a|p)?$/.exec(t);
  if (!m) return undefined;
  let h = Number(m[1]);
  const min = m[2] === undefined ? 0 : Number(m[2]);
  const ap = m[3]?.[0];
  if (min > 59) return undefined;
  if (ap) {
    if (h < 1 || h > 12) return undefined;
    if (ap === 'p' && h !== 12) h += 12;
    if (ap === 'a' && h === 12) h = 0;
  } else {
    // a bare number needs minutes ("20:00") or it is too easy to misread ("8" - morning or evening?)
    if (m[2] === undefined || h > 23) return undefined;
  }
  return [h, min];
}

function at(base: Date, h: number, m: number): Date {
  const d = new Date(base);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Read a "when". Returns the time, or a message saying what could not be understood. */
export function parseWhen(input: string, now = new Date()): When | string {
  let words = input.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'Say when, like "Friday 8pm", "tomorrow 7:30pm" or "in 2h".';

  let weekly = false;
  if (/^(weekly|every)$/i.test(words[0]!)) {
    weekly = true;
    words = words.slice(1);
  }

  // "in 2h", "in 45m", "in 1h30m", "in 2 hours"
  if (words[0]?.toLowerCase() === 'in') {
    const rest = words.slice(1).join('').toLowerCase().replace(/hours?|hrs?/g, 'h').replace(/minutes?|mins?/g, 'm');
    const m = /^(?:(\d+)h)?(?:(\d+)m)?$/.exec(rest);
    if (!m || (!m[1] && !m[2])) return `I didn't understand "${input}". Try "in 2h" or "in 45m".`;
    const ms = (Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0)) * 60_000;
    if (ms <= 0 || ms > 366 * 86_400_000) return 'That is too far away.';
    return { at: new Date(now.getTime() + ms), weekly };
  }

  // the time is the last word (or the last two: "8 pm")
  let time = parseTime(words.at(-1) ?? '');
  let used = 1;
  if (!time && words.length >= 2) {
    time = parseTime(words.slice(-2).join(''));
    used = 2;
  }
  if (!time) return `I couldn't find a time in "${input}". Put it last, like "Friday 8pm" or "Friday 20:00".`;
  const dayWords = words.slice(0, words.length - used);
  const dayText = dayWords.join(' ').toLowerCase();

  let when: Date;
  if (!dayText || dayText === 'today' || dayText === 'tonight') {
    when = at(now, time[0], time[1]);
    if (when <= now) {
      if (dayText) return 'That time has already passed today.';
      when.setDate(when.getDate() + 1); // just "8pm": the next 8 pm
    }
  } else if (dayText === 'tomorrow') {
    when = at(now, time[0], time[1]);
    when.setDate(when.getDate() + 1);
  } else if (dayWords.length === 1 && dayIndex(dayText) >= 0) {
    const target = dayIndex(dayText);
    when = at(now, time[0], time[1]);
    let add = (target - now.getDay() + 7) % 7;
    if (add === 0 && when <= now) add = 7; // "Friday 8pm" said on a Friday after 8 pm: next week
    when.setDate(when.getDate() + add);
  } else {
    // 2026-10-31, 10/31, 10/31/2026
    const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(dayText);
    const us = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(dayText);
    let y: number;
    let mo: number;
    let d: number;
    if (iso) [y, mo, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    else if (us) {
      mo = Number(us[1]);
      d = Number(us[2]);
      y = us[3] ? Number(us[3].length === 2 ? `20${us[3]}` : us[3]) : now.getFullYear();
    } else return `I didn't understand the day "${dayWords.join(' ')}". Use a day name (Friday), today, tomorrow, or a date like 10/31.`;
    when = new Date(y, mo - 1, d, time[0], time[1], 0, 0);
    if (when.getMonth() !== mo - 1 || when.getDate() !== d) return `There is no date ${dayWords.join(' ')}.`;
    // "10/31" with no year, already gone this year: next year
    if (!iso && !us?.[3] && when <= now) when.setFullYear(when.getFullYear() + 1);
  }
  if (when <= now) return 'That time has already passed.';
  if (when.getTime() - now.getTime() > 366 * 86_400_000) return 'That is more than a year away.';
  return { at: when, weekly };
}

/** "Fri Oct 2, 8:00 PM" in the bot machine's time zone. */
export function formatWhen(d: Date): string {
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** "in 3 days", "in 5 h 20 min", "in 12 min", "now". */
export function formatUntil(ms: number): string {
  if (ms <= 60_000) return 'now';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `in ${h} h${min % 60 ? ` ${min % 60} min` : ''}`;
  return `in ${Math.round(h / 24)} days`;
}
