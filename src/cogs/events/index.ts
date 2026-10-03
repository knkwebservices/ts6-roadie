import type { BotApi, Cog, CogFactory, CogManifest, CommandContext } from '../../core/types.js';
import { EVENTS_SERVICE, type EventsService } from '../../core/services.js';
import { errMessage } from '../../util/text.js';
import { formatUntil, formatWhen, parseWhen } from './when.js';

export const manifest: CogManifest = {
  name: 'events',
  version: '1.0.0',
  description: 'Event reminders (!event, !going) and rotating announcements (!announce), posted in the bot\'s channel',
};

/** How often the clock is checked. */
const TICK_MS = 20_000;
/** An event whose start was missed by more than this (the bot was down) is not announced late. */
const LATE_MS = 30 * 60_000;
const MAX_TITLE = 100;

interface Person {
  uid: string;
  name: string;
}

interface Ev {
  id: number;
  title: string;
  /** Start time, ms since 1970. */
  at: number;
  weekly: boolean;
  by: Person;
  going: Person[];
  reminded: boolean;
}

interface AnnounceSettings {
  enabled: boolean;
  everyMinutes: number;
  messages: string[];
  /** Which message is next. */
  next: number;
  /** When the last one was posted. */
  lastAt: number;
}

export function createEventsCog(bot: BotApi): Cog {
  const cfg = bot.config.events;
  const p = bot.config.prefix;
  const log = bot.log.child('events');
  const adapter = bot.adapter;

  let enabled = bot.state.get<boolean>('events.enabled', cfg.enabled);
  let list = bot.state.get<Ev[]>('events.list', []);
  let nextId = bot.state.get<number>('events.nextId', 1);
  let ann = bot.state.get<AnnounceSettings>('announce.settings', {
    enabled: bot.config.announcements.enabled,
    everyMinutes: bot.config.announcements.everyMinutes,
    messages: bot.config.announcements.messages,
    next: 0,
    lastAt: 0,
  });

  let timer: NodeJS.Timeout | undefined;
  let ticking = false;
  let unprovide: (() => void) | undefined;

  const saveEvents = (): void => {
    bot.state.set('events.list', list);
    bot.state.set('events.nextId', nextId);
  };
  const saveAnn = (): void => bot.state.set('announce.settings', ann);

  /** Post in the bot's channel, or the server-wide chat (which the TeamSpeak 6 client has nowhere to show). */
  const post = async (where: 'channel' | 'server', text: string): Promise<void> => {
    if (where === 'server') {
      try {
        return await adapter.sendServer(text);
      } catch (e) {
        log.debug(`server chat failed (${errMessage(e)}), using the channel instead`);
      }
    }
    await adapter.sendChannel(text).catch((e) => log.warn(`could not post: ${errMessage(e)}`));
  };
  const tellGoing = async (e: Ev, text: string): Promise<void> => {
    const online = adapter.users();
    for (const g of e.going) {
      const u = online.find((o) => o.uid === g.uid);
      if (u) await adapter.sendPrivate(u.id, text).catch((err) => log.debug(`could not message ${u.name}: ${errMessage(err)}`));
    }
  };

  const upcoming = (): Ev[] => [...list].sort((a, b) => a.at - b.at);
  const find = (arg: string | undefined): Ev | undefined => {
    const n = Number((arg ?? '').replace(/^#/, ''));
    return list.find((e) => e.id === n);
  };
  /** The event a !going is about: the number given, or the only one there is. */
  const pick = (ctx: CommandContext): Ev | string => {
    if (ctx.args[0]) return find(ctx.args[0]) ?? `There is no event #${ctx.args[0].replace(/^#/, '')}. See ${p}events.`;
    if (list.length === 1) return list[0]!;
    if (!list.length) return 'There are no events coming up.';
    return `Which one? Add its number: ${p}${ctx.name} 2 (see ${p}events).`;
  };
  const line = (e: Ev, now = Date.now()): string =>
    `#${e.id} ${e.title}: ${formatWhen(new Date(e.at))} (${formatUntil(e.at - now)})${e.weekly ? ', weekly' : ''}${e.going.length ? `, ${e.going.length} going` : ''}`;

  // ---- the clock ------------------------------------------------------------------------------------------

  async function tick(): Promise<void> {
    if (ticking || !adapter.connected) return;
    ticking = true;
    try {
      const now = Date.now();
      let changed = false;
      if (enabled) {
        for (const e of [...list]) {
          const remindAt = e.at - cfg.remindMinutes * 60_000;
          if (!e.reminded && cfg.remindMinutes > 0 && now >= remindAt && now < e.at) {
            e.reminded = true;
            changed = true;
            const when = `${formatUntil(e.at - now)} (${formatWhen(new Date(e.at))})`;
            await post(cfg.postTo, `Reminder: ${e.title} starts ${when}. Send me ${p}going ${e.id} to get a poke when it starts.`);
            // the people going hear it wherever they are
            await tellGoing(e, `Reminder: ${e.title} starts ${when}. You said you're going.`);
          }
          if (now >= e.at) {
            if (now - e.at < LATE_MS) {
              await post(cfg.postTo, `Starting now: ${e.title}!`);
              if (cfg.pokeGoing) {
                const online = adapter.users();
                for (const g of e.going) {
                  const u = online.find((o) => o.uid === g.uid);
                  if (u) await adapter.poke(u.id, `${e.title} is starting now!`).catch((err) => log.debug(`could not poke ${u.name}: ${errMessage(err)}`));
                }
              }
              log.info(`event #${e.id} "${e.title}" started (${e.going.length} going)`);
            } else {
              log.info(`event #${e.id} "${e.title}" was missed while the bot was away; not announced late`);
            }
            if (e.weekly) {
              while (e.at <= now) e.at += 7 * 86_400_000;
              e.reminded = false;
              e.going = [];
            } else {
              list = list.filter((x) => x !== e);
            }
            changed = true;
          }
        }
      }
      if (changed) saveEvents();

      if (ann.enabled && ann.messages.length && adapter.users().length > 0 && now - ann.lastAt >= ann.everyMinutes * 60_000) {
        const msg = ann.messages[ann.next % ann.messages.length]!;
        ann.next = (ann.next + 1) % ann.messages.length;
        ann.lastAt = now;
        saveAnn();
        await post(bot.config.announcements.postTo, msg);
      }
    } finally {
      ticking = false;
    }
  }

  // ---- commands ---------------------------------------------------------------------------------------------

  const canAdd = (ctx: CommandContext): boolean => ctx.isAdmin || cfg.whoCanAdd === 'everyone';

  const cog: Cog = {
    commands: [
      {
        name: 'event',
        aliases: ['events'],
        description: `Events: ${p}events lists them, ${p}event add <when> | <title>, ${p}event <number>, ${p}event remove <number>`,
        usage: `${p}event [add <when> | <title>|<number>|remove <number>|on|off]`,
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub || sub === 'list') {
            if (!enabled) return ctx.reply('Events are switched off.');
            if (!list.length) return ctx.reply(`No events coming up.${canAdd(ctx) ? ` Add one: ${p}event add Friday 8pm | Nuke run` : ''}`);
            return ctx.reply(`Coming up:\n${upcoming().map((e) => line(e)).join('\n')}\n${p}going <number> gets you a poke when it starts.`);
          }
          if (sub === 'on' || sub === 'off') {
            if (!ctx.isAdmin) return ctx.reply('Only bot admins can switch events on or off.');
            enabled = sub === 'on';
            bot.state.set('events.enabled', enabled);
            return ctx.reply(`Events are ${sub}.`);
          }
          if (sub === 'add') {
            if (!canAdd(ctx)) return ctx.reply('Only bot admins can add events.');
            const body = ctx.rest.slice('add'.length);
            const bar = body.indexOf('|');
            if (bar < 0) return ctx.reply(`Usage: ${p}event add <when> | <title>, like: ${p}event add Friday 8pm | Nuke run (or "weekly Friday 8pm", "tomorrow 7:30pm", "in 2h")`);
            const title = body.slice(bar + 1).trim();
            if (!title || title.length > MAX_TITLE) return ctx.reply(`Give the event a title after the "|", up to ${MAX_TITLE} characters.`);
            const w = parseWhen(body.slice(0, bar));
            if (typeof w === 'string') return ctx.reply(w);
            if (list.length >= cfg.maxEvents) return ctx.reply(`That's the most events I keep (${cfg.maxEvents}). Remove one first.`);
            const e: Ev = { id: nextId++, title, at: w.at.getTime(), weekly: w.weekly, by: { uid: ctx.msg.senderUid, name: ctx.msg.senderName }, going: [], reminded: false };
            list.push(e);
            saveEvents();
            return ctx.reply(
              `Added #${e.id}: ${e.title}, ${formatWhen(w.at)} (${formatUntil(e.at - Date.now())})${e.weekly ? ', every week' : ''}.` +
                `${cfg.remindMinutes ? ` I'll post a reminder ${cfg.remindMinutes} min before.` : ''} People can send ${p}going ${e.id}.${enabled ? '' : ` (Events are off: ${p}event on.)`}`,
            );
          }
          if (sub === 'remove' || sub === 'delete' || sub === 'cancel') {
            const e = find(ctx.args[1]);
            if (!e) return ctx.reply(`Give the event's number: ${p}event remove 2`);
            if (!ctx.isAdmin && e.by.uid !== ctx.msg.senderUid) return ctx.reply('Only the person who added it, or a bot admin, can remove it.');
            list = list.filter((x) => x !== e);
            saveEvents();
            return ctx.reply(`Removed #${e.id}: ${e.title}.`);
          }
          const e = find(sub);
          if (!e) return ctx.reply(`Usage: ${p}events, ${p}event <number>, ${p}event add <when> | <title>, ${p}event remove <number>`);
          return ctx.reply(`${line(e)}\nAdded by ${e.by.name}.${e.going.length ? ` Going: ${e.going.map((g) => g.name).join(', ')}.` : ` Nobody has said ${p}going ${e.id} yet.`}`);
        },
      },
      {
        name: 'going',
        description: `Say you're going to an event, to get a poke when it starts: ${p}going [number]`,
        usage: `${p}going [number]`,
        run: async (ctx) => {
          if (!enabled) return ctx.reply('Events are switched off.');
          const e = pick(ctx);
          if (typeof e === 'string') return ctx.reply(e);
          if (e.going.some((g) => g.uid === ctx.msg.senderUid)) return ctx.reply(`You're already down for ${e.title}.`);
          e.going.push({ uid: ctx.msg.senderUid, name: ctx.msg.senderName });
          saveEvents();
          return ctx.reply(`You're going to ${e.title} (${formatWhen(new Date(e.at))}).${cfg.pokeGoing ? " I'll poke you when it starts, if you're online." : ''} (${p}notgoing ${e.id} to change your mind.)`);
        },
      },
      {
        name: 'notgoing',
        description: `Take back a ${p}going: ${p}notgoing [number]`,
        usage: `${p}notgoing [number]`,
        run: async (ctx) => {
          const e = pick(ctx);
          if (typeof e === 'string') return ctx.reply(e);
          const before = e.going.length;
          e.going = e.going.filter((g) => g.uid !== ctx.msg.senderUid);
          if (e.going.length === before) return ctx.reply(`You weren't down for ${e.title}.`);
          saveEvents();
          return ctx.reply(`OK, you're off the list for ${e.title}.`);
        },
      },
      {
        name: 'announce',
        aliases: ['announcements'],
        description: `Rotating announcements in my channel: ${p}announce [on|off|add <text>|remove <n>|every <minutes>|now] (bot admins only)`,
        usage: `${p}announce [on|off|add <text>|remove <n>|every <5-1440>|now]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub || sub === 'list' || sub === 'status') {
            return ctx.reply(
              [
                `Announcements are ${ann.enabled ? `on: one every ${ann.everyMinutes} minutes, in turn, in ${bot.config.announcements.postTo === 'server' ? 'the server chat' : "my channel"}, when someone is online` : 'off'}.`,
                ann.messages.length ? ann.messages.map((m, i) => `${i + 1}. ${m}`).join('\n') : `No messages yet. Add one: ${p}announce add Check out our website: https://example.com`,
              ].join('\n'),
            );
          }
          if (sub === 'on') {
            if (!ann.messages.length) return ctx.reply(`Add a message first: ${p}announce add <text>`);
            ann = { ...ann, enabled: true, lastAt: Date.now() };
            saveAnn();
            return ctx.reply(`Announcements are on: the first one goes out in ${ann.everyMinutes} minutes (${p}announce now posts one straight away).`);
          }
          if (sub === 'off') {
            ann = { ...ann, enabled: false };
            saveAnn();
            return ctx.reply('Announcements are off.');
          }
          if (sub === 'add') {
            const text = ctx.rest.slice('add'.length).trim();
            if (!text || text.length > 500) return ctx.reply('Give the message, up to 500 characters.');
            if (ann.messages.length >= 50) return ctx.reply("That's the most messages I keep (50).");
            ann = { ...ann, messages: [...ann.messages, text] };
            saveAnn();
            return ctx.reply(`Added as message ${ann.messages.length}.${ann.enabled ? '' : ` Announcements are off: ${p}announce on.`}`);
          }
          if (sub === 'remove') {
            const n = Number(ctx.args[1]);
            if (!Number.isInteger(n) || n < 1 || n > ann.messages.length) return ctx.reply(`Give the number from ${p}announce, like: ${p}announce remove 1`);
            ann = { ...ann, messages: ann.messages.filter((_, i) => i !== n - 1), next: 0 };
            saveAnn();
            return ctx.reply(`Removed message ${n}.`);
          }
          if (sub === 'every') {
            const n = Number(ctx.args[1]);
            if (!Number.isFinite(n) || n < 5 || n > 1440) return ctx.reply(`Give the minutes between messages, from 5 to 1440: ${p}announce every 60`);
            ann = { ...ann, everyMinutes: Math.round(n) };
            saveAnn();
            return ctx.reply(`One message every ${Math.round(n)} minutes.`);
          }
          if (sub === 'now') {
            if (!ann.messages.length) return ctx.reply('There are no messages.');
            const msg = ann.messages[ann.next % ann.messages.length]!;
            ann = { ...ann, next: (ann.next + 1) % ann.messages.length, lastAt: Date.now() };
            saveAnn();
            await post(bot.config.announcements.postTo, msg);
            return ctx.reply('Posted.');
          }
          return ctx.reply(`Usage: ${p}announce [on|off|add <text>|remove <n>|every <5-1440>|now]`);
        },
      },
    ],

    onLoad() {
      timer = setInterval(() => void tick(), TICK_MS);
      timer.unref?.();
      unprovide = bot.services.provide<EventsService>(EVENTS_SERVICE, {
        upcoming: () => upcoming().map((e) => ({ id: e.id, title: e.title, at: e.at, weekly: e.weekly, going: e.going.map((g) => g.name) })),
        check: tick,
      });
    },

    onUnload() {
      if (timer) clearInterval(timer);
      unprovide?.();
    },

    status: () => `Events ${enabled ? `on (${list.length} coming up)` : 'off'} | announcements ${ann.enabled ? `on (${ann.messages.length}, every ${ann.everyMinutes} min)` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createEventsCog(bot);
export default factory;
