import type { TsChannel, TsUser } from '../../adapter/types.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'gamegroups',
  version: '1.0.0',
  description: 'Self-service game groups: !game fallout 76 gives (or takes back) a server group like "Fallout 76 Player"',
};

/** After connecting, ignore the client list for a moment so people already in a game channel are not toggled. */
const WARMUP_MS = 2_000;
/** One toggle per person per this long, so a double-click (or a channel bounce) does not undo itself. */
const TOGGLE_COOLDOWN_MS = 5_000;
const MAX_GAMES = 50;

export interface Game {
  name: string;
  group: number;
  /** Joining this channel (by name or "#<id>") toggles the group. */
  channel?: string;
}

/** Find a game by what someone typed: exact name first, then a name starting with it, then one containing it. */
export function findGame(games: Game[], typed: string): Game | undefined {
  const t = typed.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!t) return undefined;
  const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (
    games.find((g) => g.name.toLowerCase() === t) ??
    games.find((g) => squash(g.name) === squash(t)) ??
    games.find((g) => g.name.toLowerCase().startsWith(t)) ??
    games.find((g) => squash(g.name).includes(squash(t)))
  );
}

export function createGameGroupsCog(bot: BotApi): Cog {
  const cfg = bot.config.gamegroups;
  const p = bot.config.prefix;
  const log = bot.log.child('gamegroups');
  const adapter = bot.adapter;

  let enabled = bot.state.get<boolean>('gamegroups.enabled', cfg.enabled);
  let games = bot.state.get<Game[]>('gamegroups.games', cfg.games);
  const save = (): void => {
    bot.state.set('gamegroups.enabled', enabled);
    bot.state.set('gamegroups.games', games);
  };

  /** Where each client was at the last look, and where before that (to move them back). */
  const whereWas = new Map<number, bigint>();
  const cameFrom = new Map<number, bigint>();
  const lastToggle = new Map<string, number>();
  let warm = false;
  let offDirectory: (() => void) | undefined;
  let offReady: (() => void) | undefined;
  let warmTimer: NodeJS.Timeout | undefined;

  const channelById = (id: bigint): TsChannel | undefined => adapter.channels().find((c) => c.id === id);
  const resolveChannel = (text: string): TsChannel | undefined => {
    const t = text.trim();
    const byId = /^#(\d+)$/.exec(t);
    return byId ? channelById(BigInt(byId[1]!)) : adapter.findChannel(t);
  };

  /**
   * Add the group if they don't have it, take it away if they do. Their groups are asked from the server,
   * because on TeamSpeak 6 the client list can be out of date about group changes.
   */
  async function toggle(user: TsUser, game: Game): Promise<string> {
    const now = Date.now();
    const key = `${user.uid}|${game.group}`;
    const last = lastToggle.get(key);
    if (last !== undefined && now - last < TOGGLE_COOLDOWN_MS) return 'One moment, then try again.';
    lastToggle.set(key, now);
    if (lastToggle.size > 1000) for (const [k, t] of lastToggle) if (now - t > TOGGLE_COOLDOWN_MS) lastToggle.delete(k);

    let groups: number[];
    try {
      groups = await adapter.userGroups(user.id);
    } catch {
      groups = user.groups;
    }
    const has = groups.includes(game.group);
    try {
      if (has) await adapter.removeServerGroup(user.id, game.group);
      else await adapter.addServerGroup(user.id, game.group);
    } catch (e) {
      const why = errMessage(e);
      // the server saying it is already done counts as done
      if (/already|duplicate|not a member|empty result|invalid.*member/i.test(why)) {
        return has ? `You're no longer in ${game.name}.` : `You're in ${game.name}.`;
      }
      log.warn(`could not ${has ? 'remove' : 'add'} group ${game.group} for ${user.name}: ${why}`);
      return `I couldn't change your ${game.name} group (${why}). A server admin may need to give me permission to manage that group.`;
    }
    log.info(`${user.name} ${has ? 'left' : 'joined'} ${game.name} (group ${game.group})`);
    return has ? `Done: you're no longer in ${game.name}. Send ${p}game ${game.name} to join again.` : `Done: you're in ${game.name}. Send ${p}game ${game.name} again to leave it.`;
  }

  /** Someone walked into a game's channel: toggle it, tell them, and (by default) put them back where they were. */
  function onDirectory(): void {
    const users = adapter.users();
    const seen = new Set<number>();
    for (const u of users) {
      seen.add(u.id);
      const before = whereWas.get(u.id);
      if (before !== u.channelId) {
        if (before !== undefined) cameFrom.set(u.id, before);
        whereWas.set(u.id, u.channelId);
        if (before === undefined || !warm || !enabled) continue;
        for (const game of games) {
          if (!game.channel) continue;
          const ch = resolveChannel(game.channel);
          if (!ch || ch.id !== u.channelId) continue;
          void (async () => {
            const msg = await toggle(u, game);
            await adapter.sendPrivate(u.id, msg).catch((e) => log.debug(`could not message ${u.name}: ${errMessage(e)}`));
            const back = cameFrom.get(u.id);
            if (cfg.moveBack && back !== undefined && back !== ch.id && channelById(back)) {
              await adapter.moveUser(u.id, back).catch((e) => log.debug(`could not move ${u.name} back: ${errMessage(e)}`));
            }
          })();
        }
      }
    }
    for (const id of [...whereWas.keys()]) if (!seen.has(id)) (whereWas.delete(id), cameFrom.delete(id));
  }

  const listLine = (g: Game): string => `${g.name}${g.channel ? ` (or join "${g.channel}")` : ''}`;

  const cog: Cog = {
    commands: [
      {
        name: 'game',
        aliases: ['games', 'role'],
        description: `Give yourself a game's server group, or take it away: ${p}game <name>. ${p}games lists them. (Admins: ${p}game add <group ID> <name>, ${p}game remove <name>, ${p}game channel <name> | <channel>)`,
        usage: `${p}game [<name>|add <group ID> <name>|remove <name>|channel <name> | <channel or none>|on|off]`,
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();

          if (!sub || sub === 'list') {
            if (!games.length) return ctx.reply(`No game groups yet.${ctx.isAdmin ? ` Add one: ${p}game add <server group ID> <name>, like ${p}game add 14 Fallout 76` : ''}`);
            if (!enabled) return ctx.reply(`Game groups are switched off right now.${ctx.isAdmin ? ` ${p}game on` : ''}`);
            let mine: number[] = [];
            try {
              mine = await adapter.userGroups(ctx.msg.senderId);
            } catch {
              mine = ctx.msg.senderGroups;
            }
            const lines = games.map((g) => `${mine.includes(g.group) ? '[x]' : '[ ]'} ${listLine(g)}`);
            return ctx.reply(`Game groups (send ${p}game <name> to join or leave one):\n${lines.join('\n')}`);
          }

          if (sub === 'on' || sub === 'off') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            enabled = sub === 'on';
            save();
            return ctx.reply(`Game groups are ${sub}.`);
          }

          if (sub === 'add') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const group = Number(ctx.args[1]);
            const name = ctx.args.slice(2).join(' ').trim();
            if (!Number.isInteger(group) || group <= 0 || name.length < 2 || name.length > 40)
              return ctx.reply(`Usage: ${p}game add <server group ID> <name>, like ${p}game add 14 Fallout 76 (make the server group in TeamSpeak first, and make sure I'm allowed to add people to it)`);
            if (games.length >= MAX_GAMES) return ctx.reply(`That's ${MAX_GAMES} already. Remove one first.`);
            if (games.some((g) => g.name.toLowerCase() === name.toLowerCase())) return ctx.reply(`There's already a game called ${name}.`);
            if (games.some((g) => g.group === group)) return ctx.reply(`Server group ${group} is already offered as ${games.find((g) => g.group === group)!.name}.`);
            games = [...games, { name, group }];
            save();
            return ctx.reply(`Added: ${p}game ${name} now gives server group ${group}. Want a channel that does it too? ${p}game channel ${name} | <channel>`);
          }

          if (sub === 'remove') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const g = findGame(games, ctx.args.slice(1).join(' '));
            if (!g) return ctx.reply(`No game matches that. ${p}games lists them.`);
            games = games.filter((x) => x !== g);
            save();
            return ctx.reply(`Removed ${g.name}. (Nobody loses the group; it just isn't offered any more.)`);
          }

          if (sub === 'channel') {
            if (!ctx.isAdmin) return ctx.reply('Bot admins only.');
            const rest = ctx.rest.trim().replace(/^channel\s*/i, '');
            const bar = rest.indexOf('|');
            if (bar < 0) return ctx.reply(`Usage: ${p}game channel <game name> | <channel name>, or | none to stop using a channel`);
            const g = findGame(games, rest.slice(0, bar));
            const chText = rest.slice(bar + 1).trim();
            if (!g) return ctx.reply(`No game matches "${rest.slice(0, bar).trim()}". ${p}games lists them.`);
            if (!chText || chText.toLowerCase() === 'none') {
              games = games.map((x) => (x === g ? { name: x.name, group: x.group } : x));
              save();
              return ctx.reply(`${g.name} no longer has a channel.`);
            }
            const ch = resolveChannel(chText);
            if (!ch) return ctx.reply(`I can't find a channel called "${chText}".`);
            games = games.map((x) => (x === g ? { ...x, channel: ch.name } : x));
            save();
            return ctx.reply(`Joining "${ch.name}" now toggles ${g.name}${cfg.moveBack ? ', and I move them back to where they were' : ''}.`);
          }

          // anything else is a game name
          if (!enabled) return ctx.reply('Game groups are switched off right now.');
          const g = findGame(games, ctx.rest);
          if (!g) return ctx.reply(`No game called "${ctx.rest.trim()}". ${games.length ? `Choose from: ${games.map((x) => x.name).join(', ')}` : 'None are set up yet.'}`);
          const me = (await ctx.user()) ?? adapter.users().find((u) => u.id === ctx.msg.senderId);
          if (!me) return ctx.reply("I can't see you on the server right now.");
          return ctx.reply(await toggle(me, g));
        },
      },
    ],

    onLoad() {
      offDirectory = adapter.events.on('directory', onDirectory);
      const startWarm = (): void => {
        warm = false;
        whereWas.clear();
        cameFrom.clear();
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
      offReady?.();
      if (warmTimer) clearTimeout(warmTimer);
    },

    status: () => `Game groups ${enabled ? `on (${games.length} offered)` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createGameGroupsCog(bot);
export default factory;
