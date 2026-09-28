import type { TsChannel, TsUser } from '../../adapter/types.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage, formatAgo } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'rooms',
  version: '1.0.0',
  description: 'Temporary channels: join "Create a Room" and get a private channel of your own',
};

/** TeamSpeak refuses channel names longer than this. */
const MAX_NAME = 40;
/** Don't tell the same person "please wait" more often than this. */
const NAG_MS = 15_000;
/** Forget rooms the server has deleted, and room records older than this even if something went wrong. */
const RECORD_KEEP_MS = 7 * 86_400_000;

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
        description: `Temporary rooms: ${p}rooms [on|off|channel <name>|under <channel>|name <template>] (bot admins only)`,
        usage: `${p}rooms [on|off|channel <channel>|under <channel or "none">|name <template>]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub || sub === 'status' || sub === 'list') return ctx.reply(statusText());
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
      offDirectory = adapter.events.on('directory', onDirectory);
      // someone may already be waiting in the join channel
      if (adapter.connected) onDirectory();
    },

    onUnload() {
      offDirectory?.();
    },

    status: () => `Rooms ${settings.enabled ? `on (${Object.keys(rooms()).length} open)` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createRoomsCog(bot);
export default factory;
