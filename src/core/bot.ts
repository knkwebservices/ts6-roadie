import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { IncomingMessage, TsAdapter } from '../adapter/types.js';
import type { Config } from '../config.js';
import type { Log } from '../logger.js';
import type { StateStore } from '../state.js';
import { TypedEmitter } from '../util/emitter.js';
import { writeJsonAtomic } from '../util/fs.js';
import { errMessage, parseCommandLine, stripBbcode } from '../util/text.js';
import { BOT_VERSION } from '../version.js';
import { CogManager } from './cogs.js';
import type { BotApi, BotEvents, CommandContext } from './types.js';

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

  async start(): Promise<void> {
    await this.cogs.loadAll(this.config.cogs);

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
    const parsed = parseCommandLine(stripBbcode(m.text), this.config.prefix);
    if (!parsed) return;
    const def = this.cogs.find(parsed.name);
    if (!def) return; // stay quiet on unknown commands - other bots share these channels

    const now = Date.now();
    const last = this.#lastCommandAt.get(m.senderUid) ?? 0;
    if (now - last < this.#cooldownMs) return;
    this.#lastCommandAt.set(m.senderUid, now);
    if (this.#lastCommandAt.size > 500) {
      for (const [k, t] of this.#lastCommandAt) if (now - t > 60_000) this.#lastCommandAt.delete(k);
    }

    const isAdmin = this.isAdmin(m.senderUid);
    const reply = async (text: string) => {
      try {
        await this.adapter.reply(m, text);
      } catch (e) {
        this.log.warn(`reply failed: ${errMessage(e)}`);
      }
    };

    if (def.perm === 'admin' && !isAdmin) {
      await reply('That command is for bot admins only.');
      return;
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
  }
}
