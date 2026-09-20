import type { IncomingMessage, TsAdapter, TsUser } from '../adapter/types.js';
import type { Config } from '../config.js';
import type { Log } from '../logger.js';
import type { StateStore } from '../state.js';
import type { TypedEmitter } from '../util/emitter.js';
import type { ServiceRegistry } from './services.js';

export type Perm = 'everyone' | 'admin';

export interface CommandContext {
  bot: BotApi;
  msg: IncomingMessage;
  /** The command name as typed (lower-cased, alias included). */
  name: string;
  args: string[];
  /** Raw text after the command name. */
  rest: string;
  isAdmin: boolean;
  reply(text: string): Promise<void>;
  /** The calling user, including their current channel (queried from the server if needed). */
  user(): Promise<TsUser | undefined>;
  /** True if the caller is in the same channel as the bot. */
  withBot(): Promise<boolean>;
}

export interface CommandDef {
  name: string;
  aliases?: string[];
  description: string;
  usage?: string;
  perm?: Perm;
  run(ctx: CommandContext): Promise<void> | void;
}

export interface CogManifest {
  name: string;
  version: string;
  description: string;
}

export interface Cog {
  commands: CommandDef[];
  onLoad?(): Promise<void> | void;
  onUnload?(): Promise<void> | void;
  /** One-line summary shown by !status. */
  status?(): Promise<string> | string;
}

export type CogFactory = (bot: BotApi) => Cog | Promise<Cog>;

/** Shape every cog's entry file must export. */
export interface CogModule {
  manifest: CogManifest;
  default: CogFactory;
}

export interface BotEvents {
  /** Connected (or reconnected) to TeamSpeak. */
  ready: [];
  lost: [reason: string];
}

/** What a cog is allowed to see of the bot. */
export interface BotApi {
  readonly config: Config;
  readonly adapter: TsAdapter;
  readonly state: StateStore;
  readonly log: Log;
  readonly dataDir: string;
  readonly events: TypedEmitter<BotEvents>;
  /** Lets cogs offer services to each other (see core/services.ts). */
  readonly services: ServiceRegistry;
  readonly startedAt: number;
  isAdmin(uid: string): boolean;
  /** All commands from all loaded cogs (for !help). */
  listCommands(): { cog: string; def: CommandDef }[];
  listCogs(): { manifest: CogManifest; loaded: boolean; source: 'builtin' | 'custom' }[];
  loadCog(name: string): Promise<CogManifest>;
  unloadCog(name: string): Promise<void>;
  reloadCog(name: string): Promise<CogManifest>;
  statusLines(): Promise<string[]>;
  /** Exit the process so the service manager (NSSM) starts a fresh one. */
  restart(): void;
}
