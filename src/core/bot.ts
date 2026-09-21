import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage, TsAdapter } from '../adapter/types.js';
import type { CommandRule, Config } from '../config.js';
import type { Log } from '../logger.js';
import type { StateStore } from '../state.js';
import { TypedEmitter } from '../util/emitter.js';
import { writeJsonAtomic } from '../util/fs.js';
import { errMessage, parseCommandLine, stripBbcode } from '../util/text.js';
import { BOT_VERSION } from '../version.js';
import { CogManager } from './cogs.js';
import { ServiceRegistry } from './services.js';
import type { BotApi, BotEvents, CommandContext, CommandDef } from './types.js';

export interface BotOptions {
  config: Config;
  adapter: TsAdapter;
  state: StateStore;
  log: Log;
  dataDir: string;
  /** Directory containing the bundled cogs. */
  builtinCogsDir: string;
  /** Called by !restart. Defaults to exiting the process. */
  onRestart?: () => void;
  /** Minimum ms between commands from the same user (anti-spam). */
  cooldownMs?: number;
}

/** Owns command dispatch, permissions and the cog lifecycle. */
export class Bot implements BotApi {
  readonly config: Config;
  readonly adapter: TsAdapter;
  readonly state: StateStore;
  readonly log: Log;
  readonly dataDir: string;
  readonly events = new TypedEmitter<BotEvents>();
  readonly services = new ServiceRegistry();
  readonly startedAt = Date.now();

  readonly cogs: CogManager;
  readonly #admins: Set<string>;
  readonly #cooldownMs: number;
  readonly #lastCommandAt = new Map<string, number>();
  readonly #onRestart: () => void;
  #healthTimer?: NodeJS.Timeout;
  #privilegeKeyTried = false;

  constructor(o: BotOptions) {
    this.config = o.config;
    this.adapter = o.adapter;
    this.state = o.state;
    this.log = o.log;
    this.dataDir = o.dataDir;
    this.#admins = new Set(o.config.admins);
    this.#cooldownMs = o.cooldownMs ?? 600;
    this.#onRestart = o.onRestart ?? (() => process.exit(0));
    this.events.onError = (e, ev) => this.log.error(`bot event "${ev}" listener threw`, e);
    this.cogs = new CogManager(() => this, this.log.child('cogs'), o.builtinCogsDir, join(o.dataDir, 'cogs'));
  }

  isAdmin(uid: string): boolean {
    return this.#admins.has(uid);
  }

  listCommands() {
    return this.cogs.commands();
  }
  listCogs() {
    return this.cogs.list();
  }
  loadCog(name: string) {
    return this.cogs.load(name);
  }
  unloadCog(name: string) {
    return this.cogs.unload(name);
  }
  reloadCog(name: string) {
    return this.cogs.reload(name);
  }
  statusLines() {
    return this.cogs.status();
  }
  restart(): void {
    this.log.warn('restart requested');
    setTimeout(() => this.#onRestart(), 500);
  }

  /** The rule for a command, looked up by its name or any of its aliases. */
  #ruleFor(def: CommandDef): CommandRule | undefined {
    const rules = this.config.permissions.commands;
    for (const n of [def.name, ...(def.aliases ?? [])]) if (Object.hasOwn(rules, n)) return rules[n];
    return undefined;
  }

  /** Rule names that match no loaded command or alias: almost always a typo. */
  unknownPermissionRules(): string[] {
    const known = new Set<string>();
    for (const { def } of this.cogs.commands()) for (const n of [def.name, ...(def.aliases ?? [])]) known.add(n);
    return Object.keys(this.config.permissions.commands).filter((n) => !known.has(n));
  }

  async start(): Promise<void> {
    await this.cogs.loadAll(this.config.cogs);
    for (const name of this.unknownPermissionRules()) {
      this.log.warn(`permissions.commands has a rule for "${name}", but no loaded command has that name (a typo, or its cog is not loaded)`);
    }

    this.adapter.events.on('message', (m) => this.#onMessage(m));
    this.adapter.events.on('connected', () => {
      this.events.emit('ready');
      void this.#redeemPrivilegeKey();
      this.#writeHealth();
    });
    this.adapter.events.on('disconnected', (reason) => {
      this.events.emit('lost', reason);
      this.#writeHealth();
    });

    // Deliberately NOT unref'd: this timer is what keeps the process alive while the
    // TeamSpeak connection is down and the adapter is waiting to retry.
    this.#healthTimer = setInterval(() => this.#writeHealth(), 10_000);
    this.#writeHealth();
    this.adapter.start();
  }

  async stop(): Promise<void> {
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    await this.cogs.unloadAll();
    await this.adapter.stop();
    this.#writeHealth(false);
  }

  // ---- health file (read by scripts/deploy.mjs to decide whether an update worked) --------

  #writeHealth(alive = true): void {
    try {
      writeJsonAtomic(join(this.dataDir, 'health.json'), {
        pid: process.pid,
        version: BOT_VERSION,
        startedAt: this.startedAt,
        updatedAt: Date.now(),
        alive,
        connected: alive && this.adapter.connected,
      });
    } catch (e) {
      this.log.debug(`could not write health file: ${errMessage(e)}`);
    }
  }

  // ---- first-run setup ---------------------------------------------------------------------

  async #redeemPrivilegeKey(): Promise<void> {
    const key = this.config.privilegeKey.trim();
    if (!key || this.#privilegeKeyTried) return;
    this.#privilegeKeyTried = true; // at most once per process; keys are single-use anyway
    const fingerprint = createHash('sha256').update(key).digest('hex').slice(0, 16);
    if (this.state.get<string>('privilegeKeyUsed', '') === fingerprint) return;
    try {
      await this.adapter.usePrivilegeKey(key);
      this.state.set('privilegeKeyUsed', fingerprint);
      this.log.info('privilege key redeemed - the bot now has its server group');
    } catch (e) {
      this.log.warn(
        `could not redeem privilege key (${errMessage(e)}). ` +
          'Assign the bot to its server group by hand in the TeamSpeak client, then clear "privilegeKey" in config.json.',
      );
    }
  }

  // ---- command dispatch --------------------------------------------------------------------

  async #onMessage(m: IncomingMessage): Promise<void> {
    await this.#dispatch(
      m,
      async (text) => {
        try {
          await this.adapter.reply(m, text);
        } catch (e) {
          this.log.warn(`reply failed: ${errMessage(e)}`);
        }
      },
    );
  }

  /**
   * Run a chat command as a user who is connected to TeamSpeak right now. The dashboard uses this, so
   * every button goes through exactly the same permission rules, cooldown and behaviour as typing the
   * command in chat: it can never do more than the person could do there.
   */
  async runCommandAs(uid: string, text: string): Promise<{ ok: boolean; replies: string[] }> {
    const user = this.adapter.users().find((u) => u.uid === uid);
    if (!user) return { ok: false, replies: ['You need to be connected to TeamSpeak to use the dashboard.'] };
    const replies: string[] = [];
    const msg: IncomingMessage = { scope: 'private', senderId: user.id, senderUid: user.uid, senderName: user.name, senderGroups: user.groups, text };
    const status = await this.#dispatch(msg, async (t) => void replies.push(t));
    if (status === 'notcommand') replies.push(`Commands start with "${this.config.prefix}".`);
    if (status === 'unknown') replies.push(`That is not a command I know. ${this.config.prefix}help lists them in chat.`);
    if (status === 'cooldown') replies.push('One moment, then try again.');
    return { ok: status === 'ran', replies };
  }

  async #dispatch(m: IncomingMessage, reply: (text: string) => Promise<void>): Promise<'ran' | 'denied' | 'unknown' | 'cooldown' | 'notcommand'> {
    const parsed = parseCommandLine(stripBbcode(m.text), this.config.prefix);
    if (!parsed) return 'notcommand';
    const def = this.cogs.find(parsed.name);
    if (!def) return 'unknown'; // in chat we stay quiet on unknown commands - other bots share these channels

    const now = Date.now();
    const last = this.#lastCommandAt.get(m.senderUid) ?? 0;
    if (now - last < this.#cooldownMs) return 'cooldown';
    this.#lastCommandAt.set(m.senderUid, now);
    if (this.#lastCommandAt.size > 500) {
      for (const [k, t] of this.#lastCommandAt) if (now - t > 60_000) this.#lastCommandAt.delete(k);
    }

    const isAdmin = this.isAdmin(m.senderUid);

    // Access: a configured rule replaces the command's built-in default. Bot admins always pass.
    const rule = this.#ruleFor(def);
    const allowed = rule
      ? isAdmin || (rule.uids ?? []).includes(m.senderUid) || (rule.groups ?? []).some((g) => m.senderGroups.includes(g))
      : def.perm !== 'admin' || isAdmin;
    if (!allowed) {
      await reply(rule ? `You don't have permission to use ${this.config.prefix}${def.name}.` : 'That command is for bot admins only.');
      return 'denied';
    }

    const ctx: CommandContext = {
      bot: this,
      msg: m,
      name: parsed.name,
      args: parsed.args,
      rest: parsed.rest,
      isAdmin,
      reply,
      user: () => this.adapter.locateUser(m.senderId),
      withBot: async () => {
        const u = await this.adapter.locateUser(m.senderId);
        return !!u && u.channelId !== 0n && u.channelId === this.adapter.selfChannelId();
      },
    };

    try {
      await def.run(ctx);
    } catch (e) {
      this.log.error(`command "${parsed.name}" from ${m.senderName} failed`, e);
      await reply('Something went wrong running that command. The details are in the bot log.');
    }
    return 'ran';
  }
}
