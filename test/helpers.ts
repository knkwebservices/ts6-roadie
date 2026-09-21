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
  sent: { kind: 'channel' | 'private'; to?: number; text: string }[] = [];
  voice: { frame: Uint8Array; codec: number }[] = [];
  moves: bigint[] = [];
  failMove: Error | undefined;
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
export async function until(cond: () => boolean, ms = 2000, what = 'condition'): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
