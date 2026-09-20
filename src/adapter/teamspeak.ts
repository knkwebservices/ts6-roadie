import {
  Client,
  clientMove,
  dialFileTransfer,
  getClientInfo,
  sendTextMessage,
  type DirectorySnapshot,
  type FileUploadInfo,
  type Identity,
  type Logger as LibLogger,
} from '@echosixhiya/teamspeak-client';
import { buildCommand } from '@echosixhiya/teamspeak-client/command';
import type { Log } from '../logger.js';
import { TypedEmitter } from '../util/emitter.js';
import { chunkText, errMessage, sleep } from '../util/text.js';
import { applyAvatar, clearAvatar as clearAvatarFlag, type AvatarIo } from './avatar.js';
import { hostFromAddress, sendOverTransfer } from './filetransfer.js';
import type { AdapterEvents, AvatarResult, IncomingMessage, MessageScope, TsAdapter, TsChannel, TsUser } from './types.js';

export interface TeamspeakAdapterOptions {
  address: string;
  password: string;
  nickname: string;
  homeChannel: string;
  homeChannelPassword: string;
  identity: Identity;
  selfUid: string;
  log: Log;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CLIENT_TYPE_NORMAL = 0;

/** TsAdapter backed by @echosixhiya/teamspeak-client (clean-room TS3/TS5/TS6 protocol). */
export class TeamspeakAdapter implements TsAdapter {
  readonly events = new TypedEmitter<AdapterEvents>();
  readonly #o: TeamspeakAdapterOptions;
  readonly #log: Log;
  #client?: Client;
  #snapshot: DirectorySnapshot = { channels: [], clients: [] };
  #running = false;
  #connected = false;
  #stopController = new AbortController();
  #loopDone?: Promise<void>;
  /** Why the most recent connection attempt or session failed (for diagnostics such as the smoke test). */
  lastError: string | undefined;

  constructor(options: TeamspeakAdapterOptions) {
    this.#o = options;
    this.#log = options.log;
    this.events.onError = (e, ev) => this.#log.error(`listener for "${ev}" threw`, e);
  }

  get connected(): boolean {
    return this.#connected;
  }

  get selfId(): number {
    return this.#client?.clientID() ?? 0;
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;
    this.#stopController = new AbortController();
    this.#loopDone = this.#loop();
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#stopController.abort();
    const c = this.#client;
    if (c) await c.disconnect().catch(() => {});
    await this.#loopDone?.catch(() => {});
  }

  // ---- connection loop ----------------------------------------------------

  async #loop(): Promise<void> {
    let attempt = 0;
    while (this.#running) {
      const t0 = Date.now();
      try {
        await this.#session();
      } catch (e) {
        this.lastError = errMessage(e);
        this.#log.warn(`connection attempt failed: ${this.lastError}`);
      }
      if (!this.#running) break;
      // Back off exponentially (1s..60s); a session that stayed up a while resets the ladder.
      attempt = Date.now() - t0 > 60_000 ? 0 : attempt + 1;
      const delay = Math.min(60_000, 1000 * 2 ** Math.min(attempt, 6));
      this.#log.info(`reconnecting in ${Math.round(delay / 1000)}s`);
      await sleep(delay, this.#stopController.signal);
    }
  }

  async #session(): Promise<void> {
    const o = this.#o;
    const client = new Client(o.identity, o.address, o.nickname, {
      serverPassword: o.password || undefined,
      defaultChannel: o.homeChannel || undefined,
      defaultChannelPassword: o.homeChannelPassword || undefined,
      logger: this.#libLogger(),
    });
    this.#client = client;
    this.#snapshot = { channels: [], clients: [] };

    let ended!: (reason: string) => void;
    const endedP = new Promise<string>((r) => (ended = r));

    client.on('disconnected', (err) => ended(err ? err.message : 'disconnected'));
    client.on('kicked', (msg) => ended(`kicked: ${msg || 'no reason given'}`));
    client.on('directorySnapshot', (s) => {
      this.#snapshot = s;
      this.events.emit('directory');
    });
    client.on('textMessage', (m) => {
      if (m.invokerID === client.clientID() || m.invokerUID === o.selfUid) return;
      const scope: MessageScope = m.targetMode === 1 ? 'private' : m.targetMode === 2 ? 'channel' : 'server';
      this.events.emit('message', {
        scope,
        senderId: m.invokerID,
        senderUid: m.invokerUID,
        senderName: m.invokerName,
        text: m.message,
      });
    });

    let timeout: NodeJS.Timeout | undefined;
    try {
      await client.connect();
      // Race the handshake against a drop (e.g. connection refused) and a timeout. The timer is a
      // normal ref'd one on purpose: it must keep the process alive while we wait.
      await Promise.race([
        client.waitConnected(),
        endedP.then((reason) => {
          throw new Error(`connection dropped during handshake: ${reason}`);
        }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`handshake timed out after ${CONNECT_TIMEOUT_MS / 1000}s`)), CONNECT_TIMEOUT_MS);
        }),
      ]);
    } catch (e) {
      await client.disconnect().catch(() => {});
      this.#client = undefined;
      throw e;
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    this.#connected = true;
    this.#log.info(`connected to ${o.address} as clid ${client.clientID()}`);

    // The library does not subscribe to other channels on its own. Without this the bot only
    // sees users in its own channel, which would break "follow the caller".
    await client.execCommand('channelsubscribeall', 5_000).catch((e) => {
      this.#log.warn(`channelsubscribeall failed (${errMessage(e)}); falling back to per-user lookups`);
    });

    this.events.emit('connected');
    const reason = await endedP;

    this.#connected = false;
    this.#client = undefined;
    this.lastError = reason;
    this.#log.warn(`disconnected: ${reason}`);
    this.events.emit('disconnected', reason);
    await client.disconnect().catch(() => {});
  }

  #libLogger(): LibLogger {
    const l = this.#log.child('ts');
    return {
      debug: (m, ...a) => l.debug(m, ...a),
      info: (m, ...a) => l.debug(m, ...a), // the library is chatty at info level
      warn: (m, ...a) => l.warn(m, ...a),
      error: (m, ...a) => l.error(m, ...a),
    };
  }

  #need(): Client {
    if (!this.#client || !this.#connected) throw new Error('not connected to TeamSpeak');
    return this.#client;
  }

  // ---- directory ------------------------------------------------------------

  selfChannelId(): bigint {
    const live = this.#client?.channelID();
    if (live) return live;
    return this.#snapshot.clients.find((c) => c.id === this.selfId)?.channelID ?? 0n;
  }

  channels(): TsChannel[] {
    return this.#snapshot.channels.map((c) => ({ id: c.id, name: c.name, parentId: c.parentID }));
  }

  findChannel(name: string): TsChannel | undefined {
    const want = name.trim().toLowerCase();
    return this.channels().find((c) => c.name.trim().toLowerCase() === want);
  }

  users(): TsUser[] {
    const self = this.selfId;
    return this.#snapshot.clients
      .filter((c) => c.type === CLIENT_TYPE_NORMAL && c.id !== self)
      .map((c) => ({ id: c.id, uid: c.uid, name: c.nickname, channelId: c.channelID }));
  }

  usersInChannel(channelId: bigint): TsUser[] {
    return this.users().filter((u) => u.channelId === channelId);
  }

  async locateUser(id: number): Promise<TsUser | undefined> {
    const known = this.users().find((u) => u.id === id);
    if (known && known.channelId !== 0n) return known;
    try {
      const info = await getClientInfo(this.#need(), id);
      const cid = BigInt(info['cid'] ?? '0');
      if (cid === 0n) return known;
      return {
        id,
        uid: info['client_unique_identifier'] ?? known?.uid ?? '',
        name: info['client_nickname'] ?? known?.name ?? '',
        channelId: cid,
      };
    } catch (e) {
      this.#log.debug(`locateUser(${id}) query failed: ${errMessage(e)}`);
      return known;
    }
  }

  // ---- actions ----------------------------------------------------------------

  async moveSelf(channelId: bigint, password = ''): Promise<void> {
    const c = this.#need();
    await clientMove(c, c.clientID(), channelId, password);
  }

  async sendPrivate(userId: number, text: string): Promise<void> {
    const c = this.#need();
    for (const part of chunkText(text)) await sendTextMessage(c, 1, BigInt(userId), part);
  }

  async sendChannel(text: string): Promise<void> {
    const c = this.#need();
    const cid = this.selfChannelId();
    for (const part of chunkText(text)) await sendTextMessage(c, 2, cid, part);
  }

  async reply(to: IncomingMessage, text: string): Promise<void> {
    // Server-wide chat is answered privately so the bot never spams everyone.
    if (to.scope === 'channel') return this.sendChannel(text);
    return this.sendPrivate(to.senderId, text);
  }

  sendVoice(frame: Uint8Array, codec: number): void {
    if (!this.#connected || !this.#client) return;
    this.#client.sendVoice(frame, codec);
  }

  async usePrivilegeKey(token: string): Promise<void> {
    await this.#need().execCommand(buildCommand('privilegekeyuse', { token }), 10_000);
  }

  // ---- avatar -------------------------------------------------------------------------------

  async setAvatar(image: Buffer, opts: { force?: boolean } = {}): Promise<AvatarResult> {
    return applyAvatar(this.#avatarIo(this.#need()), image, opts);
  }

  async clearAvatar(): Promise<void> {
    await clearAvatarFlag(this.#avatarIo(this.#need()));
  }

  #avatarIo(client: Client): AvatarIo<FileUploadInfo> {
    const host = hostFromAddress(this.#o.address);
    return {
      currentHash: async () => {
        try {
          const info = await getClientInfo(client, client.clientID());
          return info['client_flag_avatar'] ?? '';
        } catch {
          return undefined; // not allowed to read it: just upload
        }
      },
      // Avatars live in channel 0's file area, always under the name "/avatar" (overwrite = true).
      initUpload: (size) => client.fileTransferInitUpload(0n, '/avatar', '', BigInt(size), true),
      send: (info, bytes) => sendOverTransfer(dialFileTransfer, host, { port: info.port, key: info.fileTransferKey }, bytes),
      setFlag: (hash) => client.execCommand(buildCommand('clientupdate', { client_flag_avatar: hash }), 10_000),
    };
  }
}
