import type { TypedEmitter } from '../util/emitter.js';

/**
 * Everything the bot needs from TeamSpeak, expressed in our own terms.
 * The core and the cogs depend on THIS interface only - never on the protocol
 * library. If the library breaks against a new server build (or you swap it for
 * something else), only adapter/teamspeak.ts changes.
 */

export type MessageScope = 'private' | 'channel' | 'server';

export interface IncomingMessage {
  scope: MessageScope;
  senderId: number;
  senderUid: string;
  senderName: string;
  /** The sender's server-group IDs, as the server reports them. */
  senderGroups: number[];
  text: string;
}

export interface TsUser {
  id: number;
  uid: string;
  name: string;
  channelId: bigint;
  /** Server-group IDs. */
  groups: number[];
  /** Set to "away" in their client. */
  away?: boolean;
  /** Microphone muted. */
  inputMuted?: boolean;
  /** Speakers muted (deafened). */
  outputMuted?: boolean;
}

export interface TsChannel {
  id: bigint;
  name: string;
  parentId: bigint;
}

export interface AvatarResult {
  /** "unchanged" means the server already showed exactly this image, so nothing was uploaded. */
  status: 'uploaded' | 'unchanged';
  md5: string;
  bytes: number;
}

export interface AdapterEvents {
  connected: [];
  disconnected: [reason: string];
  message: [IncomingMessage];
  /** The channel/user directory changed (someone joined, left or moved). */
  directory: [];
}

export interface TsAdapter {
  readonly events: TypedEmitter<AdapterEvents>;
  readonly connected: boolean;
  readonly selfId: number;
  /** Begin connecting; reconnects automatically with backoff until stop() is called. */
  start(): void;
  stop(): Promise<void>;

  selfChannelId(): bigint;
  channels(): TsChannel[];
  findChannel(name: string): TsChannel | undefined;
  /** Human users the bot can currently see (excludes itself and query clients). */
  users(): TsUser[];
  usersInChannel(channelId: bigint): TsUser[];
  /** Look a user up, falling back to a server query if the directory doesn't know their channel yet. */
  locateUser(id: number): Promise<TsUser | undefined>;

  moveSelf(channelId: bigint, password?: string): Promise<void>;
  /** Move another client to a channel (needs the server's move permission). */
  moveUser(userId: number, channelId: bigint): Promise<void>;
  /** Rename a channel (needs the server's permission to change channel names). */
  renameChannel(channelId: bigint, name: string): Promise<void>;
  /** How many people a channel takes: a number (0 closes it to everyone without the ignore-limit permission), or null for no limit. */
  setChannelMaxClients(channelId: bigint, max: number | null): Promise<void>;
  /** Rename the virtual server (needs the server's permission to change the server name). */
  renameServer(name: string): Promise<void>;
  /**
   * Create a temporary channel, which the server deletes by itself once it has been empty for
   * `deleteDelaySec`. Resolves with the new channel's ID. (The server may move the bot into it.)
   */
  createTempChannel(opts: { name: string; parentId: bigint; deleteDelaySec: number }): Promise<bigint>;
  /** Create a permanent channel (it stays when empty). Resolves with the new channel's ID. (The server may move the bot into it.) */
  createPermanentChannel(opts: { name: string; parentId: bigint }): Promise<bigint>;
  /** Delete a channel. Without `force` the server refuses if anyone is in it. */
  deleteChannel(channelId: bigint, force?: boolean): Promise<void>;
  /** Put someone in a channel group for one channel (for example channel admin of their own room). */
  setChannelGroup(userId: number, channelId: bigint, channelGroupId: number): Promise<void>;
  /** Add an online person to a server group (needs enough group member add power). */
  addServerGroup(userId: number, groupId: number): Promise<void>;
  /** Take an online person out of a server group (needs enough group member remove power). */
  removeServerGroup(userId: number, groupId: number): Promise<void>;
  /**
   * Someone's server groups as the server says right now. (The groups in users() can be out of date:
   * the client list does not always hear about group changes made while someone is online.)
   */
  userGroups(userId: number): Promise<number[]>;
  /**
   * Everything the server tells the bot about one person, as raw name/value pairs: the client info answer,
   * plus the connection info answer when the server gives one. For diagnostics (!whois); nothing is stored.
   */
  clientDetails(userId: number): Promise<{ info: Record<string, string>; connection: Record<string, string> | string }>;
  /** How many seconds since this person last did anything, or undefined if the server would not say. */
  idleSeconds(userId: number): Promise<number | undefined>;
  reply(to: IncomingMessage, text: string): Promise<void>;
  sendChannel(text: string): Promise<void>;
  sendPrivate(userId: number, text: string): Promise<void>;
  /** Post in the server-wide chat, which everyone online can read wherever they are. */
  sendServer(text: string): Promise<void>;
  /** Poke someone: a pop-up message (TeamSpeak keeps pokes short, about 100 characters). */
  poke(userId: number, text: string): Promise<void>;
  /** Kick someone off the server with a reason (needs the server's kick permission). */
  kickUser(userId: number, reason: string): Promise<void>;
  /** Send one Opus frame. An empty frame marks the end of a transmission. */
  sendVoice(frame: Uint8Array, codec: number): void;
  /** Redeem a privilege key so the bot receives its server group. */
  usePrivilegeKey(token: string): Promise<void>;
  /** Set the bot's avatar (PNG, JPEG or GIF). Skips the upload if the server already shows this image, unless `force`. */
  setAvatar(image: Buffer, opts?: { force?: boolean }): Promise<AvatarResult>;
  /** Remove the bot's avatar. */
  clearAvatar(): Promise<void>;
}
