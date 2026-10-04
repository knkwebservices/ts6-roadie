import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AdapterEvents, IncomingMessage, TsAdapter, TsChannel, TsUser } from '../src/adapter/types.js';
import { buildConfig, type Config } from '../src/config.js';
import { Bot } from '../src/core/bot.js';
import { silentLog } from '../src/logger.js';
import { StateStore } from '../src/state.js';
import { TypedEmitter } from '../src/util/emitter.js';

export const SRC_COGS = resolve(import.meta.dirname, '../src/cogs');

export const CH = { home: 10n, a: 11n, b: 12n, staff: 13n };

/** In-memory TsAdapter that records everything the bot does. */
export class FakeAdapter implements TsAdapter {
  readonly events = new TypedEmitter<AdapterEvents>();
  connected = true;
  selfId = 1;
  chan: bigint = CH.home;
  chans: TsChannel[] = [
    { id: CH.home, name: 'Lobby', parentId: 0n },
    { id: CH.a, name: 'Gaming A', parentId: 0n },
    { id: CH.b, name: 'Gaming B', parentId: 0n },
    { id: CH.staff, name: 'Staff Room', parentId: 0n },
  ];
  userList: TsUser[] = [];
  sent: { kind: 'channel' | 'private' | 'server' | 'poke'; to?: number; text: string }[] = [];
  kicks: { id: number; reason: string }[] = [];
  failKick: Error | undefined;
  voice: { frame: Uint8Array; codec: number }[] = [];
  moves: bigint[] = [];
  failMove: Error | undefined;
  /** Moves of other people: who (client id) and where to. */
  userMoves: { id: number; to: bigint }[] = [];
  failMoveUser: Error | undefined;
  moveUserCalls = 0;
  /** Idle seconds the fake server reports per client id (missing = the server would not say). */
  idle = new Map<number, number>();
  idleCalls: number[] = [];
  privilegeKeys: string[] = [];
  started = false;
  avatarCalls: { bytes: Buffer; force: boolean }[] = [];
  avatarError: Error | undefined;
  avatarStatus: 'uploaded' | 'unchanged' = 'uploaded';
  avatarCleared = 0;
  clearError: Error | undefined;

  start() {
    this.started = true;
  }
  async stop() {
    this.started = false;
  }
  selfChannelId() {
    return this.chan;
  }
  channels() {
    return this.chans;
  }
  findChannel(name: string) {
    return this.chans.find((c) => c.name.toLowerCase() === name.toLowerCase());
  }
  users() {
    return this.userList;
  }
  usersInChannel(id: bigint) {
    return this.userList.filter((u) => u.channelId === id);
  }
  async locateUser(id: number) {
    return this.userList.find((u) => u.id === id);
  }
  async moveSelf(id: bigint) {
    if (this.failMove) throw this.failMove;
    this.moves.push(id);
    this.chan = id;
  }
  async moveUser(id: number, channelId: bigint) {
    this.moveUserCalls++;
    if (this.failMoveUser) throw this.failMoveUser;
    const u = this.userList.find((x) => x.id === id);
    if (!u) throw new Error('no such client');
    this.userMoves.push({ id, to: channelId });
    u.channelId = channelId;
  }
  /** Channel renames the bot made: which channel and the new name. */
  renames: { id: bigint; name: string }[] = [];
  failRename: Error | undefined;
  async renameChannel(id: bigint, name: string) {
    if (this.failRename) throw this.failRename;
    const ch = this.chans.find((c) => c.id === id);
    if (!ch) throw new Error('invalid channelID');
    this.renames.push({ id, name });
    ch.name = name;
  }
  /** Channel size limits the bot set (null = no limit), and server renames. */
  maxClients = new Map<bigint, number | null>();
  limitCalls: { id: bigint; max: number | null }[] = [];
  failLimit: Error | undefined;
  async setChannelMaxClients(id: bigint, max: number | null) {
    if (this.failLimit) throw this.failLimit;
    if (!this.chans.some((c) => c.id === id)) throw new Error('invalid channelID');
    this.limitCalls.push({ id, max });
    this.maxClients.set(id, max);
  }
  serverName = 'Test Server';
  serverRenames: string[] = [];
  failServerRename: Error | undefined;
  async renameServer(name: string) {
    if (this.failServerRename) throw this.failServerRename;
    this.serverRenames.push(name);
    this.serverName = name;
  }
  /** Temporary channels the bot created, and channel groups it handed out. */
  created: { id: bigint; name: string; parentId: bigint; deleteDelaySec: number }[] = [];
  failCreate: Error | undefined;
  /** Act like a server that moves whoever creates a channel into it. */
  moveCreatorIntoNewChannel = false;
  nextChannelId = 100n;
  channelGroups: { userId: number; channelId: bigint; groupId: number }[] = [];
  failChannelGroup: Error | undefined;
  async createTempChannel(opts: { name: string; parentId: bigint; deleteDelaySec: number }) {
    if (this.failCreate) throw this.failCreate;
    if (this.chans.some((c) => c.parentId === opts.parentId && c.name.toLowerCase() === opts.name.toLowerCase())) throw new Error('channel name is already in use');
    const id = this.nextChannelId++;
    this.chans.push({ id, name: opts.name, parentId: opts.parentId });
    this.created.push({ id, ...opts });
    if (this.moveCreatorIntoNewChannel) this.chan = id;
    return id;
  }
  deleted: bigint[] = [];
  failDelete: Error | undefined;
  async createPermanentChannel(opts: { name: string; parentId: bigint }) {
    if (this.failCreate) throw this.failCreate;
    const id = this.nextChannelId++;
    this.created.push({ id, name: opts.name, parentId: opts.parentId, deleteDelaySec: -1 });
    this.chans.push({ id, name: opts.name, parentId: opts.parentId });
    if (this.moveCreatorIntoNewChannel) this.chan = id;
    return id;
  }
  async deleteChannel(id: bigint, force = false) {
    if (this.failDelete) throw this.failDelete;
    if (!force && this.userList.some((u) => u.channelId === id)) throw new Error('channel not empty (id=772)');
    this.chans = this.chans.filter((c) => c.id !== id);
    this.deleted.push(id);
  }
  async setChannelGroup(userId: number, channelId: bigint, groupId: number) {
    if (this.failChannelGroup) throw this.failChannelGroup;
    this.channelGroups.push({ userId, channelId, groupId });
  }
  /** Server-group changes the bot made. */
  groupChanges: { userId: number; groupId: number; op: 'add' | 'remove' }[] = [];
  failGroupChange: Error | undefined;
  /** Act like a server whose client list never hears about group changes (only userGroups() is up to date). */
  lagGroupChanges = false;
  /** The server's real groups per client, when they differ from the client list (see lagGroupChanges). */
  realGroups = new Map<number, number[]>();
  userGroupsCalls = 0;
  async userGroups(id: number) {
    this.userGroupsCalls++;
    const u = this.userList.find((x) => x.id === id);
    if (!u) throw new Error('invalid clientID');
    return [...(this.realGroups.get(id) ?? u.groups)];
  }
  async addServerGroup(userId: number, groupId: number) {
    if (this.failGroupChange) throw this.failGroupChange;
    const u = this.userList.find((x) => x.id === userId);
    if (!u) throw new Error('no such client');
    const real = this.realGroups.get(userId) ?? u.groups;
    if (real.includes(groupId)) throw new Error('TeamSpeak server error: duplicate entry (id=2561)');
    this.groupChanges.push({ userId, groupId, op: 'add' });
    if (this.lagGroupChanges) {
      this.realGroups.set(userId, [...real, groupId]);
      return void this.events.emit('directory');
    }
    u.groups = [...u.groups, groupId];
  }
  async removeServerGroup(userId: number, groupId: number) {
    if (this.failGroupChange) throw this.failGroupChange;
    const u = this.userList.find((x) => x.id === userId);
    if (!u) throw new Error('no such client');
    const real = this.realGroups.get(userId) ?? u.groups;
    if (!real.includes(groupId)) throw new Error('TeamSpeak server error: empty result set (id=2563)');
    this.groupChanges.push({ userId, groupId, op: 'remove' });
    if (this.lagGroupChanges) {
      this.realGroups.set(userId, real.filter((g) => g !== groupId));
      return void this.events.emit('directory');
    }
    u.groups = u.groups.filter((g) => g !== groupId);
  }
  details = new Map<number, Record<string, string>>();
  async clientDetails(id: number) {
    const u = this.userList.find((x) => x.id === id);
    if (!u) throw new Error('no such client');
    return { info: { client_nickname: u.name, ...(this.details.get(id) ?? {}) }, connection: 'not supported' as Record<string, string> | string };
  }
  async idleSeconds(id: number) {
    this.idleCalls.push(id);
    return this.idle.get(id);
  }
  async reply(to: IncomingMessage, text: string) {
    if (to.scope === 'channel') return this.sendChannel(text);
    return this.sendPrivate(to.senderId, text);
  }
  async sendChannel(text: string) {
    this.sent.push({ kind: 'channel', text });
  }
  async sendPrivate(userId: number, text: string) {
    this.sent.push({ kind: 'private', to: userId, text });
  }
  async sendServer(text: string) {
    this.sent.push({ kind: 'server', text });
  }
  async poke(userId: number, text: string) {
    this.sent.push({ kind: 'poke', to: userId, text: text.slice(0, 100) });
  }
  async kickUser(id: number, reason: string) {
    if (this.failKick) throw this.failKick;
    if (!this.userList.some((u) => u.id === id)) throw new Error('invalid clientID');
    this.kicks.push({ id, reason });
    this.userList = this.userList.filter((u) => u.id !== id);
    this.events.emit('directory');
  }
  sendVoice(frame: Uint8Array, codec: number) {
    this.voice.push({ frame, codec });
  }
  async usePrivilegeKey(token: string) {
    this.privilegeKeys.push(token);
  }
  async setAvatar(image: Buffer, opts: { force?: boolean } = {}) {
    this.avatarCalls.push({ bytes: image, force: !!opts.force });
    if (this.avatarError) throw this.avatarError;
    return { status: this.avatarStatus, md5: 'test', bytes: image.length };
  }
  async clearAvatar() {
    if (this.clearError) throw this.clearError;
    this.avatarCleared++;
  }

  // ---- test conveniences ----
  addUser(id: number, name: string, channelId: bigint, uid = `uid-${name}`, groups: number[] = []): TsUser {
    const u: TsUser = { id, uid, name, channelId, groups };
    this.userList.push(u);
    return u;
  }
  say(user: TsUser, text: string, scope: IncomingMessage['scope'] = 'private'): void {
    this.events.emit('message', { scope, senderId: user.id, senderUid: user.uid, senderName: user.name, senderGroups: user.groups, text });
  }
  lastReply(): string {
    return this.sent.at(-1)?.text ?? '';
  }
}

export function makeConfig(over: Record<string, unknown> = {}): Config {
  return buildConfig({
    server: { address: 'localhost:9987', nickname: 'Test Bot', homeChannel: 'Lobby' },
    admins: ['uid-Admin'],
    cogs: ['core'],
    follow: { idleReturnSeconds: 0.05, aloneLeaveSeconds: 60 },
    ...over,
  });
}

export interface Harness {
  bot: Bot;
  adapter: FakeAdapter;
  dir: string;
  restarted: () => boolean;
  cleanup: () => void;
}

export async function makeBot(opts: { config?: Config; customCogs?: Record<string, string> } = {}): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'tsbot-test-'));
  mkdirSync(join(dir, 'cogs'), { recursive: true });
  for (const [name, code] of Object.entries(opts.customCogs ?? {})) {
    mkdirSync(join(dir, 'cogs', name), { recursive: true });
    writeFileSync(join(dir, 'cogs', name, 'index.mjs'), code);
  }
  const adapter = new FakeAdapter();
  let restarted = false;
  const bot = new Bot({
    config: opts.config ?? makeConfig(),
    adapter,
    state: new StateStore(dir),
    log: silentLog,
    dataDir: dir,
    builtinCogsDir: SRC_COGS,
    cooldownMs: 0,
    onRestart: () => {
      restarted = true;
    },
  });
  await bot.start();
  return {
    bot,
    adapter,
    dir,
    restarted: () => restarted,
    cleanup: () => {
      void bot.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Wait until `cond` is true (polling), or fail after `ms`. */
export async function until(cond: () => boolean, ms = 10_000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
