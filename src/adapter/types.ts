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
  reply(to: IncomingMessage, text: string): Promise<void>;
  sendChannel(text: string): Promise<void>;
  sendPrivate(userId: number, text: string): Promise<void>;
  /** Send one Opus frame. An empty frame marks the end of a transmission. */
  sendVoice(frame: Uint8Array, codec: number): void;
  /** Redeem a privilege key so the bot receives its server group. */
  usePrivilegeKey(token: string): Promise<void>;
  /** Set the bot's avatar (PNG, JPEG or GIF). Skips the upload if the server already shows this image, unless `force`. */
  setAvatar(image: Buffer, opts?: { force?: boolean }): Promise<AvatarResult>;
  /** Remove the bot's avatar. */
  clearAvatar(): Promise<void>;
}
