import type { TsChannel, TsUser } from '../../adapter/types.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage, formatAgo } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'rooms',
  version: '1.0.0',
  description: 'Temporary channels: join "Create a Room" and get a private channel of your own; or always keep one empty channel free',
};

/** TeamSpeak refuses channel names longer than this. */
const MAX_NAME = 40;
/** Don't tell the same person "please wait" more often than this. */
const NAG_MS = 15_000;
/** Forget rooms the server has deleted, and room records older than this even if something went wrong. */
const RECORD_KEEP_MS = 7 * 86_400_000;
/** An extra empty spare channel is removed once it has been empty this long (so people moving about don't make channels come and go). */
export const SPARE_GRACE_MS = 30_000;
/** How often the spare channels are looked at, besides whenever someone moves. */
const SPARE_TICK_MS = 10_000;
/** After failing to make or remove a spare channel, wait this long before trying again. */
const SPARE_RETRY_MS = 60_000;

/** "Always one empty channel": numbered public channels under one parent, with exactly one of them empty. */
interface SpareSettings {
  enabled: boolean;
  /** "#<id>" of the channel they go under. */
  parent: string;
  /** Name with {n}, like "Squad {n}". */
  template: string;
  max: number;
}

/** What to do with the spare channels: make one numbered `make`, and/or remove `remove` (channel numbers as text). */
export function planSpares(
  spares: { id: string; n: number; occupied: boolean; emptySince?: number }[],
  opts: { max: number; now: number; graceMs?: number },
): { make?: number; remove: string[] } {
  const grace = opts.graceMs ?? SPARE_GRACE_MS;
  const empty = spares.filter((x) => !x.occupied).sort((a, b) => a.n - b.n);
  const out: { make?: number; remove: string[] } = { remove: [] };
  if (!empty.length) {
    if (spares.length < opts.max) {
      const used = new Set(spares.map((x) => x.n));
      let n = 1;
      while (used.has(n)) n++;
      out.make = n;
    }
    return out;
  }
  // keep the lowest-numbered empty one, remove the rest once they have been empty a while
  for (const x of empty.slice(1)) if (x.emptySince !== undefined && opts.now - x.emptySince >= grace) out.remove.push(x.id);
  return out;
}

interface RoomSettings {
  enabled: boolean;
  creatorChannel: string;
  parentChannel: string;
  nameTemplate: string;
}

/** A room the bot made, kept by channel number (as text). */
interface Room {
  uid: string;
  name: string;
  at: number;
}

/** The room's name for this person, cut to fit TeamSpeak's 40 characters (only the nickname part shrinks). */
export function roomName(template: string, nickname: string): string {
  const fill = (n: string): string => template.replace(/\{name\}/gi, n).replace(/[\r\n\t]+/g, ' ').trim();
  let out = fill(nickname);
  if (out.length > MAX_NAME) {
    const room = MAX_NAME - fill('').length;
    out = fill(nickname.slice(0, Math.max(1, room)).trimEnd());
  }
  return out.slice(0, MAX_NAME) || 'Room';
}

/** `name`, or "name (2)", "name (3)"... whichever is not taken among `taken` (compared ignoring case). */
export function uniqueName(name: string, taken: string[]): string {
  const used = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!used.has(name.toLowerCase())) return name;
  for (let i = 2; i < 100; i++) {
    const suffix = ` (${i})`;
    const cand = `${name.slice(0, MAX_NAME - suffix.length).trimEnd()}${suffix}`;
    if (!used.has(cand.toLowerCase())) return cand;
  }
  return `${name.slice(0, MAX_NAME - 8)} ${Date.now() % 100_000}`;
}

export function createRoomsCog(bot: BotApi): Cog {
  const cfg = bot.config.rooms;
  const p = bot.config.prefix;
  const log = bot.log.child('rooms');
  const adapter = bot.adapter;

  let settings = bot.state.get<RoomSettings>('rooms.settings', {
    enabled: cfg.enabled,
    creatorChannel: cfg.creatorChannel,
    parentChannel: cfg.parentChannel,
    nameTemplate: cfg.nameTemplate,
  });

  const busy = new Set<string>();
  const lastMade = new Map<string, number>();
  const lastNag = new Map<string, number>();
  let spare = bot.state.get<SpareSettings>('rooms.spare', { enabled: false, parent: '', template: 'Room {n}', max: 10 });
  /** Spare channels the bot made: channel number (as text) -> its number in the name. */
  const spareIds = (): Record<string, number> => bot.state.get<Record<string, number>>('rooms.spareIds', {});
  const emptySince = new Map<string, number>();
  /** Spare channels made in the last moments, which the client list may not show yet (not to be forgotten as "gone"). */
  const justMade = new Map<string, number>();
  let spareBusy = false;
  let spareFailedAt = 0;
  let spareError = '';
  let spareTimer: NodeJS.Timeout | undefined;
  let warnedMissing = '';
  let warnedGroup = '';
  let offDirectory: (() => void) | undefined;

  const channelById = (id: bigint): TsChannel | undefined => adapter.channels().find((c) => c.id === id);
  const resolveChannel = (text: string): TsChannel | undefined => {
    const t = text.trim();
    if (!t) return undefined;
    const byId = /^#(\d+)$/.exec(t);
    return byId ? channelById(BigInt(byId[1]!)) : adapter.findChannel(t);
  };
  const tell = (u: { id: number; name: string }, text: string): void => {
    adapter.sendPrivate(u.id, text).catch((e) => log.debug(`could not message ${u.name}: ${errMessage(e)}`));
  };

  // ---- the rooms the bot made -------------------------------------------------------------------

  /** Rooms that still exist (the server deletes empty ones by itself, so the list is tidied as it is read). */
  function rooms(): Record<string, Room> {
    const all = bot.state.get<Record<string, Room>>('rooms.owned', {});
    const now = Date.now();
    const alive = Object.fromEntries(Object.entries(all).filter(([id, r]) => channelById(BigInt(id)) && now - r.at < RECORD_KEEP_MS));
    if (Object.keys(alive).length !== Object.keys(all).length) bot.state.set('rooms.owned', alive);
    return alive;
  }
  const saveRooms = (r: Record<string, Room>): void => bot.state.set('rooms.owned', r);
  const roomOf = (uid: string): TsChannel | undefined => {
    const hit = Object.entries(rooms()).find(([, r]) => r.uid === uid);
    return hit ? channelById(BigInt(hit[0])) : undefined;
  };

  // ---- making a room --------------------------------------------------------------------------------

  async function giveRoom(u: TsUser, creator: TsChannel): Promise<void> {
    // someone who already has a room goes back to it
    const own = roomOf(u.uid);
    if (own) {
      try {
        await adapter.moveUser(u.id, own.id);
        tell(u, `You already have a room, "${own.name}". I moved you back to it.`);
      } catch (e) {
        log.warn(`could not move ${u.name} to their room "${own.name}": ${errMessage(e)}`);
      }
      return;
    }

    const now = Date.now();
    const made = lastMade.get(u.uid);
    if (made !== undefined && now - made < cfg.cooldownSeconds * 1000) {
      if (now - (lastNag.get(u.uid) ?? 0) > NAG_MS) {
        lastNag.set(u.uid, now);
        tell(u, `You made a room a moment ago. Please wait ${Math.ceil((cfg.cooldownSeconds * 1000 - (now - made)) / 1000)} seconds before making another.`);
      }
      return;
    }
    const current = rooms();
    if (Object.keys(current).length >= cfg.maxRooms) {
      if (now - (lastNag.get(u.uid) ?? 0) > NAG_MS) {
        lastNag.set(u.uid, now);
        tell(u, `There are already ${cfg.maxRooms} rooms, the most allowed. Try again when one has closed.`);
      }
      return;
    }

    let parent = creator;
    if (settings.parentChannel) {
      const want = resolveChannel(settings.parentChannel);
      if (want) parent = want;
      else if (warnedMissing !== `parent:${settings.parentChannel}`) {
        warnedMissing = `parent:${settings.parentChannel}`;
        log.warn(`rooms: there is no channel "${settings.parentChannel}" to put rooms under; using "${creator.name}" instead`);
      }
    }
    const siblings = adapter.channels().filter((c) => c.parentId === parent.id).map((c) => c.name);
    const name = uniqueName(roomName(settings.nameTemplate, u.name), siblings);

    const botWas = adapter.selfChannelId();
    lastMade.set(u.uid, now);
    let id: bigint;
    try {
      id = await adapter.createTempChannel({ name, parentId: parent.id, deleteDelaySec: cfg.deleteDelaySeconds });
    } catch (e) {
      const why = errMessage(e);
      log.warn(`could not create a room for ${u.name}: ${why}`);
      tell(u, `Sorry, I couldn't make you a room (${why}).`);
      return;
    }
    saveRooms({ ...rooms(), [String(id)]: { uid: u.uid, name: u.name, at: now } });

    let moved = true;
    try {
      await adapter.moveUser(u.id, id);
    } catch (e) {
      moved = false;
      log.warn(`made "${name}" but could not move ${u.name} into it: ${errMessage(e)}`);
    }

    let isAdmin = false;
    if (cfg.ownerChannelGroup > 0) {
      try {
        await adapter.setChannelGroup(u.id, id, cfg.ownerChannelGroup);
        isAdmin = true;
      } catch (e) {
        const why = errMessage(e);
        if (warnedGroup !== why) log.warn(`could not make ${u.name} channel group ${cfg.ownerChannelGroup} in their room: ${why}`);
        warnedGroup = why;
      }
    }

    // Some servers move whoever creates a channel into it. Put the bot back where it was (after the
    // owner is in, so the room is never empty and starts counting down to being deleted).
    if (botWas !== 0n && adapter.selfChannelId() !== botWas) {
      const home = bot.config.server.homeChannel ? adapter.findChannel(bot.config.server.homeChannel) : undefined;
      const pw = home && home.id === botWas ? bot.config.server.homeChannelPassword : '';
      try {
        await adapter.moveSelf(botWas, pw);
      } catch (e) {
        log.warn(`the server moved me into "${name}" and I could not go back: ${errMessage(e)}`);
      }
    }

    log.info(`made room "${name}" for ${u.name}`);
    if (moved) {
      tell(
        u,
        `Here's your room, "${name}". It closes by itself once everyone has left.` +
          (isAdmin ? ' You are its channel admin, so you can rename it, set a password or change who can talk.' : ''),
      );
    }
  }

  function onDirectory(): void {
    if (!settings.enabled || !adapter.connected) return;
    const creator = resolveChannel(settings.creatorChannel);
    if (!creator) {
      if (warnedMissing !== settings.creatorChannel) log.warn(`rooms: there is no channel called "${settings.creatorChannel}"`);
      warnedMissing = settings.creatorChannel;
      return;
    }
    for (const u of adapter.usersInChannel(creator.id)) {
      if (busy.has(u.uid)) continue;
      busy.add(u.uid);
      giveRoom(u, creator)
        .catch((e) => log.error(`making a room for ${u.name} failed`, e))
        .finally(() => busy.delete(u.uid));
    }
    if (lastMade.size > 500) for (const [k, t] of lastMade) if (Date.now() - t > cfg.cooldownSeconds * 1000) lastMade.delete(k);
  }

  // ---- always one empty channel ---------------------------------------------------------------------

  const spareName = (n: number): string => spare.template.replace(/\{n\}/gi, String(n)).slice(0, MAX_NAME);

  /** Put the bot back if the server moved it into a channel it just made. */
  async function returnBot(botWas: bigint, name: string): Promise<void> {
    if (botWas === 0n || adapter.selfChannelId() === botWas) return;
    const home = bot.config.server.homeChannel ? adapter.findChannel(bot.config.server.homeChannel) : undefined;
    const pw = home && home.id === botWas ? bot.config.server.homeChannelPassword : '';
    try {
      await adapter.moveSelf(botWas, pw);
    } catch (e) {
      log.warn(`the server moved me into "${name}" and I could not go back: ${errMessage(e)}`);
    }
  }

  async function spareTick(): Promise<void> {
    if (spareBusy || !adapter.connected) return;
    const ids = spareIds();
    if (!spare.enabled && !Object.keys(ids).length) return;
    const now = Date.now();
    if (now - spareFailedAt < SPARE_RETRY_MS) return;
    spareBusy = true;
    try {
      // forget channels that are gone (deleted in TeamSpeak)
      for (const [id, t] of justMade) if (now - t > 15_000) justMade.delete(id);
      const alive = Object.fromEntries(Object.entries(ids).filter(([id]) => channelById(BigInt(id)) || justMade.has(id)));
      if (Object.keys(alive).length !== Object.keys(ids).length) bot.state.set('rooms.spareIds', alive);
      const occupied = new Set(adapter.users().map((u) => String(u.channelId)));
      if (adapter.selfChannelId() !== 0n) occupied.add(String(adapter.selfChannelId()));
      const list = Object.entries(alive).map(([id, n]) => {
        const busy = occupied.has(id) || adapter.channels().some((c) => String(c.parentId) === id);
        if (busy) emptySince.delete(id);
        else if (!emptySince.has(id)) emptySince.set(id, now);
        return { id, n, occupied: busy, emptySince: emptySince.get(id) };
      });

      // switched off: tidy up every empty spare, and forget the ones in use
      if (!spare.enabled) {
        const keep: Record<string, number> = {};
        for (const x of list) {
          if (x.occupied) {
            keep[x.id] = x.n; // removed once it empties
            continue;
          }
          try {
            await adapter.deleteChannel(BigInt(x.id));
            log.info(`removed spare channel "${channelById(BigInt(x.id))?.name ?? x.id}" (spare channels are off)`);
          } catch (e) {
            log.warn(`could not remove spare channel #${x.id}: ${errMessage(e)}`);
            keep[x.id] = x.n;
          }
        }
        bot.state.set('rooms.spareIds', keep);
        return;
      }

      const parent = resolveChannel(spare.parent);
      if (!parent) {
        if (warnedMissing !== `spare:${spare.parent}`) log.warn(`spare channels: there is no channel ${spare.parent} to put them under`);
        warnedMissing = `spare:${spare.parent}`;
        return;
      }
      const plan = planSpares(list, { max: spare.max, now });
      for (const id of plan.remove) {
        try {
          await adapter.deleteChannel(BigInt(id));
          const rest = { ...spareIds() };
          delete rest[id];
          bot.state.set('rooms.spareIds', rest);
          emptySince.delete(id);
          log.info(`removed extra empty channel #${id}`);
        } catch (e) {
          spareFailedAt = now;
          spareError = errMessage(e);
          log.warn(`could not remove extra empty channel #${id}: ${spareError}`);
        }
      }
      if (plan.make !== undefined) {
        const siblings = adapter.channels().filter((c) => c.parentId === parent.id).map((c) => c.name);
        const name = uniqueName(spareName(plan.make), siblings);
        const botWas = adapter.selfChannelId();
        try {
          const id = await adapter.createPermanentChannel({ name, parentId: parent.id });
          bot.state.set('rooms.spareIds', { ...spareIds(), [String(id)]: plan.make });
          justMade.set(String(id), now);
          emptySince.set(String(id), now);
          spareError = '';
          log.info(`made spare channel "${name}"`);
          await returnBot(botWas, name);
        } catch (e) {
          spareFailedAt = now;
          spareError = errMessage(e);
          log.warn(`could not make spare channel "${name}": ${spareError}`);
        }
      }
    } finally {
      spareBusy = false;
    }
  }

  function spareStatus(): string {
    const parent = spare.parent ? resolveChannel(spare.parent) : undefined;
    const list = Object.entries(spareIds())
      .map(([id, n]) => ({ ch: channelById(BigInt(id)), n, people: adapter.usersInChannel(BigInt(id)).length }))
      .filter((x) => x.ch)
      .sort((a, b) => a.n - b.n);
    return [
      `Always one empty channel is ${spare.enabled ? 'on' : 'off'}.`,
      spare.parent ? `Channels go under "${parent ? parent.name : spare.parent}"${parent ? '' : ' (I cannot find this channel!)'}, named like "${spareName(1)}", at most ${spare.max}.` : `Pick where they go first: ${p}rooms spare under <channel>`,
      list.length ? `Now: ${list.map((x) => `"${x.ch!.name}" (${x.people ? `${x.people} in it` : 'empty'})`).join(', ')}` : '',
      spareError ? `The last try failed: ${spareError}. My server group needs permission to create and delete permanent channels there.` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  async function spareCommand(ctx: Parameters<Cog['commands'][number]['run']>[0]): Promise<void> {
    const sub = ctx.args[1]?.toLowerCase();
    const after = (word: string): string => ctx.rest.trim().slice('spare'.length).trim().slice(word.length).trim();
    const saveSpare = (next: SpareSettings): void => {
      spare = next;
      bot.state.set('rooms.spare', next);
    };
    if (!sub || sub === 'status') return ctx.reply(spareStatus());
    if (sub === 'under') {
      const want = after('under');
      const ch = resolveChannel(want);
      if (!ch) return ctx.reply(`I cannot find a channel called "${want}".`);
      if (Object.keys(spareIds()).length) return ctx.reply(`Switch it off first (${p}rooms spare off) so the channels already made are tidied away, then move it.`);
      saveSpare({ ...spare, parent: `#${ch.id}` });
      return ctx.reply(`Spare channels go under "${ch.name}".${spare.enabled ? '' : ` ${p}rooms spare on starts it.`}`);
    }
    if (sub === 'name') {
      const t = after('name');
      if (!/\{n\}/i.test(t) || t.length > MAX_NAME) return ctx.reply(`Give the name with {n} for the number, up to ${MAX_NAME} characters: ${p}rooms spare name Squad {n}`);
      saveSpare({ ...spare, template: t });
      return ctx.reply(`New spare channels will be named like "${t.replace(/\{n\}/gi, '1')}" (ones already made keep their names).`);
    }
    if (sub === 'max') {
      const n = Number(ctx.args[2]);
      if (!Number.isInteger(n) || n < 1 || n > 50) return ctx.reply(`Give a number from 1 to 50: ${p}rooms spare max 10`);
      saveSpare({ ...spare, max: n });
      return ctx.reply(`At most ${n} spare channels.`);
    }
    if (sub === 'on') {
      if (!spare.parent || !resolveChannel(spare.parent)) return ctx.reply(`Pick where they go first: ${p}rooms spare under <channel>`);
      saveSpare({ ...spare, enabled: true });
      spareFailedAt = 0;
      await spareTick();
      return ctx.reply(`Always one empty channel is on. When someone joins the empty one, I make another; extra empty ones are removed after ${SPARE_GRACE_MS / 1000} seconds.\n${spareStatus().split('\n').slice(1).join('\n')}`);
    }
    if (sub === 'off') {
      saveSpare({ ...spare, enabled: false });
      spareFailedAt = 0;
      await spareTick();
      return ctx.reply(`Always one empty channel is off. I removed the empty spare channels; ones with people in them go when they empty.`);
    }
    return ctx.reply(`Usage: ${p}rooms spare [on|off|under <channel>|name <template with {n}>|max <n>]`);
  }

  // ---- settings -----------------------------------------------------------------------------------------

  const save = (next: RoomSettings): void => {
    settings = next;
    bot.state.set('rooms.settings', next);
  };

  function statusText(): string {
    const creator = resolveChannel(settings.creatorChannel);
    const parent = settings.parentChannel ? resolveChannel(settings.parentChannel) : undefined;
    const list = Object.entries(rooms());
    return [
      `Rooms are ${settings.enabled ? 'on' : 'off'}.`,
      `Join "${creator ? creator.name : settings.creatorChannel}"${creator ? '' : ' (I cannot find this channel!)'} to get a room.`,
      `Rooms are made ${settings.parentChannel ? `under "${parent ? parent.name : settings.parentChannel}"${parent ? '' : ' (I cannot find this channel, so under the join channel for now)'}` : 'as sub-channels of that channel'}, named like "${roomName(settings.nameTemplate, 'Ann')}", and close ${cfg.deleteDelaySeconds} seconds after they are empty.`,
      list.length ? `Open now (${list.length}): ${list.map(([id, r]) => `"${channelById(BigInt(id))?.name ?? id}" (${r.name}, ${formatAgo(r.at)})`).join(', ')}` : 'No rooms are open.',
    ].join('\n');
  }

  const cog: Cog = {
    commands: [
      {
        name: 'room',
        aliases: ['myroom'],
        description: 'Go to your own room, if you have one',
        run: async (ctx) => {
          const own = roomOf(ctx.msg.senderUid);
          if (!own) {
            const creator = resolveChannel(settings.creatorChannel);
            return ctx.reply(settings.enabled && creator ? `You don't have a room. Join "${creator.name}" and I'll make you one.` : 'Rooms are not switched on here.');
          }
          try {
            await adapter.moveUser(ctx.msg.senderId, own.id);
            return ctx.reply(`Moved you to your room, "${own.name}".`);
          } catch (e) {
            return ctx.reply(`Your room is "${own.name}", but I could not move you there (${errMessage(e)}).`);
          }
        },
      },
      {
        name: 'rooms',
        description: `Temporary rooms: ${p}rooms [on|off|channel <name>|under <channel>|name <template>]; always one empty channel: ${p}rooms spare [on|off|under|name|max] (bot admins only)`,
        usage: `${p}rooms [on|off|channel <channel>|under <channel or "none">|name <template>|spare ...]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub || sub === 'status' || sub === 'list') return ctx.reply(statusText());
          if (sub === 'spare') return spareCommand(ctx);
          if (sub === 'on') {
            const creator = resolveChannel(settings.creatorChannel);
            if (!creator) return ctx.reply(`I cannot find a channel called "${settings.creatorChannel}". Make one, or pick another with ${p}rooms channel <name>.`);
            save({ ...settings, enabled: true });
            onDirectory();
            return ctx.reply(`Rooms are on. Anyone who joins "${creator.name}" gets a room of their own.`);
          }
          if (sub === 'off') {
            save({ ...settings, enabled: false });
            return ctx.reply('Rooms are off. Rooms already open stay until they are empty.');
          }
          if (sub === 'channel') {
            const want = ctx.rest.slice('channel'.length).trim();
            const ch = resolveChannel(want);
            if (!ch) return ctx.reply(`I cannot find a channel called "${want}".`);
            save({ ...settings, creatorChannel: `#${ch.id}` });
            return ctx.reply(`People join "${ch.name}" to get a room.`);
          }
          if (sub === 'under') {
            const want = ctx.rest.slice('under'.length).trim();
            if (!want || want.toLowerCase() === 'none') {
              save({ ...settings, parentChannel: '' });
              return ctx.reply('Rooms will be made as sub-channels of the join channel.');
            }
            const ch = resolveChannel(want);
            if (!ch) return ctx.reply(`I cannot find a channel called "${want}".`);
            save({ ...settings, parentChannel: `#${ch.id}` });
            return ctx.reply(`Rooms will be made under "${ch.name}".`);
          }
          if (sub === 'name') {
            const t = ctx.rest.slice('name'.length).trim();
            if (!t || t.length > MAX_NAME) return ctx.reply(`Give the room name, up to ${MAX_NAME} characters; {name} becomes the person's nickname: ${p}rooms name {name}'s Room`);
            save({ ...settings, nameTemplate: t });
            return ctx.reply(`New rooms will be named like "${roomName(t, ctx.msg.senderName)}".`);
          }
          return ctx.reply(`Usage: ${p}rooms [on|off|channel <channel>|under <channel or "none">|name <template>]`);
        },
      },
    ],

    onLoad() {
      offDirectory = adapter.events.on('directory', () => {
        onDirectory();
        void spareTick();
      });
      spareTimer = setInterval(() => void spareTick(), SPARE_TICK_MS);
      spareTimer.unref?.();
      // someone may already be waiting in the join channel
      if (adapter.connected) onDirectory();
    },

    onUnload() {
      offDirectory?.();
      if (spareTimer) clearInterval(spareTimer);
    },

    status: () => `Rooms ${settings.enabled ? `on (${Object.keys(rooms()).length} open)` : 'off'} | always one empty ${spare.enabled ? `on (${Object.keys(spareIds()).length})` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createRoomsCog(bot);
export default factory;
