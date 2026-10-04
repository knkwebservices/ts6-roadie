import {
  Client,
  clientMove,
  dialFileTransfer,
  getClientInfo,
  listClients,
  poke as pokeClient,
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
import { applyFixes, computeFixes, emptyFixes, fixCount, type DirectoryFixes } from './directoryfix.js';
import { applyAvatar, clearAvatar as clearAvatarFlag, type AvatarIo } from './avatar.js';
import { hostFromAddress, sendOverTransfer } from './filetransfer.js';
import { parseGroupIds } from './groups.js';
import type { AdapterEvents, AvatarResult, IncomingMessage, MessageScope, TsAdapter, TsChannel, TsUser } from './types.js';

export interface TeamspeakAdapterOptions {
  address: string;
  password: string;
  nickname: string;
  homeChannel: string;
  homeChannelPassword: string;
  identity: Identity;
  selfUid: string;
  /** Clients that are not people (like the deploy smoke test) and are left out of users(). */
  ignore?: { nicknames?: string[]; uids?: string[] };
  log: Log;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CLIENT_TYPE_NORMAL = 0;
/** How often the client list is checked against the server's own answer (see directoryfix.ts). */
const RESYNC_MS = 20_000;

/** TsAdapter backed by @echosixhiya/teamspeak-client (clean-room TS3/TS5/TS6 protocol). */
export class TeamspeakAdapter implements TsAdapter {
  readonly events = new TypedEmitter<AdapterEvents>();
  readonly #o: TeamspeakAdapterOptions;
  readonly #log: Log;
  #client?: Client;
  #snapshot: DirectorySnapshot = { channels: [], clients: [] };
  /** Corrections from asking the server who is where (the library can miss a move). */
  #fixes: DirectoryFixes = emptyFixes();
  /** Bumped on every snapshot from the library, so a resync answer older than a notification is not used. */
  #snapGen = 0;
  /** Channels the bot has subscribed to (new channels need subscribing, or moves in and out of them are not heard). */
  #subscribed = new Set<bigint>();
  #subscribeTimer?: NodeJS.Timeout;
  #resyncBusy = false;
  #resyncFailures = 0;
  #lastFixCount = 0;
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
    this.#fixes = emptyFixes();
    this.#subscribed = new Set();
    this.#resyncFailures = 0;
    this.#lastFixCount = 0;

    let ended!: (reason: string) => void;
    const endedP = new Promise<string>((r) => (ended = r));

    client.on('disconnected', (err) => ended(err ? err.message : 'disconnected'));
    client.on('kicked', (msg) => ended(`kicked: ${msg || 'no reason given'}`));
    client.on('directorySnapshot', (s) => {
      this.#snapshot = s;
      this.#snapGen++;
      if (this.#connected && this.#subscribed.size && s.channels.some((c) => !this.#subscribed.has(c.id))) this.#subscribeSoon();
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
        senderGroups: parseGroupIds(m.invokerGroups),
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

    this.#subscribed = new Set(this.#snapshot.channels.map((c) => c.id));
    const resyncTimer = setInterval(() => void this.#resync(), RESYNC_MS);
    resyncTimer.unref?.();

    this.events.emit('connected');
    const reason = await endedP.finally(() => {
      clearInterval(resyncTimer);
      if (this.#subscribeTimer) clearTimeout(this.#subscribeTimer);
      this.#subscribeTimer = undefined;
    });

    this.#connected = false;
    this.#client = undefined;
    this.lastError = reason;
    this.#log.warn(`disconnected: ${reason}`);
    this.events.emit('disconnected', reason);
    await client.disconnect().catch(() => {});
  }

  /** A channel appeared (someone made one, or the bot did): subscribe to it too, then check the client list. */
  #subscribeSoon(): void {
    if (this.#subscribeTimer) return;
    this.#subscribeTimer = setTimeout(() => {
      this.#subscribeTimer = undefined;
      const c = this.#client;
      if (!c || !this.#connected) return;
      const ids = this.#snapshot.channels.map((ch) => ch.id);
      c.execCommand('channelsubscribeall', 5_000)
        .then(() => {
          this.#subscribed = new Set(ids);
          this.#log.debug(`subscribed to new channels (${ids.length} in all)`);
        })
        .catch((e) => this.#log.warn(`could not subscribe to a new channel: ${errMessage(e)}`))
        .finally(() => setTimeout(() => void this.#resync(), 1_500).unref?.());
    }, 500);
    this.#subscribeTimer.unref?.();
  }

  /** Ask the server who is where, and correct the client list if the library has fallen behind. */
  async #resync(): Promise<void> {
    const c = this.#client;
    if (!c || !this.#connected || this.#resyncBusy || this.#resyncFailures >= 3) return;
    this.#resyncBusy = true;
    const gen = this.#snapGen;
    try {
      const rows = await listClients(c);
      this.#resyncFailures = 0;
      if (gen !== this.#snapGen) return; // something changed while asking: the answer may be older, try next time
      const before = JSON.stringify(this.users(), (_k, v) => (typeof v === 'bigint' ? String(v) : v));
      this.#fixes = computeFixes(this.#snapshot.clients, rows);
      const n = fixCount(this.#fixes);
      if (n && n !== this.#lastFixCount) {
        const f = this.#fixes;
        this.#log.info(`the client list was out of date; corrected it from the server (${f.moved.size} moved, ${f.ghosts.size} gone, ${f.missing.size} not listed)`);
      }
      this.#lastFixCount = n;
      if (JSON.stringify(this.users(), (_k, v) => (typeof v === 'bigint' ? String(v) : v)) !== before) this.events.emit('directory');
    } catch (e) {
      this.#resyncFailures++;
      if (this.#resyncFailures === 1 || this.#resyncFailures === 3) this.#log.warn(`could not check the client list with the server: ${errMessage(e)}${this.#resyncFailures === 3 ? ' (giving up until the next reconnect)' : ''}`);
    } finally {
      this.#resyncBusy = false;
    }
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
    return applyFixes(this.#snapshot.clients, this.#fixes)
      .filter((c) => c.type === CLIENT_TYPE_NORMAL && c.id !== self && !this.#ignored(c.nickname, c.uid))
      .map((c) => ({
        id: c.id,
        uid: c.uid,
        name: c.nickname,
        channelId: c.channelID,
        groups: parseGroupIds(c.serverGroups),
        away: c.away,
        inputMuted: c.inputMuted,
        outputMuted: c.outputMuted,
      }));
  }

  #ignored(nickname: string, uid: string): boolean {
    const ig = this.#o.ignore;
    if (!ig) return false;
    return (!!uid && !!ig.uids?.includes(uid)) || !!ig.nicknames?.some((n) => n.toLowerCase() === nickname.toLowerCase());
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
        groups: info['client_servergroups'] !== undefined ? parseGroupIds(info['client_servergroups']) : (known?.groups ?? []),
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

  async moveUser(userId: number, channelId: bigint): Promise<void> {
    await clientMove(this.#need(), userId, channelId);
  }

  async renameChannel(channelId: bigint, name: string): Promise<void> {
    await this.#need().execCommand(buildCommand('channeledit', { cid: String(channelId), channel_name: name }), 10_000);
  }

  async setChannelMaxClients(channelId: bigint, max: number | null): Promise<void> {
    const props: Record<string, string> =
      max === null ? { cid: String(channelId), channel_flag_maxclients_unlimited: '1' } : { cid: String(channelId), channel_maxclients: String(Math.max(0, Math.round(max))), channel_flag_maxclients_unlimited: '0' };
    await this.#need().execCommand(buildCommand('channeledit', props), 10_000);
  }

  async renameServer(name: string): Promise<void> {
    await this.#need().execCommand(buildCommand('serveredit', { virtualserver_name: name }), 10_000);
  }

  async createTempChannel(opts: { name: string; parentId: bigint; deleteDelaySec: number }): Promise<bigint> {
    const c = this.#need();
    const rows = await c.execCommandWithResponse(
      buildCommand('channelcreate', {
        channel_name: opts.name,
        cpid: String(opts.parentId),
        channel_flag_permanent: '0',
        channel_flag_semi_permanent: '0',
        channel_delete_delay: String(Math.max(0, Math.round(opts.deleteDelaySec))),
      }),
      10_000,
    );
    // The server answers with the new channel's number, usually in the reply itself; if not, it shows
    // up in the channel list a moment later (names are unique among a parent's sub-channels).
    const fromReply = rows.map((r) => r['cid']).find((v) => v && /^\d+$/.test(v));
    if (fromReply) return BigInt(fromReply);
    const want = opts.name.trim().toLowerCase();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const found = this.channels().find((ch) => ch.parentId === opts.parentId && ch.name.trim().toLowerCase() === want);
      if (found) return found.id;
      await sleep(100);
    }
    throw new Error('the server did not report the new channel');
  }

  async createPermanentChannel(opts: { name: string; parentId: bigint }): Promise<bigint> {
    const c = this.#need();
    const rows = await c.execCommandWithResponse(
      buildCommand('channelcreate', { channel_name: opts.name, cpid: String(opts.parentId), channel_flag_permanent: '1' }),
      10_000,
    );
    const fromReply = rows.map((r) => r['cid']).find((v) => v && /^\d+$/.test(v));
    if (fromReply) return BigInt(fromReply);
    const want = opts.name.trim().toLowerCase();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const found = this.channels().find((ch) => ch.parentId === opts.parentId && ch.name.trim().toLowerCase() === want);
      if (found) return found.id;
      await sleep(100);
    }
    throw new Error('the server did not report the new channel');
  }

  async deleteChannel(channelId: bigint, force = false): Promise<void> {
    await this.#need().execCommand(buildCommand('channeldelete', { cid: String(channelId), force: force ? '1' : '0' }), 10_000);
  }

  async setChannelGroup(userId: number, channelId: bigint, channelGroupId: number): Promise<void> {
    const c = this.#need();
    const info = await getClientInfo(c, userId);
    const dbid = info['client_database_id'];
    if (!dbid) throw new Error('the server did not say who that is (no database ID)');
    await c.execCommand(buildCommand('setclientchannelgroup', { cgid: String(channelGroupId), cid: String(channelId), cldbid: dbid }), 10_000);
  }

  /** The person's database ID, which server-group commands need. */
  async #dbid(userId: number): Promise<string> {
    const info = await getClientInfo(this.#need(), userId);
    const dbid = info['client_database_id'];
    if (!dbid) throw new Error('the server did not say who that is (no database ID)');
    return dbid;
  }

  async addServerGroup(userId: number, groupId: number): Promise<void> {
    const dbid = await this.#dbid(userId);
    await this.#need().execCommand(buildCommand('servergroupaddclient', { sgid: String(groupId), cldbid: dbid }), 10_000);
  }

  async removeServerGroup(userId: number, groupId: number): Promise<void> {
    const dbid = await this.#dbid(userId);
    await this.#need().execCommand(buildCommand('servergroupdelclient', { sgid: String(groupId), cldbid: dbid }), 10_000);
  }

  async clientDetails(userId: number): Promise<{ info: Record<string, string>; connection: Record<string, string> | string }> {
    const c = this.#need();
    const info = await getClientInfo(c, userId);
    let connection: Record<string, string> | string;
    try {
      const rows = await c.execCommandWithResponse(buildCommand('getconnectioninfo', { clid: String(userId) }), 5_000);
      connection = Object.assign({}, ...rows) as Record<string, string>;
      if (!Object.keys(connection).length) connection = 'the server answered with nothing';
    } catch (e) {
      connection = errMessage(e);
    }
    return { info, connection };
  }

  async userGroups(userId: number): Promise<number[]> {
    const info = await getClientInfo(this.#need(), userId);
    return parseGroupIds(info['client_servergroups'] ?? '');
  }

  async idleSeconds(userId: number): Promise<number | undefined> {
    try {
      const info = await getClientInfo(this.#need(), userId);
      const ms = Number(info['client_idle_time']);
      return Number.isFinite(ms) && ms >= 0 ? Math.floor(ms / 1000) : undefined;
    } catch (e) {
      this.#log.debug(`idleSeconds(${userId}) query failed: ${errMessage(e)}`);
      return undefined;
    }
  }

  async sendPrivate(userId: number, text: string): Promise<void> {
    const c = this.#need();
    for (const part of chunkText(text)) await sendTextMessage(c, 1, BigInt(userId), part);
  }

  async sendServer(text: string): Promise<void> {
    const c = this.#need();
    for (const part of chunkText(text)) await sendTextMessage(c, 3, 0n, part);
  }

  async poke(userId: number, text: string): Promise<void> {
    await pokeClient(this.#need(), userId, text.slice(0, 100));
  }

  async kickUser(userId: number, reason: string): Promise<void> {
    // reasonid 5 = kicked from the server
    await this.#need().execCommand(buildCommand('clientkick', { clid: String(userId), reasonid: '5', reasonmsg: reason.slice(0, 80) }), 10_000);
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
