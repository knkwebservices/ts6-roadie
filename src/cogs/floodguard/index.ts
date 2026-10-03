import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'floodguard',
  version: '1.0.0',
  description: 'Channel-hopping and chat-spam guard: a warning first, then tell admins, move or kick',
};

/** A second flood within this long gets the configured action; after it, the next flood is a fresh warning. */
const STRIKE_MEMORY_MS = 10 * 60_000;
/** After connecting, ignore the client list for a moment so everyone appearing at once is not "hopping". */
const WARMUP_MS = 3_000;

export type FloodAction = 'warn' | 'move' | 'kick';

interface Settings {
  enabled: boolean;
  action: FloodAction;
}

/** Times something happened, trimmed to a window. Returns how many fall inside it, counting `now`. */
export function bump(times: number[], now: number, windowMs: number): number {
  times.push(now);
  while (times.length && now - times[0]! > windowMs) times.shift();
  return times.length;
}

export function createFloodGuardCog(bot: BotApi): Cog {
  const cfg = bot.config.floodguard;
  const p = bot.config.prefix;
  const log = bot.log.child('floodguard');
  const adapter = bot.adapter;

  let settings = bot.state.get<Settings>('floodguard.settings', { enabled: cfg.enabled, action: cfg.action });
  const save = (): void => bot.state.set('floodguard.settings', settings);

  const hops = new Map<string, number[]>();
  const chats = new Map<string, number[]>();
  const strikes = new Map<string, number>();
  const whereWas = new Map<number, bigint>();
  let warm = false;
  let offDirectory: (() => void) | undefined;
  let offMessage: (() => void) | undefined;
  let offReady: (() => void) | undefined;
  let warmTimer: NodeJS.Timeout | undefined;
  let caught = 0;

  const exempt = (uid: string, groups: number[]): boolean => bot.isAdmin(uid) || groups.some((g) => cfg.exemptGroups.includes(g));

  function tellAdmins(text: string): void {
    for (const a of adapter.users().filter((u) => bot.isAdmin(u.uid))) {
      adapter.sendPrivate(a.id, text).catch((e) => log.debug(`could not tell ${a.name}: ${errMessage(e)}`));
    }
  }

  /** Someone flooded: warn the first time, act the second time within ten minutes. */
  async function flooded(user: { id: number; uid: string; name: string }, what: 'hopping between channels' | 'sending messages too fast'): Promise<void> {
    const now = Date.now();
    caught++;
    hops.delete(user.uid);
    chats.delete(user.uid);
    if (cfg.quietSeconds > 0) bot.silence(user.uid, cfg.quietSeconds * 1000);
    const last = strikes.get(user.uid);
    strikes.set(user.uid, now);
    if (strikes.size > 1000) for (const [k, t] of strikes) if (now - t > STRIKE_MEMORY_MS) strikes.delete(k);

    if (last === undefined || now - last > STRIKE_MEMORY_MS) {
      log.info(`${user.name} warned for ${what}`);
      await adapter.poke(user.id, `Please slow down: you're ${what}.`).catch((e) => log.debug(`could not poke ${user.name}: ${errMessage(e)}`));
      await adapter
        .sendPrivate(user.id, `Please slow down: you're ${what}.${cfg.quietSeconds > 0 ? ` I'll ignore your commands for ${cfg.quietSeconds} seconds.` : ''} If it happens again soon, ${settings.action === 'kick' ? "you'll be kicked" : settings.action === 'move' ? `you'll be moved to "${cfg.moveChannel}"` : 'the admins will be told'}.`)
        .catch((e) => log.debug(`could not message ${user.name}: ${errMessage(e)}`));
      return;
    }

    log.warn(`${user.name} flooded again (${what}): ${settings.action}`);
    if (settings.action === 'kick') {
      try {
        await adapter.kickUser(user.id, `Flooding: ${what}`);
        tellAdmins(`Flood guard: kicked ${user.name} for ${what} again after a warning.`);
      } catch (e) {
        tellAdmins(`Flood guard: ${user.name} kept ${what}, but I couldn't kick them (${errMessage(e)}).`);
      }
      return;
    }
    if (settings.action === 'move') {
      const ch = adapter.findChannel(cfg.moveChannel);
      if (ch) {
        try {
          await adapter.moveUser(user.id, ch.id);
          await adapter.sendPrivate(user.id, `You were moved to "${ch.name}" for ${what}.`).catch(() => undefined);
          tellAdmins(`Flood guard: moved ${user.name} to "${ch.name}" for ${what} again after a warning.`);
          return;
        } catch (e) {
          tellAdmins(`Flood guard: ${user.name} kept ${what}, but I couldn't move them (${errMessage(e)}).`);
          return;
        }
      }
      tellAdmins(`Flood guard: ${user.name} kept ${what}, but there's no channel called "${cfg.moveChannel}" to move them to.`);
      return;
    }
    tellAdmins(`Flood guard: ${user.name} kept ${what} after a warning.`);
  }

  function onDirectory(): void {
    const users = adapter.users();
    const seen = new Set<number>();
    const now = Date.now();
    const hopWindow = cfg.hopSeconds * 1000;
    for (const u of users) {
      seen.add(u.id);
      const before = whereWas.get(u.id);
      whereWas.set(u.id, u.channelId);
      if (!warm || !settings.enabled || before === undefined || before === u.channelId) continue;
      if (exempt(u.uid, u.groups)) continue;
      const times = hops.get(u.uid) ?? [];
      hops.set(u.uid, times);
      if (bump(times, now, hopWindow) >= cfg.hops) void flooded(u, 'hopping between channels');
    }
    for (const id of [...whereWas.keys()]) if (!seen.has(id)) whereWas.delete(id);
    if (hops.size > 1000) for (const [k, t] of hops) if (!t.length || now - t[t.length - 1]! > hopWindow) hops.delete(k);
  }

  function onMessage(m: { senderId: number; senderUid: string; senderName: string; senderGroups: number[] }): void {
    if (!settings.enabled || m.senderId === adapter.selfId || exempt(m.senderUid, m.senderGroups)) return;
    const now = Date.now();
    const win = cfg.messageSeconds * 1000;
    const times = chats.get(m.senderUid) ?? [];
    chats.set(m.senderUid, times);
    if (bump(times, now, win) >= cfg.messages) void flooded({ id: m.senderId, uid: m.senderUid, name: m.senderName }, 'sending messages too fast');
    if (chats.size > 1000) for (const [k, t] of chats) if (!t.length || now - t[t.length - 1]! > win) chats.delete(k);
  }

  const cog: Cog = {
    commands: [
      {
        name: 'floodguard',
        aliases: ['flood'],
        description: `Channel-hopping and chat-spam guard: ${p}floodguard [on|off|action warn|move|kick] (bot admins only)`,
        usage: `${p}floodguard [on|off|action warn|move|kick]`,
        perm: 'admin',
        run: (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub) {
            return ctx.reply(
              `The flood guard is ${settings.enabled ? 'ON' : 'off'}.\n` +
                `Hopping: ${cfg.hops} channel switches within ${cfg.hopSeconds} seconds. Spam: ${cfg.messages} messages I can see within ${cfg.messageSeconds} seconds.\n` +
                `First time: a poke and a warning${cfg.quietSeconds ? `, and their commands are ignored for ${cfg.quietSeconds} seconds` : ''}. Again within 10 minutes: ${settings.action === 'kick' ? 'kick' : settings.action === 'move' ? `move to "${cfg.moveChannel}"` : 'tell the admins'}.\n` +
                `Caught since I started: ${caught}. Bot admins${cfg.exemptGroups.length ? ` and groups ${cfg.exemptGroups.join(', ')}` : ''} are never checked.`,
            );
          }
          if (sub === 'on' || sub === 'off') {
            settings = { ...settings, enabled: sub === 'on' };
            save();
            return ctx.reply(`The flood guard is ${sub}.`);
          }
          if (sub === 'action') {
            const a = ctx.args[1]?.toLowerCase();
            if (a !== 'warn' && a !== 'move' && a !== 'kick') return ctx.reply(`Usage: ${p}floodguard action warn|move|kick`);
            settings = { ...settings, action: a };
            save();
            return ctx.reply(`After a warning, a second flood will ${a === 'kick' ? 'get them kicked' : a === 'move' ? `move them to "${cfg.moveChannel}"` : 'be reported to the admins'}.`);
          }
          return ctx.reply(`Usage: ${p}floodguard [on|off|action warn|move|kick]`);
        },
      },
    ],

    onLoad() {
      offDirectory = adapter.events.on('directory', onDirectory);
      offMessage = adapter.events.on('message', onMessage);
      const startWarm = (): void => {
        warm = false;
        whereWas.clear();
        if (warmTimer) clearTimeout(warmTimer);
        warmTimer = setTimeout(() => {
          for (const u of adapter.users()) whereWas.set(u.id, u.channelId);
          warm = true;
        }, WARMUP_MS);
        warmTimer.unref?.();
      };
      offReady = bot.events.on('ready', startWarm);
      startWarm();
    },

    onUnload() {
      offDirectory?.();
      offMessage?.();
      offReady?.();
      if (warmTimer) clearTimeout(warmTimer);
    },

    status: () => `Flood guard ${settings.enabled ? `on (${settings.action}, ${caught} caught)` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot: BotApi) => createFloodGuardCog(bot);
export default factory;
