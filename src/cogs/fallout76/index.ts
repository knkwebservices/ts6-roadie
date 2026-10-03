import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage } from '../../util/text.js';
import { formatUntil, formatWhen } from '../events/when.js';
import { isBigSale, parseDay, parsePlace, placeName, PLACES, schedule, visitTimes, whereIs, type Visit } from './minerva.js';
import { fetchNukeCodes, NukesError, type NukeCodes } from './nukes.js';

export const manifest: CogManifest = {
  name: 'fallout76',
  version: '1.0.0',
  description: 'Fallout 76: this week\'s nuke codes (!nukes) and where Minerva is (!minerva)',
};

/** After a failed or too-early fetch, wait this long before asking NukaCrypt again. */
const RETRY_MS = 15 * 60_000;
/** How often the bot checks whether the codes need fetching (it only fetches when they have changed). */
const CHECK_MS = 15 * 60_000;
const WARMUP_MS = 5_000;
const MAX_ADDED = 100;

export interface Fallout76Deps {
  fetchCodes(): Promise<NukeCodes>;
  now(): number;
}

const defaultDeps: Fallout76Deps = { fetchCodes: () => fetchNukeCodes(), now: () => Date.now() };

const CREDIT = 'Codes from NukaCrypt (nukacrypt.com)';

export function createFallout76Cog(bot: BotApi, deps: Fallout76Deps = defaultDeps): Cog {
  const p = bot.config.prefix;
  const log = bot.log.child('fallout76');

  let codes = bot.state.get<NukeCodes | null>('fallout76.codes', null);
  let added = bot.state.get<Visit[]>('fallout76.minerva.added', []);
  let removed = bot.state.get<string[]>('fallout76.minerva.removed', []);
  let lastTry = 0;
  let lastError: string | undefined;
  let inflight: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let warmTimer: NodeJS.Timeout | undefined;

  const saveMinerva = (): void => {
    bot.state.set('fallout76.minerva.added', added);
    bot.state.set('fallout76.minerva.removed', removed);
  };

  const current = (): boolean => !!codes && deps.now() < codes.until;

  /** Fetch only when the codes we have are missing or out of date, and not more often than RETRY_MS. */
  async function refresh(force = false): Promise<void> {
    if (!force && current()) return;
    if (inflight) return inflight;
    if (!force && deps.now() - lastTry < RETRY_MS) return;
    lastTry = deps.now();
    inflight = (async () => {
      try {
        const got = await deps.fetchCodes();
        if (!codes || got.from >= codes.from) {
          codes = got;
          bot.state.set('fallout76.codes', codes);
        }
        lastError = undefined;
      } catch (e) {
        lastError = e instanceof NukesError ? e.message : errMessage(e);
        log.warn(`nuke codes: ${lastError}`);
      } finally {
        inflight = undefined;
      }
    })();
    return inflight;
  }

  function nukesReply(only?: 'alpha' | 'bravo' | 'charlie'): string {
    const now = deps.now();
    if (!codes) return `I couldn't get the nuke codes${lastError ? `: ${lastError.replace(/\.$/, '')}` : ''}. Try again in a while.`;
    if (now >= codes.until) {
      return [
        `The nuke codes changed ${formatWhen(new Date(codes.until))} and NukaCrypt hasn't posted the new ones yet. They usually have them within a few hours. I'll keep checking.`,
        lastError ? `(Last try: ${lastError})` : '',
      ]
        .filter(Boolean)
        .join('\n');
    }
    const head = `Fallout 76 nuke codes, good until ${formatWhen(new Date(codes.until))} (${formatUntil(codes.until - now).replace(/^in /, '')} left):`;
    const lines = (['alpha', 'bravo', 'charlie'] as const).filter((s) => !only || s === only).map((s) => `${s[0]!.toUpperCase()}${s.slice(1)}: ${codes![s]}`);
    return [head, ...lines, CREDIT].join('\n');
  }

  const visitLine = (v: Visit): string => {
    const t = visitTimes(v);
    return `${placeName(v.place)}${isBigSale(v) ? ' (Big Sale)' : ''}${v.list ? `, list ${v.list}` : ''}: ${formatWhen(new Date(t.start))} to ${formatWhen(new Date(t.end))}`;
  };

  function minervaReply(): string {
    const now = deps.now();
    const { current: here, next } = whereIs(schedule(added, removed), now);
    const out: string[] = [];
    if (here) {
      const t = visitTimes(here);
      out.push(
        `Minerva is at ${placeName(here.place)} now${isBigSale(here) ? ' for her Big Sale' : ''}${here.list ? ` (list ${here.list})` : ''}. She leaves ${formatWhen(new Date(t.end))} (${formatUntil(t.end - now)}).`,
      );
    } else {
      out.push('Minerva is away right now.');
    }
    const n = next[0];
    if (n) {
      const t = visitTimes(n);
      out.push(`${here ? 'After that' : 'Next'}: ${visitLine(n)} (${formatUntil(t.start - now)}).`);
    } else {
      out.push(`I don't know her next visit yet. Admins can add it: ${p}minerva add <date> <place>`);
    }
    out.push('She arrives and leaves at noon US Eastern.');
    return out.join('\n');
  }

  const cog: Cog = {
    commands: [
      {
        name: 'nukes',
        aliases: ['nuke', 'nukecodes'],
        description: `This week's Fallout 76 nuke codes, from NukaCrypt: ${p}nukes [alpha|bravo|charlie]`,
        usage: `${p}nukes [alpha|bravo|charlie]`,
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (sub === 'refresh') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            await refresh(true);
            return ctx.reply(nukesReply());
          }
          if (sub && sub !== 'alpha' && sub !== 'bravo' && sub !== 'charlie') return ctx.reply(`Usage: ${p}nukes [alpha|bravo|charlie]`);
          await refresh();
          return ctx.reply(nukesReply(sub as 'alpha' | 'bravo' | 'charlie' | undefined));
        },
      },
      {
        name: 'minerva',
        description: `Where Minerva is in Fallout 76 and when she comes next: ${p}minerva [list] (admins: add <date> <place> [list number], remove <date>)`,
        usage: `${p}minerva [list|add <YYYY-MM-DD> <place> [list number]|remove <YYYY-MM-DD>]`,
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub) return ctx.reply(minervaReply());

          if (sub === 'list' || sub === 'schedule') {
            const now = deps.now();
            const { current: here, next } = whereIs(schedule(added, removed), now);
            const show = [...(here ? [here] : []), ...next].slice(0, 6);
            if (!show.length) return ctx.reply(`I don't know any upcoming visits. Admins can add one: ${p}minerva add <date> <place>`);
            return ctx.reply(['Minerva\'s coming visits (noon US Eastern to noon US Eastern):', ...show.map((v) => (v === here ? `NOW: ${visitLine(v)}` : visitLine(v).replace(/^the /, 'The ')))].join('\n'));
          }

          if (sub === 'add') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const day = parseDay(ctx.args[1] ?? '');
            const rest = ctx.args.slice(2);
            const listN = rest.length > 1 && /^\d{1,3}$/.test(rest.at(-1)!) ? Number(rest.pop()) : undefined;
            const place = parsePlace(rest.join(' '));
            if (!day || !place)
              return ctx.reply(
                `Usage: ${p}minerva add <date> <place> [list number], like: ${p}minerva add 2027-02-01 Foundation 17\nPlaces: ${PLACES.join(', ')}. The date is her first day; Whitespring visits are her Thursday-to-Monday Big Sale, the others Monday to Wednesday.`,
              );
            if (added.length >= MAX_ADDED) return ctx.reply(`That's a lot of added visits. Remove some first with ${p}minerva remove <date>.`);
            const v: Visit = { start: day, place, ...(listN !== undefined ? { list: listN } : {}) };
            added = [...added.filter((a) => a.start !== day), v];
            removed = removed.filter((r) => r !== day);
            saveMinerva();
            return ctx.reply(`Added: ${visitLine(v)}.`);
          }

          if (sub === 'remove') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const day = parseDay(ctx.args[1] ?? '');
            if (!day) return ctx.reply(`Usage: ${p}minerva remove <date>, the first day of the visit, like 2026-10-19`);
            if (!schedule(added, removed).some((v) => v.start === day)) return ctx.reply(`There's no visit starting ${day}. ${p}minerva list shows them.`);
            added = added.filter((a) => a.start !== day);
            if (!removed.includes(day)) removed = [...removed, day];
            saveMinerva();
            return ctx.reply(`Removed the visit starting ${day}.`);
          }

          return ctx.reply(`Usage: ${p}minerva [list|add <date> <place> [list number]|remove <date>]`);
        },
      },
    ],

    onLoad() {
      warmTimer = setTimeout(() => void refresh(), WARMUP_MS);
      warmTimer.unref?.();
      timer = setInterval(() => void refresh(), CHECK_MS);
      timer.unref?.();
    },

    onUnload() {
      if (timer) clearInterval(timer);
      if (warmTimer) clearTimeout(warmTimer);
    },

    status: () => {
      if (!codes) return `Nuke codes not fetched yet${lastError ? ` (${lastError})` : ''}`;
      return current() ? `Nuke codes good until ${formatWhen(new Date(codes.until))}` : 'Nuke codes out of date, waiting for NukaCrypt';
    },
  };
  return cog;
}

const factory: CogFactory = (bot) => createFallout76Cog(bot);
export default factory;
