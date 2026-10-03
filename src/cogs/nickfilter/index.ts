import type { TsUser } from '../../adapter/types.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'nickfilter',
  version: '1.0.0',
  description: 'Warns about blocked words in nicknames, then moves or kicks if they are not changed',
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

export function createNickfilterCog(bot: BotApi): Cog {
  const cfg = bot.config.nickfilter;
  const p = bot.config.prefix;
  const log = bot.log.child('nickfilter');
  const adapter = bot.adapter;

  let s = bot.state.get<Settings>('nickfilter.settings', { enabled: cfg.enabled, words: cfg.words, action: cfg.action, moveChannel: cfg.moveChannel });
  /** Warned people, by client number (a reconnect gets a fresh warning and a fresh wait). */
  const warned = new Map<number, { name: string; at: number; done?: boolean }>();
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
    ],

    onLoad() {
      offDirectory = adapter.events.on('directory', () => void check());
      timer = setInterval(() => void check(), TICK_MS);
      timer.unref?.();
    },

    onUnload() {
      offDirectory?.();
      if (timer) clearInterval(timer);
    },

    status: () => `Nickname filter ${s.enabled ? `on (${s.action}, ${s.words.length} words)` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createNickfilterCog(bot);
export default factory;
