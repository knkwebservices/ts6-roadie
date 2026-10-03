import type { TsUser } from '../../adapter/types.js';
import type { BotApi, Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage } from '../../util/text.js';
import { isPrivateIp, lookupIp, LookupError, type IpVerdict } from './lookup.js';

export const manifest: CogManifest = {
  name: 'ipguard',
  version: '1.0.0',
  description: 'VPN/proxy, clone and country checks on people joining: tell admins, move or kick',
};

/** After connecting, the people already online are noted, not acted on. */
const WARMUP_MS = 3_000;
const VERDICT_TTL_MS = 24 * 3_600_000;
const MAX_CACHE = 1000;

export type GuardAction = 'warn' | 'move' | 'kick';

export interface GuardSettings {
  enabled: boolean;
  action: GuardAction;
  vpn: boolean;
  clones: boolean;
  /** How many people may be connected from one address. */
  maxPerIp: number;
  countryMode: 'off' | 'allow' | 'block';
  /** Two-letter country codes, upper case. */
  countries: string[];
  /** Unique IDs never checked (a friend who always uses a VPN, say). */
  exemptUids: string[];
}

export interface IpGuardDeps {
  lookup(ip: string, apiKey: string): Promise<IpVerdict>;
}

const defaultDeps: IpGuardDeps = { lookup: (ip, key) => lookupIp(ip, key) };

/** What is wrong with one connection, if anything: VPN, too many from one address, or the country. */
export function problemsFor(
  s: Pick<GuardSettings, 'vpn' | 'clones' | 'maxPerIp' | 'countryMode' | 'countries'>,
  facts: { country: string; sameIp: number; verdict?: IpVerdict },
): string[] {
  const out: string[] = [];
  const c = facts.country.toUpperCase();
  if (c && s.countryMode === 'allow' && !s.countries.includes(c)) out.push(`connecting from a country that isn't allowed (${c})`);
  if (c && s.countryMode === 'block' && s.countries.includes(c)) out.push(`connecting from a blocked country (${c})`);
  if (s.vpn && facts.verdict?.flagged) out.push(`using a VPN or proxy${facts.verdict.type ? ` (${facts.verdict.type}${facts.verdict.provider ? `, ${facts.verdict.provider}` : ''})` : ''}`);
  if (s.clones && facts.sameIp > s.maxPerIp) out.push(`connected ${facts.sameIp} times from the same address (the limit is ${s.maxPerIp})`);
  return out;
}

export function createIpGuardCog(bot: BotApi, deps: IpGuardDeps = defaultDeps): Cog {
  const cfg = bot.config.ipguard;
  const p = bot.config.prefix;
  const log = bot.log.child('ipguard');
  const adapter = bot.adapter;

  let s = bot.state.get<GuardSettings>('ipguard.settings', {
    enabled: cfg.enabled,
    action: cfg.action,
    vpn: cfg.vpn,
    clones: cfg.clones,
    maxPerIp: cfg.maxPerIp,
    countryMode: cfg.countryMode,
    countries: cfg.countries.map((c) => c.toUpperCase()),
    exemptUids: cfg.exemptUids,
  });
  const save = (): void => bot.state.set('ipguard.settings', s);

  /** VPN answers by address, kept between restarts so the free daily allowance goes a long way. */
  let cache = bot.state.get<Record<string, { at: number; v: IpVerdict }>>('ipguard.cache', {});
  /** Client number -> address, for everyone checked (to count clones). Never shown to anyone but admins asking. */
  const ipOf = new Map<number, string>();
  const checked = new Set<number>();
  let warm = false;
  let queue: Promise<void> = Promise.resolve();
  let lookupsToday = 0;
  let lookupDay = new Date().toDateString();
  let lastError: string | undefined;
  let caught = 0;
  let offDirectory: (() => void) | undefined;
  let offReady: (() => void) | undefined;
  let warmTimer: NodeJS.Timeout | undefined;

  const exempt = (u: TsUser): boolean => bot.isAdmin(u.uid) || s.exemptUids.includes(u.uid) || u.groups.some((g) => cfg.exemptGroups.includes(g));

  async function verdictFor(ip: string): Promise<IpVerdict | undefined> {
    if (isPrivateIp(ip)) return undefined;
    const hit = cache[ip];
    const now = Date.now();
    if (hit && now - hit.at < VERDICT_TTL_MS) return hit.v;
    const today = new Date().toDateString();
    if (today !== lookupDay) (lookupDay = today), (lookupsToday = 0);
    lookupsToday++;
    try {
      const v = await deps.lookup(ip, cfg.apiKey);
      lastError = undefined;
      cache[ip] = { at: now, v };
      const keys = Object.keys(cache);
      if (keys.length > MAX_CACHE) {
        cache = Object.fromEntries(Object.entries(cache).sort((a, b) => b[1].at - a[1].at).slice(0, MAX_CACHE));
      }
      bot.state.set('ipguard.cache', cache);
      return v;
    } catch (e) {
      lastError = e instanceof LookupError ? e.message : errMessage(e);
      log.warn(`VPN check for a joining client failed: ${lastError}`);
      return undefined;
    }
  }

  function tellAdmins(text: string): void {
    for (const a of adapter.users().filter((u) => bot.isAdmin(u.uid))) adapter.sendPrivate(a.id, text).catch((e) => log.debug(`could not tell ${a.name}: ${errMessage(e)}`));
  }

  /** Learn someone's address and country, and (if `act`) do something about what's wrong. */
  async function check(u: TsUser, act: boolean): Promise<{ country: string; ip: string; problems: string[]; verdict?: IpVerdict } | undefined> {
    let info: Record<string, string>;
    try {
      info = (await adapter.clientDetails(u.id)).info;
    } catch (e) {
      log.debug(`could not ask about ${u.name}: ${errMessage(e)}`);
      return undefined;
    }
    const ip = (info['connection_client_ip'] ?? '').trim();
    const country = (info['client_country'] ?? '').trim().toUpperCase();
    if (ip) ipOf.set(u.id, ip);
    const online = new Set(adapter.users().map((x) => x.id));
    const sameIp = ip && !isPrivateIp(ip) ? [...ipOf].filter(([id, a]) => a === ip && online.has(id)).length : 0;
    const verdict = s.vpn && ip ? await verdictFor(ip) : undefined;
    const problems = problemsFor(s, { country, sameIp, verdict });
    if (act && problems.length && !exempt(u)) await enforce(u, problems);
    return { country, ip, problems, verdict };
  }

  async function enforce(u: TsUser, problems: string[]): Promise<void> {
    caught++;
    const why = problems.join('; ');
    log.info(`${u.name}: ${why} (${s.action})`);
    if (s.action === 'kick') {
      try {
        await adapter.kickUser(u.id, problems[0]!.slice(0, 80));
        tellAdmins(`IP guard: kicked ${u.name}: ${why}.`);
      } catch (e) {
        tellAdmins(`IP guard: ${u.name} is ${why}, but I couldn't kick them (${errMessage(e)}).`);
      }
      return;
    }
    if (s.action === 'move') {
      const ch = adapter.findChannel(cfg.moveChannel);
      if (ch) {
        try {
          await adapter.moveUser(u.id, ch.id);
          tellAdmins(`IP guard: moved ${u.name} to "${ch.name}": ${why}.`);
          return;
        } catch (e) {
          tellAdmins(`IP guard: ${u.name} is ${why}, but I couldn't move them (${errMessage(e)}).`);
          return;
        }
      }
      tellAdmins(`IP guard: ${u.name} is ${why}, but there's no channel called "${cfg.moveChannel}".`);
      return;
    }
    tellAdmins(`IP guard: ${u.name} is ${why}. (${p}ipguard exempt ${u.name} if that's fine.)`);
  }

  function onDirectory(): void {
    const users = adapter.users();
    const online = new Set(users.map((u) => u.id));
    for (const id of [...checked]) if (!online.has(id)) (checked.delete(id), ipOf.delete(id));
    if (!warm) return;
    for (const u of users) {
      if (checked.has(u.id)) continue;
      checked.add(u.id);
      if (!s.enabled) continue;
      // one at a time, so a crowd joining at once doesn't burst the lookup service
      queue = queue.then(() => check(u, true).then(() => undefined)).catch((e) => log.debug(`check failed: ${errMessage(e)}`));
    }
  }

  const findOnline = (text: string): TsUser | undefined => {
    const q = text.trim().toLowerCase();
    const online = adapter.users();
    return q ? (online.find((u) => u.name.toLowerCase() === q) ?? online.find((u) => u.name.toLowerCase().includes(q))) : undefined;
  };

  const describe = (): string =>
    [
      `The IP guard is ${s.enabled ? 'ON' : 'off'}. When someone joins: ${s.action === 'kick' ? 'kick' : s.action === 'move' ? `move to "${cfg.moveChannel}"` : 'tell the admins'}.`,
      `VPN/proxy check: ${s.vpn ? 'on' : 'off'} (proxycheck.io${cfg.apiKey ? ', with a key' : ', no key: about 100 checks a day'}; ${lookupsToday} today${lastError ? `; last problem: ${lastError}` : ''}).`,
      `Clones: ${s.clones ? `on, at most ${s.maxPerIp} from one address` : 'off'}.`,
      `Countries: ${s.countryMode === 'off' ? 'off' : `${s.countryMode === 'allow' ? 'only' : 'not'} ${s.countries.join(', ') || '(none listed)'}`}.`,
      `Caught since I started: ${caught}. Bot admins${cfg.exemptGroups.length ? `, groups ${cfg.exemptGroups.join(', ')}` : ''} and ${s.exemptUids.length} exempt ${s.exemptUids.length === 1 ? 'person' : 'people'} are never checked. People on the same network as the server are never looked up.`,
    ].join('\n');

  const cog: Cog = {
    commands: [
      {
        name: 'ipguard',
        aliases: ['vpnguard'],
        description: `VPN/proxy, clone and country checks: ${p}ipguard [on|off|action warn|move|kick|vpn on|off|clones on|off|max <n>|countries off|allow <codes>|block <codes>|exempt <name>|unexempt <name>|check <name>] (bot admins only)`,
        usage: `${p}ipguard [on|off|action ...|vpn ...|clones ...|max <n>|countries ...|exempt <name>|unexempt <name>|check <name>]`,
        perm: 'admin',
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          const arg = ctx.args[1]?.toLowerCase();
          const rest = ctx.args.slice(1).join(' ');
          if (!sub) return ctx.reply(describe());
          if (sub === 'on' || sub === 'off') {
            s = { ...s, enabled: sub === 'on' };
            save();
            return ctx.reply(`The IP guard is ${sub}.${sub === 'on' ? ` People joining from now on are checked; ${s.action === 'warn' ? 'admins are told, nobody is moved or kicked' : `they will be ${s.action === 'kick' ? 'kicked' : 'moved'}`}.` : ''}`);
          }
          if (sub === 'action') {
            if (arg !== 'warn' && arg !== 'move' && arg !== 'kick') return ctx.reply(`Usage: ${p}ipguard action warn|move|kick`);
            s = { ...s, action: arg };
            save();
            return ctx.reply(`From now on I'll ${arg === 'kick' ? 'kick' : arg === 'move' ? `move them to "${cfg.moveChannel}"` : 'just tell the admins'}.`);
          }
          if (sub === 'vpn' || sub === 'clones') {
            if (arg !== 'on' && arg !== 'off') return ctx.reply(`Usage: ${p}ipguard ${sub} on|off`);
            s = { ...s, [sub]: arg === 'on' };
            save();
            return ctx.reply(`${sub === 'vpn' ? 'The VPN/proxy check' : 'The clone check'} is ${arg}.`);
          }
          if (sub === 'max') {
            const n = Number(arg);
            if (!Number.isInteger(n) || n < 1 || n > 20) return ctx.reply(`Usage: ${p}ipguard max <1-20>, how many may connect from one address`);
            s = { ...s, maxPerIp: n };
            save();
            return ctx.reply(`At most ${n} from one address.${s.clones ? '' : ` (Clone checks are off: ${p}ipguard clones on)`}`);
          }
          if (sub === 'countries') {
            if (arg === 'off') {
              s = { ...s, countryMode: 'off' };
              save();
              return ctx.reply('Country checks are off.');
            }
            const codes = ctx.args.slice(2).flatMap((x) => x.split(',')).map((x) => x.trim().toUpperCase()).filter(Boolean);
            if ((arg !== 'allow' && arg !== 'block') || !codes.length || codes.some((c) => !/^[A-Z]{2}$/.test(c)))
              return ctx.reply(`Usage: ${p}ipguard countries allow US CA GB (only these), ${p}ipguard countries block XX YY (all but these), or ${p}ipguard countries off. Use two-letter country codes.`);
            s = { ...s, countryMode: arg, countries: [...new Set(codes)].slice(0, 100) };
            save();
            return ctx.reply(arg === 'allow' ? `Only people connecting from ${s.countries.join(', ')} are allowed.` : `People connecting from ${s.countries.join(', ')} are blocked.`);
          }
          if (sub === 'exempt' || sub === 'unexempt') {
            const u = findOnline(rest);
            if (!u) return ctx.reply(`Nobody online matches "${rest}". (They need to be online so I can see their unique ID.)`);
            s = { ...s, exemptUids: sub === 'exempt' ? [...new Set([...s.exemptUids, u.uid])].slice(-500) : s.exemptUids.filter((x) => x !== u.uid) };
            save();
            return ctx.reply(sub === 'exempt' ? `${u.name} is never checked now.` : `${u.name} is checked like everyone else again.`);
          }
          if (sub === 'check') {
            const u = findOnline(rest);
            if (!u) return ctx.reply(`Nobody online matches "${rest}".`);
            const r = await check(u, false);
            if (!r) return ctx.reply(`The server wouldn't tell me about ${u.name}.`);
            const v = r.verdict;
            const tell = [
              `${u.name}: country ${r.country || 'unknown (same network as the server?)'}.`,
              !r.ip || isPrivateIp(r.ip) ? 'Address: on the same network as the server, so not looked up.' : v ? `VPN/proxy: ${v.flagged ? 'YES' : 'no'}${v.type ? ` (${v.type}${v.provider ? `, ${v.provider}` : ''})` : ''}.` : `VPN/proxy: ${s.vpn ? `couldn't check${lastError ? ` (${lastError})` : ''}` : 'check is off'}.`,
              r.problems.length ? `Would be caught for: ${r.problems.join('; ')}${exempt(u) ? ' (but they are exempt)' : ''}.` : 'Nothing wrong.',
            ];
            return adapter.sendPrivate(ctx.msg.senderId, tell.join('\n')).catch(() => ctx.reply(tell.join('\n')));
          }
          return ctx.reply(`Usage: ${p}ipguard [on|off|action warn|move|kick|vpn on|off|clones on|off|max <n>|countries off|allow <codes>|block <codes>|exempt <name>|unexempt <name>|check <name>]`);
        },
      },
    ],

    onLoad() {
      offDirectory = adapter.events.on('directory', onDirectory);
      const startWarm = (): void => {
        warm = false;
        checked.clear();
        ipOf.clear();
        if (warmTimer) clearTimeout(warmTimer);
        warmTimer = setTimeout(() => {
          // the people already here are noted (so clones can be counted), never acted on
          for (const u of adapter.users()) {
            checked.add(u.id);
            adapter
              .clientDetails(u.id)
              .then((d) => {
                const ip = (d.info['connection_client_ip'] ?? '').trim();
                if (ip) ipOf.set(u.id, ip);
              })
              .catch(() => undefined);
          }
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

    status: () => `IP guard ${s.enabled ? `on (${s.action}, ${caught} caught, ${lookupsToday} lookups today)` : 'off'}`,
  };
  return cog;
}

const factory: CogFactory = (bot) => createIpGuardCog(bot);
export default factory;
