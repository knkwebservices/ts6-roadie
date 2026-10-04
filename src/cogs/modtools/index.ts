import type { TsUser } from '../../adapter/types.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage, formatAgo } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'modtools',
  version: '1.0.0',
  description: 'Jail (!jail), reports to staff (!report) and staff meetings (!meeting)',
};

/** How often jail time is checked. */
const TICK_MS = 15_000;
/** Don't move the same jailed person again within this long (they may be mid-reconnect). */
const REMOVE_GAP_MS = 3_000;

export interface Jailed {
  uid: string;
  name: string;
  /** When they're let out (ms since 1970); 0 means until someone lets them out. */
  until: number;
  by: string;
  reason: string;
  at: number;
}

export interface Report {
  id: number;
  at: number;
  by: string;
  byUid: string;
  about: string;
  reason: string;
}

/** "30" -> 30 minutes, "2h" -> 120, "1d" -> 1440, "0"/"forever" -> 0 (until let out). Undefined if it isn't a duration. */
export function parseMinutes(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  if (t === 'forever' || t === 'perm') return 0;
  const m = /^(\d+)(m|min|mins|h|hr|hrs|d|day|days)?$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = m[2] ?? 'm';
  return unit.startsWith('h') ? n * 60 : unit.startsWith('d') ? n * 1440 : n;
}

export const describeMinutes = (min: number): string =>
  min === 0 ? 'until someone lets them out' : min % 1440 === 0 ? `${min / 1440} day${min === 1440 ? '' : 's'}` : min % 60 === 0 ? `${min / 60} hour${min === 60 ? '' : 's'}` : `${min} minute${min === 1 ? '' : 's'}`;

/**
 * Split "!jail Big Mike 30 spamming" into the person and the rest: the longest run of leading words
 * that is exactly someone's name wins, then a part of a name from the first word.
 */
export function splitTarget(args: string[], users: TsUser[]): { user: TsUser; rest: string[] } | undefined {
  for (let k = args.length; k >= 1; k--) {
    const name = args.slice(0, k).join(' ').toLowerCase();
    const u = users.find((x) => x.name.toLowerCase() === name);
    if (u) return { user: u, rest: args.slice(k) };
  }
  const first = (args[0] ?? '').toLowerCase();
  if (!first) return undefined;
  const hits = users.filter((x) => x.name.toLowerCase().includes(first));
  return hits.length === 1 ? { user: hits[0]!, rest: args.slice(1) } : undefined;
}

export function createModToolsCog(bot: BotApi): Cog {
  const cfg = bot.config.modtools;
  const p = bot.config.prefix;
  const log = bot.log.child('modtools');
  const adapter = bot.adapter;

  let jail = bot.state.get<Jailed[]>('modtools.jail', []);
  let reports = bot.state.get<Report[]>('modtools.reports', []);
  let nextReport = bot.state.get<number>('modtools.nextReport', 1);
  const lastReportBy = new Map<string, number>();
  const lastMoved = new Map<string, number>();
  let timer: NodeJS.Timeout | undefined;
  let offDirectory: (() => void) | undefined;

  const saveJail = (): void => bot.state.set('modtools.jail', jail);
  const saveReports = (): void => {
    bot.state.set('modtools.reports', reports);
    bot.state.set('modtools.nextReport', nextReport);
  };

  const staffGroups = (): number[] => bot.state.get<number[]>('servertools.staffGroups', bot.config.servertools.staffGroups);
  const isStaff = (u: TsUser): boolean => bot.isAdmin(u.uid) || u.groups.some((g) => staffGroups().includes(g));
  const staffOnline = (): TsUser[] => adapter.users().filter(isStaff);
  const jailChannel = () => adapter.findChannel(cfg.jailChannel);
  const channelName = (id: bigint): string => adapter.channels().find((c) => c.id === id)?.name ?? `#${id}`;
  const timeLeft = (j: Jailed): string => (j.until === 0 ? 'until someone lets you out' : `for ${describeMinutes(Math.max(1, Math.ceil((j.until - Date.now()) / 60_000)))} more`);

  /** Let out anyone whose time is up, and put back anyone who has walked out of jail. */
  async function enforce(): Promise<void> {
    const now = Date.now();
    const done = jail.filter((j) => j.until !== 0 && j.until <= now);
    if (done.length) {
      jail = jail.filter((j) => !done.includes(j));
      saveJail();
      for (const j of done) {
        log.info(`${j.name} served their time`);
        const u = adapter.users().find((x) => x.uid === j.uid);
        if (u) await adapter.sendPrivate(u.id, "Your jail time is over. You're free to go.").catch(() => undefined);
      }
    }
    const ch = jailChannel();
    if (!ch || !jail.length) return;
    for (const u of adapter.users()) {
      const j = jail.find((x) => x.uid === u.uid);
      if (!j || u.channelId === ch.id) continue;
      const last = lastMoved.get(u.uid);
      if (last !== undefined && now - last < REMOVE_GAP_MS) continue;
      lastMoved.set(u.uid, now);
      try {
        await adapter.moveUser(u.id, ch.id);
        await adapter.poke(u.id, `You're in jail ${timeLeft(j)}.`).catch(() => undefined);
      } catch (e) {
        log.warn(`could not move ${u.name} back to jail: ${errMessage(e)}`);
      }
    }
  }

  const cog: Cog = {
    commands: [
      {
        name: 'jail',
        description: `Put someone in the jail channel and keep them there: ${p}jail <name> [minutes|2h|1d|forever] [reason]. ${p}unjail <name> lets them out (bot admins only)`,
        usage: `${p}jail <name> [minutes] [reason]`,
        perm: 'admin',
        run: async (ctx) => {
          const ch = jailChannel();
          if (!ch) return ctx.reply(`There's no channel called "${cfg.jailChannel}". Make one (and lock it so people can't just leave or join), or set modtools.jailChannel in config.json.`);
          if (!ctx.args.length) return ctx.reply(`Usage: ${p}jail <name> [minutes|2h|1d|forever] [reason]. ${p}jailed lists who is in jail.`);
          const hit = splitTarget(ctx.args, adapter.users());
          if (!hit) return ctx.reply(`I can't tell who "${ctx.args[0]}" is. Use more of their name; they need to be online.`);
          const u = hit.user;
          if (u.id === adapter.selfId) return ctx.reply("I'm not putting myself in jail.");
          if (bot.isAdmin(u.uid)) return ctx.reply("Bot admins can't be jailed.");
          let minutes = parseMinutes(hit.rest[0]);
          const reason = (minutes === undefined ? hit.rest : hit.rest.slice(1)).join(' ').trim().slice(0, 200);
          if (minutes === undefined) minutes = cfg.defaultMinutes;
          if (minutes > cfg.maxMinutes) return ctx.reply(`That's longer than the most allowed (${describeMinutes(cfg.maxMinutes)}).`);
          const now = Date.now();
          const entry: Jailed = { uid: u.uid, name: u.name, until: minutes === 0 ? 0 : now + minutes * 60_000, by: ctx.msg.senderName, reason, at: now };
          jail = [...jail.filter((j) => j.uid !== u.uid), entry];
          saveJail();
          log.info(`${ctx.msg.senderName} jailed ${u.name} (${describeMinutes(minutes)})${reason ? `: ${reason}` : ''}`);
          try {
            await adapter.moveUser(u.id, ch.id);
            lastMoved.set(u.uid, now);
          } catch (e) {
            return ctx.reply(`${u.name} is on the jail list, but I couldn't move them (${errMessage(e)}). I'll keep trying.`);
          }
          await adapter.sendPrivate(u.id, `You've been put in jail ${minutes === 0 ? 'until a staff member lets you out' : `for ${describeMinutes(minutes)}`}${reason ? `: ${reason}` : ''}. Leaving won't help: I'll bring you back.`).catch(() => undefined);
          return ctx.reply(`${u.name} is in "${ch.name}" ${minutes === 0 ? 'until you let them out' : `for ${describeMinutes(minutes)}`}. ${p}unjail ${u.name} lets them out early.`);
        },
      },
      {
        name: 'unjail',
        description: `Let someone out of jail: ${p}unjail <name> (bot admins only)`,
        usage: `${p}unjail <name>`,
        perm: 'admin',
        run: async (ctx) => {
          const q = ctx.rest.trim().toLowerCase();
          if (!q) return ctx.reply(`Usage: ${p}unjail <name>`);
          const j = jail.find((x) => x.name.toLowerCase() === q) ?? jail.find((x) => x.name.toLowerCase().includes(q));
          if (!j) return ctx.reply(`Nobody in jail matches "${ctx.rest.trim()}". ${p}jailed lists them.`);
          jail = jail.filter((x) => x !== j);
          saveJail();
          const u = adapter.users().find((x) => x.uid === j.uid);
          if (u) await adapter.sendPrivate(u.id, "You've been let out of jail. You're free to go.").catch(() => undefined);
          return ctx.reply(`${j.name} is out of jail.`);
        },
      },
      {
        name: 'jailed',
        description: `Who is in jail, and for how long (bot admins only)`,
        usage: `${p}jailed`,
        perm: 'admin',
        run: (ctx) => {
          if (!jail.length) return ctx.reply('Nobody is in jail.');
          return ctx.reply(
            ['In jail:', ...jail.map((j) => `${j.name}: ${j.until === 0 ? 'until let out' : `${Math.max(1, Math.ceil((j.until - Date.now()) / 60_000))} min left`} (by ${j.by}, ${formatAgo(j.at)})${j.reason ? ` - ${j.reason}` : ''}`)].join('\n'),
          );
        },
      },
      {
        name: 'report',
        description: `Tell the staff about a problem: ${p}report <name> <what happened>. It goes privately to the staff online, and is saved for the rest`,
        usage: `${p}report <name> <what happened>`,
        run: async (ctx) => {
          if (ctx.args.length < 2) return ctx.reply(`Usage: ${p}report <name> <what happened>, like ${p}report Bob spamming the music channel`);
          const now = Date.now();
          const last = lastReportBy.get(ctx.msg.senderUid);
          if (!ctx.isAdmin && last !== undefined && now - last < cfg.reportCooldownSeconds * 1000) return ctx.reply('You just sent a report. Give the staff a minute, then send another if you need to.');
          lastReportBy.set(ctx.msg.senderUid, now);
          const hit = splitTarget(ctx.args, adapter.users());
          const about = hit ? hit.user.name : ctx.args[0]!;
          const reason = (hit ? hit.rest : ctx.args.slice(1)).join(' ').trim().slice(0, 300) || '(no details)';
          const where = hit ? ` (in "${channelName(hit.user.channelId)}")` : '';
          const r: Report = { id: nextReport++, at: now, by: ctx.msg.senderName, byUid: ctx.msg.senderUid, about, reason };
          reports = [...reports, r].slice(-cfg.keepReports);
          saveReports();
          log.info(`report #${r.id} from ${r.by} about ${about}: ${reason}`);
          const staff = staffOnline().filter((s) => s.uid !== ctx.msg.senderUid);
          for (const s of staff) {
            await adapter.poke(s.id, `Report #${r.id}: ${ctx.msg.senderName} reported ${about}`).catch(() => undefined);
            await adapter.sendPrivate(s.id, `Report #${r.id} from ${ctx.msg.senderName} about ${about}${where}: ${reason}`).catch(() => undefined);
          }
          return ctx.reply(staff.length ? `Thanks. Your report went to ${staff.length} staff ${staff.length === 1 ? 'member' : 'members'} online.` : "Thanks. No staff are online right now, so it's saved for them to see.");
        },
      },
      {
        name: 'reports',
        description: `Recent reports from ${p}report: ${p}reports [clear] (bot admins only)`,
        usage: `${p}reports [clear]`,
        perm: 'admin',
        run: (ctx) => {
          if (ctx.args[0]?.toLowerCase() === 'clear') {
            reports = [];
            saveReports();
            return ctx.reply('Reports cleared.');
          }
          if (!reports.length) return ctx.reply('No reports.');
          return ctx.reply(['Recent reports (newest first):', ...[...reports].reverse().slice(0, 10).map((r) => `#${r.id} ${formatAgo(r.at)}: ${r.by} about ${r.about}: ${r.reason}`)].join('\n'));
        },
      },
      {
        name: 'meeting',
        description: `Bring all staff online into your channel (bot admins only)`,
        usage: `${p}meeting`,
        perm: 'admin',
        run: async (ctx) => {
          const me = await ctx.user();
          if (!me) return ctx.reply("I can't see where you are.");
          const others = staffOnline().filter((s) => s.uid !== me.uid && s.channelId !== me.channelId);
          if (!others.length) return ctx.reply('All the staff online are already here.');
          let moved = 0;
          for (const s of others) {
            try {
              await adapter.moveUser(s.id, me.channelId);
              await adapter.poke(s.id, `${me.name} called a staff meeting.`).catch(() => undefined);
              moved++;
            } catch (e) {
              log.debug(`could not move ${s.name}: ${errMessage(e)}`);
            }
          }
          return ctx.reply(`Brought ${moved} of ${others.length} staff to "${channelName(me.channelId)}".`);
        },
      },
    ],

    onLoad() {
      offDirectory = adapter.events.on('directory', () => void enforce());
      timer = setInterval(() => void enforce(), TICK_MS);
      timer.unref?.();
    },

    onUnload() {
      offDirectory?.();
      if (timer) clearInterval(timer);
    },

    status: () => `${jail.length} in jail, ${reports.length} reports kept`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createModToolsCog(bot);
export default factory;
