import type { TsUser } from '../../adapter/types.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage } from '../../util/text.js';
import { uniqueName } from '../rooms/index.js';

export const manifest: CogManifest = {
  name: 'nickfilter',
  version: '1.0.0',
  description: 'Warns about blocked words in nicknames, then moves or kicks if they are not changed; renames or removes channels with blocked words',
};

/** How often to look again (for warnings whose time is up). */
const TICK_MS = 5_000;
const MAX_WORDS = 200;

type Action = 'warn' | 'move' | 'kick';

interface Settings {
  enabled: boolean;
  words: string[];
  action: Action;
  moveChannel: string;
}

/** Common letter swaps people use to get around a word filter. */
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '!': 'i', '|': 'i', '3': 'e', '4': 'a', '@': 'a', '5': 's', $: 's', '7': 't', '8': 'b', '9': 'g' };

/** A nickname in the forms the words are looked for in: lower case, and with swaps undone and everything else dropped. */
export function nameForms(name: string): string[] {
  const lower = name.toLowerCase();
  const squashed = [...lower].map((ch) => LEET[ch] ?? ch).filter((ch) => /\p{L}/u.test(ch)).join('');
  return [lower, squashed];
}

/** The first blocked word found in the nickname, or undefined. */
export function blockedWordIn(name: string, words: string[]): string | undefined {
  const forms = nameForms(name);
  for (const w of words) {
    const want = w.trim().toLowerCase();
    const wantSquashed = nameForms(want)[1]!;
    if (!want) continue;
    if (forms[0]!.includes(want) || (wantSquashed.length >= 2 && forms[1]!.includes(wantSquashed))) return w;
  }
  return undefined;
}

/**
 * The first blocked word in a channel name, or undefined. Channel names are checked as written and with
 * spaces and symbols taken out, but numbers are NOT read as letters (so "Room 455" is not "room ass").
 */
export function channelBlockedWord(name: string, words: string[]): string | undefined {
  const lower = name.toLowerCase().replace(/\[[a-z]*spacer[^\]]*\]/g, ' ');
  const letters = [...lower].filter((ch) => /\p{L}/u.test(ch)).join('');
  for (const w of words) {
    const want = w.trim().toLowerCase();
    if (!want) continue;
    const wantLetters = [...want].filter((ch) => /\p{L}/u.test(ch)).join('');
    if (lower.includes(want) || (wantLetters.length >= 2 && letters.includes(wantLetters))) return w;
  }
  return undefined;
}

type ChannelAction = 'rename' | 'delete';

interface ChannelSettings {
  enabled: boolean;
  /** "rename" always renames; "delete" removes the channel if it is empty (and renames it if not). */
  action: ChannelAction;
  /** What a bad channel is renamed to. */
  renameTo: string;
}

/** After failing to fix a channel, leave it alone this long. */
const CHANNEL_RETRY_MS = 5 * 60_000;

export function createNickfilterCog(bot: BotApi): Cog {
  const cfg = bot.config.nickfilter;
  const p = bot.config.prefix;
  const log = bot.log.child('nickfilter');
  const adapter = bot.adapter;

  let s = bot.state.get<Settings>('nickfilter.settings', { enabled: cfg.enabled, words: cfg.words, action: cfg.action, moveChannel: cfg.moveChannel });
  /** Warned people, by client number (a reconnect gets a fresh warning and a fresh wait). */
  const warned = new Map<number, { name: string; at: number; done?: boolean }>();
  let ch = bot.state.get<ChannelSettings>('nickfilter.channels', { enabled: false, action: 'rename', renameTo: 'Renamed Channel' });
  const chFailed = new Map<string, number>();
  /** Channels ("<id>|<name>") that already had a blocked word when the filter was switched on: left alone unless !channelfilter check. */
  let chAllowed = new Set(bot.state.get<string[]>('nickfilter.channelsAllowed', []));
  let chChecking = false;
  let timer: NodeJS.Timeout | undefined;
  let offDirectory: (() => void) | undefined;
  let checking = false;

  const save = (next: Settings): void => {
    s = next;
    bot.state.set('nickfilter.settings', next);
  };
  const exempt = (u: TsUser): boolean => bot.isAdmin(u.uid) || u.groups.some((g) => cfg.exemptGroups.includes(g));
  const tellAdmins = (text: string): void => {
    for (const a of adapter.users().filter((x) => bot.isAdmin(x.uid))) adapter.sendPrivate(a.id, text).catch(() => {});
  };
  const consequence = (): string =>
    s.action === 'kick' ? 'or you will be kicked' : s.action === 'move' ? `or you will be moved to "${s.moveChannel}"` : 'please';

  async function act(u: TsUser, word: string): Promise<void> {
    if (s.action === 'warn') {
      log.info(`${u.name} kept a nickname with a blocked word ("${word}")`);
      tellAdmins(`${u.name} has a blocked word ("${word}") in their nickname and didn't change it.`);
      return;
    }
    if (s.action === 'move') {
      const ch = adapter.findChannel(s.moveChannel);
      if (!ch) {
        log.warn(`nickname filter: there is no channel called "${s.moveChannel}" to move people to`);
        return;
      }
      if (u.channelId === ch.id) return;
      try {
        await adapter.moveUser(u.id, ch.id);
        log.info(`moved ${u.name} to "${ch.name}": blocked word "${word}" in their nickname`);
        adapter.sendPrivate(u.id, `I moved you to "${ch.name}" because your nickname has a word that isn't allowed here. Change your nickname to rejoin the other channels.`).catch(() => {});
      } catch (e) {
        log.warn(`could not move ${u.name}: ${errMessage(e)}`);
      }
      return;
    }
    try {
      await adapter.kickUser(u.id, 'Nickname not allowed on this server');
      log.info(`kicked ${u.name}: blocked word "${word}" in their nickname`);
      tellAdmins(`I kicked ${u.name}: blocked word "${word}" in their nickname.`);
    } catch (e) {
      log.warn(`could not kick ${u.name}: ${errMessage(e)}`);
    }
  }

  async function check(): Promise<void> {
    if (checking || !s.enabled || !s.words.length || !adapter.connected) return;
    checking = true;
    try {
      const users = adapter.users();
      for (const id of [...warned.keys()]) if (!users.some((u) => u.id === id)) warned.delete(id);
      const now = Date.now();
      for (const u of users) {
        if (exempt(u)) continue;
        const word = blockedWordIn(u.name, s.words);
        if (!word) {
          warned.delete(u.id); // renamed: all good
          continue;
        }
        const w = warned.get(u.id);
        if (!w) {
          warned.set(u.id, { name: u.name, at: now });
          log.info(`warned ${u.name}: blocked word "${word}" in their nickname`);
          const text = `Your nickname has a word that isn't allowed here. Please change it within ${cfg.graceSeconds} seconds, ${consequence()}.`;
          await adapter.poke(u.id, 'Please change your nickname: it has a word that is not allowed here.').catch(() => {});
          await adapter.sendPrivate(u.id, text).catch(() => {});
          continue;
        }
        if (now - w.at < cfg.graceSeconds * 1000) continue;
        // a "move" is repeated if they wander out of the channel with the same name; warn and kick happen once
        if (w.done && s.action !== 'move') continue;
        w.done = true;
        await act(u, word);
      }
    } finally {
      checking = false;
    }
  }

  const saveCh = (next: ChannelSettings): void => {
    ch = next;
    bot.state.set('nickfilter.channels', next);
  };

  /** Channels whose names have a blocked word right now. */
  const badChannels = (): { id: bigint; name: string; parentId: bigint; word: string }[] =>
    adapter
      .channels()
      .map((c) => ({ ...c, word: channelBlockedWord(c.name, s.words) ?? '' }))
      .filter((c) => c.word);

  /** Rename or remove channels with blocked words. Returns what was done, one line each. */
  async function checkChannels(force = false): Promise<string[]> {
    const done: string[] = [];
    if (chChecking || (!ch.enabled && !force) || !s.words.length || !adapter.connected) return done;
    chChecking = true;
    try {
      const now = Date.now();
      for (const bad of badChannels()) {
        const key = `${bad.id}|${bad.name}`;
        if (!force && chAllowed.has(key)) continue;
        const failedAt = chFailed.get(key);
        if (!force && failedAt !== undefined && now - failedAt < CHANNEL_RETRY_MS) continue;
        const inside = adapter.usersInChannel(bad.id);
        const hasChildren = adapter.channels().some((c) => c.parentId === bad.id);
        try {
          if (ch.action === 'delete' && !inside.length && !hasChildren && bad.id !== adapter.selfChannelId()) {
            await adapter.deleteChannel(bad.id);
            done.push(`removed "${bad.name}" (blocked word "${bad.word}")`);
          } else {
            const siblings = adapter.channels().filter((c) => c.parentId === bad.parentId && c.id !== bad.id).map((c) => c.name);
            const to = uniqueName(ch.renameTo, siblings);
            await adapter.renameChannel(bad.id, to);
            done.push(`renamed "${bad.name}" to "${to}" (blocked word "${bad.word}")`);
            for (const u of inside) adapter.sendPrivate(u.id, `I renamed your channel to "${to}" because its name had a word that isn't allowed here.`).catch(() => {});
          }
          chFailed.delete(key);
        } catch (e) {
          chFailed.set(key, now);
          log.warn(`could not fix channel "${bad.name}": ${errMessage(e)}`);
        }
      }
      for (const line of done) log.info(`channel filter: ${line}`);
      if (done.length) tellAdmins(`Channel name filter: ${done.join('; ')}.`);
      if (chFailed.size > 200) chFailed.clear();
    } finally {
      chChecking = false;
    }
    return done;
  }

  const cog: Cog = {
    commands: [
      {
        name: 'nickfilter',
        description: `Blocked words in nicknames: ${p}nickfilter [on|off|add <word>|remove <word>|action warn|move|kick|channel <name>] (bot admins only)`,
        usage: `${p}nickfilter [on|off|add <word>|remove <word>|action warn|move|kick|channel <name>]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub || sub === 'status' || sub === 'list') {
            const now = adapter.users().filter((u) => !exempt(u) && blockedWordIn(u.name, s.words));
            return ctx.reply(
              [
                `The nickname filter is ${s.enabled ? 'on' : 'off'}. If someone doesn't rename within ${cfg.graceSeconds} seconds of a warning: ${s.action === 'warn' ? 'I tell the online bot admins' : s.action === 'move' ? `I move them to "${s.moveChannel}"` : 'I kick them'}.`,
                s.words.length ? `Blocked words (${s.words.length}): ${s.words.join(', ')}` : `No blocked words yet: ${p}nickfilter add <word>`,
                now.length ? `Online now with a blocked word: ${now.map((u) => u.name).join(', ')}` : '',
              ]
                .filter(Boolean)
                .join('\n'),
            );
          }
          if (sub === 'on') {
            if (!s.words.length) return ctx.reply(`Add a word first: ${p}nickfilter add <word>`);
            save({ ...s, enabled: true });
            void check();
            return ctx.reply(`The nickname filter is on (${s.action} mode). Bot admins are never checked.`);
          }
          if (sub === 'off') {
            save({ ...s, enabled: false });
            warned.clear();
            return ctx.reply('The nickname filter is off.');
          }
          if (sub === 'add' || sub === 'remove') {
            const word = ctx.rest.slice(sub.length).trim();
            if (word.length < 2 || word.length > 32) return ctx.reply('Give a word of 2 to 32 characters.');
            const has = s.words.some((w) => w.toLowerCase() === word.toLowerCase());
            if (sub === 'add') {
              if (has) return ctx.reply(`"${word}" is already blocked.`);
              if (s.words.length >= MAX_WORDS) return ctx.reply(`That's the most words I keep (${MAX_WORDS}).`);
              save({ ...s, words: [...s.words, word] });
              void check();
              return ctx.reply(`"${word}" is blocked in nicknames.${s.enabled ? '' : ` The filter is off: ${p}nickfilter on.`}`);
            }
            if (!has) return ctx.reply(`"${word}" isn't on the list.`);
            save({ ...s, words: s.words.filter((w) => w.toLowerCase() !== word.toLowerCase()) });
            return ctx.reply(`"${word}" is allowed again.`);
          }
          if (sub === 'action') {
            const a = ctx.args[1]?.toLowerCase();
            if (a !== 'warn' && a !== 'move' && a !== 'kick') return ctx.reply(`Usage: ${p}nickfilter action warn|move|kick`);
            if (a === 'move' && !adapter.findChannel(s.moveChannel)) return ctx.reply(`I can't find the channel "${s.moveChannel}". Pick one first: ${p}nickfilter channel <name>`);
            save({ ...s, action: a });
            return ctx.reply(a === 'warn' ? 'Warn mode: people are warned, and the online bot admins are told if they keep the name.' : a === 'move' ? `Move mode: people who keep the name are moved to "${s.moveChannel}".` : 'Kick mode: people who keep the name are kicked from the server.');
          }
          if (sub === 'channel') {
            const want = ctx.rest.slice('channel'.length).trim();
            const ch = adapter.findChannel(want);
            if (!ch) return ctx.reply(`I cannot find a channel called "${want}".`);
            save({ ...s, moveChannel: ch.name });
            return ctx.reply(`People are moved to "${ch.name}" (in move mode).`);
          }
          return ctx.reply(`Usage: ${p}nickfilter [on|off|add <word>|remove <word>|action warn|move|kick|channel <name>]`);
        },
      },
      {
        name: 'channelfilter',
        aliases: ['chanfilter'],
        description: `Blocked words in channel names (the same word list as ${p}nickfilter): ${p}channelfilter [on|off|action rename|delete|name <text>|check] (bot admins only)`,
        usage: `${p}channelfilter [on|off|action rename|delete|name <text>|check]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub || sub === 'status' || sub === 'list') {
            const bad = badChannels();
            return ctx.reply(
              [
                `The channel name filter is ${ch.enabled ? 'on' : 'off'}. Channels with a blocked word are ${ch.action === 'delete' ? 'removed if empty (renamed if not)' : 'renamed'} to "${ch.renameTo}", and the online bot admins are told.`,
                s.words.length ? `It uses the ${s.words.length} blocked word${s.words.length === 1 ? '' : 's'} from ${p}nickfilter (add more with ${p}nickfilter add <word>). Numbers are not read as letters in channel names.` : `No blocked words yet: ${p}nickfilter add <word>`,
                bad.length ? `Channels with a blocked word now: ${bad.map((b) => `"${b.name}" (${b.word})`).join(', ')}` : 'No channel has a blocked word now.',
              ].join('\n'),
            );
          }
          if (sub === 'on') {
            if (!s.words.length) return ctx.reply(`Add a blocked word first: ${p}nickfilter add <word>`);
            saveCh({ ...ch, enabled: true });
            // channels that are already there are someone's choice: leave them, but say which they are
            const existing = badChannels();
            chAllowed = new Set(existing.map((b) => `${b.id}|${b.name}`));
            bot.state.set('nickfilter.channelsAllowed', [...chAllowed]);
            return ctx.reply(
              `The channel name filter is on. New channels, and channels renamed from now on, are checked.` +
                (existing.length ? `\nI left these existing channels alone: ${existing.map((b) => `"${b.name}" (${b.word})`).join(', ')}. ${p}channelfilter check fixes them too.` : ''),
            );
          }
          if (sub === 'off') {
            saveCh({ ...ch, enabled: false });
            return ctx.reply('The channel name filter is off.');
          }
          if (sub === 'action') {
            const a = ctx.args[1]?.toLowerCase();
            if (a !== 'rename' && a !== 'delete') return ctx.reply(`Usage: ${p}channelfilter action rename|delete`);
            saveCh({ ...ch, action: a });
            return ctx.reply(a === 'rename' ? `Channels with a blocked word are renamed to "${ch.renameTo}".` : `Empty channels with a blocked word are removed; ones with people in them (or sub-channels) are renamed to "${ch.renameTo}".`);
          }
          if (sub === 'name') {
            const t = ctx.rest.slice('name'.length).trim();
            if (!t || t.length > 36 || channelBlockedWord(t, s.words)) return ctx.reply(`Give a clean name of up to 36 characters: ${p}channelfilter name Renamed Channel`);
            saveCh({ ...ch, renameTo: t });
            return ctx.reply(`Bad channels are renamed to "${t}".`);
          }
          if (sub === 'check') {
            if (!ch.enabled) {
              const bad = badChannels();
              return ctx.reply(`The filter is off, so I changed nothing.${bad.length ? ` These have a blocked word: ${bad.map((b) => `"${b.name}" (${b.word})`).join(', ')}.` : ' No channel has a blocked word.'}`);
            }
            const done = await checkChannels(true);
            chAllowed = new Set();
            bot.state.set('nickfilter.channelsAllowed', []);
            return ctx.reply(done.length ? `Done: ${done.join('; ')}.` : 'No channel has a blocked word.');
          }
          return ctx.reply(`Usage: ${p}channelfilter [on|off|action rename|delete|name <text>|check]`);
        },
      },
    ],

    onLoad() {
      offDirectory = adapter.events.on('directory', () => {
        void check();
        void checkChannels();
      });
      timer = setInterval(() => {
        void check();
        void checkChannels();
      }, TICK_MS);
      timer.unref?.();
    },

    onUnload() {
      offDirectory?.();
      if (timer) clearInterval(timer);
    },

    status: () => `Nickname filter ${s.enabled ? `on (${s.action}, ${s.words.length} words)` : 'off'} | channel name filter ${ch.enabled ? `on (${ch.action})` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createNickfilterCog(bot);
export default factory;
