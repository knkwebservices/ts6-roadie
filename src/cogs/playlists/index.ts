import { join } from 'node:path';
import { AUDIO_SERVICE, PLAYLISTS_SERVICE, type AudioService, type PlaylistsService, type QueueItem } from '../../core/services.js';
import type { Cog, CogFactory, CogManifest, CommandContext } from '../../core/types.js';
import { Mutex } from '../../util/mutex.js';
import { errMessage, formatDuration } from '../../util/text.js';
import { PlaylistStore, validName, type Playlist, type StoredTrack } from './store.js';

export const manifest: CogManifest = {
  name: 'playlists',
  version: '1.1.0',
  description: 'Save what is queued as a named playlist, edit it, and load it again with one command',
};

const toStored = (t: QueueItem): StoredTrack => ({ kind: t.kind, title: t.title, url: t.url, durationSec: t.durationSec });

const factory: CogFactory = (bot): Cog => {
  const p = bot.config.prefix;
  const limits = bot.config.playlists;
  const store = new PlaylistStore(join(bot.dataDir, 'playlists.json'), bot.log.child('playlists'));
  const lock = new Mutex(); // edits are read-modify-write; keep them one at a time

  const nameHelp = `A playlist name is 1-32 letters, numbers, spaces or _ . ' - characters. Example: ${p}playlist save friday night`;
  const usage = [
    `${p}playlist save <name>          - save what is playing and queued`,
    `${p}playlist load <name>          - queue a saved playlist`,
    `${p}playlist list                 - all saved playlists`,
    `${p}playlist show <name>          - the tracks in one`,
    `${p}playlist add <name> | <link or search words> - add tracks (creates the playlist if new)`,
    `${p}playlist remove <name> <position>`,
    `${p}playlist move <name> <from> <to>`,
    `${p}playlist rename <old name> > <new name>`,
    `${p}playlist delete <name>        - remove one`,
    'Only a playlist\'s owner or a bot admin can change or delete it.',
  ].join('\n');

  const audio = (): AudioService | undefined => bot.services.get<AudioService>(AUDIO_SERVICE);
  const canModify = (ctx: CommandContext, pl: Playlist): boolean => ctx.isAdmin || pl.ownerUid === ctx.msg.senderUid;
  const summary = (pl: Playlist): string => `${pl.name} (${pl.tracks.length} track${pl.tracks.length === 1 ? '' : 's'}, by ${pl.ownerName || 'unknown'})`;
  const plural = (n: number): string => `${n} track${n === 1 ? '' : 's'}`;

  /** Reply and return false unless the caller may change this playlist. */
  async function mayChange(ctx: CommandContext, pl: Playlist): Promise<boolean> {
    if (canModify(ctx, pl)) return true;
    await ctx.reply(`"${pl.name}" belongs to ${pl.ownerName || 'someone else'}. Only its owner or a bot admin can change it.`);
    return false;
  }

  /** A playlist the caller named, or a reply explaining why not. */
  async function find(ctx: CommandContext, name: string, what: string): Promise<Playlist | undefined> {
    const pl = name ? store.get(name) : undefined;
    if (!pl) await ctx.reply(name ? `No playlist called "${name}". ${p}playlist list shows them all.` : `Usage: ${p}playlist ${what} <name>`);
    return pl;
  }

  async function save(ctx: CommandContext, name: string): Promise<void> {
    if (!validName(name)) return void (await ctx.reply(nameHelp));
    const svc = audio();
    if (!svc) return void (await ctx.reply('The audio cog is not loaded, so there is nothing to save.'));

    await lock.run(async () => {
      const snap = svc.snapshot();
      const tracks = [...(snap.current ? [snap.current] : []), ...snap.upcoming].map(toStored);
      if (!tracks.length) return void (await ctx.reply(`Nothing is playing or queued yet. Queue some songs with ${p}play first.`));

      const existing = store.get(name);
      if (existing && !(await mayChange(ctx, existing))) return;
      if (!existing && store.size >= limits.maxPlaylists) {
        return void (await ctx.reply(`The server already has ${limits.maxPlaylists} playlists. Delete one first with ${p}playlist delete <name>.`));
      }

      const kept = tracks.slice(0, limits.maxTracks);
      const now = Date.now();
      store.put({
        name: existing?.name ?? name,
        // an admin overwriting keeps the original owner
        ownerUid: existing?.ownerUid ?? ctx.msg.senderUid,
        ownerName: existing?.ownerName ?? ctx.msg.senderName,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        tracks: kept,
      });
      const cut = tracks.length - kept.length;
      await ctx.reply(
        `${existing ? 'Updated' : 'Saved'} "${existing?.name ?? name}" with ${plural(kept.length)}.` +
          (cut > 0 ? ` (${cut} more were left out: the limit is ${limits.maxTracks} per playlist.)` : ''),
      );
    });
  }

  async function load(ctx: CommandContext, name: string): Promise<void> {
    const pl = await find(ctx, name, 'load');
    if (!pl) return;
    const svc = audio();
    if (!svc) return void (await ctx.reply('The audio cog is not loaded, so I cannot play anything.'));
    if (!pl.tracks.length) return void (await ctx.reply(`"${pl.name}" is empty.`));
    await svc.queue(ctx, pl.tracks, { label: pl.name });
  }

  async function add(ctx: CommandContext, rest: string): Promise<void> {
    const bar = rest.indexOf('|');
    const plName = (bar < 0 ? rest : rest.slice(0, bar)).trim();
    const query = bar < 0 ? '' : rest.slice(bar + 1).trim();
    if (!plName || !query) return void (await ctx.reply(`Usage: ${p}playlist add <name> | <link or search words>`));
    if (!validName(plName)) return void (await ctx.reply(nameHelp));
    const svc = audio();
    if (!svc) return void (await ctx.reply('The audio cog is not loaded, so I cannot look anything up.'));

    // Check before the (slow) lookup so nobody waits for a request that will be refused.
    const early = store.get(plName);
    if (early && !(await mayChange(ctx, early))) return;

    let found: QueueItem[];
    try {
      found = await svc.resolve(query);
    } catch (e) {
      return void (await ctx.reply(errMessage(e)));
    }

    await lock.run(async () => {
      // State may have changed during the lookup, so check again.
      const existing = store.get(plName);
      if (existing && !(await mayChange(ctx, existing))) return;
      if (!existing && store.size >= limits.maxPlaylists) {
        return void (await ctx.reply(`The server already has ${limits.maxPlaylists} playlists. Delete one first with ${p}playlist delete <name>.`));
      }
      const have = existing?.tracks.length ?? 0;
      const room = limits.maxTracks - have;
      if (room <= 0) return void (await ctx.reply(`"${existing!.name}" already has ${limits.maxTracks} tracks, which is the limit.`));

      const added = found.slice(0, room).map(toStored);
      const now = Date.now();
      store.put({
        name: existing?.name ?? plName,
        ownerUid: existing?.ownerUid ?? ctx.msg.senderUid,
        ownerName: existing?.ownerName ?? ctx.msg.senderName,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        tracks: [...(existing?.tracks ?? []), ...added],
      });
      const left = found.length - added.length;
      await ctx.reply(
        `Added ${added.length === 1 ? `"${added[0]!.title}"` : plural(added.length)} to "${existing?.name ?? plName}" (${plural(have + added.length)} now).` +
          (left > 0 ? ` (${left} left out: the limit is ${limits.maxTracks} per playlist.)` : ''),
      );
    });
  }

  async function remove(ctx: CommandContext, rest: string): Promise<void> {
    const m = /^(.*\S)\s+(\d+)$/.exec(rest);
    if (!m) return void (await ctx.reply(`Usage: ${p}playlist remove <name> <position>  (${p}playlist show <name> lists the positions)`));
    await lock.run(async () => {
      const pl = await find(ctx, m[1]!, 'remove');
      if (!pl || !(await mayChange(ctx, pl))) return;
      const at = Number(m[2]);
      if (at < 1 || at > pl.tracks.length) return void (await ctx.reply(`"${pl.name}" has ${plural(pl.tracks.length)}. Give a position from 1 to ${pl.tracks.length}.`));
      const tracks = [...pl.tracks];
      const [gone] = tracks.splice(at - 1, 1);
      store.put({ ...pl, tracks, updatedAt: Date.now() });
      await ctx.reply(`Removed "${gone!.title}" from "${pl.name}" (${plural(tracks.length)} left).`);
    });
  }

  async function move(ctx: CommandContext, rest: string): Promise<void> {
    const m = /^(.*\S)\s+(\d+)\s+(\d+)$/.exec(rest);
    if (!m) return void (await ctx.reply(`Usage: ${p}playlist move <name> <from> <to>`));
    await lock.run(async () => {
      const pl = await find(ctx, m[1]!, 'move');
      if (!pl || !(await mayChange(ctx, pl))) return;
      const from = Number(m[2]);
      const to = Number(m[3]);
      const n = pl.tracks.length;
      if (from < 1 || from > n || to < 1 || to > n) return void (await ctx.reply(`"${pl.name}" has ${plural(n)}. Positions go from 1 to ${n}.`));
      const tracks = [...pl.tracks];
      const [t] = tracks.splice(from - 1, 1);
      tracks.splice(to - 1, 0, t!);
      store.put({ ...pl, tracks, updatedAt: Date.now() });
      await ctx.reply(`Moved "${t!.title}" from ${from} to ${to} in "${pl.name}".`);
    });
  }

  async function rename(ctx: CommandContext, rest: string): Promise<void> {
    const parts = rest.split('>').map((s) => s.trim());
    if (parts.length !== 2 || !parts[0] || !parts[1]) return void (await ctx.reply(`Usage: ${p}playlist rename <old name> > <new name>`));
    const [oldName, newName] = parts as [string, string];
    await lock.run(async () => {
      const pl = await find(ctx, oldName, 'rename');
      if (!pl || !(await mayChange(ctx, pl))) return;
      if (!validName(newName)) return void (await ctx.reply(nameHelp));
      if (!store.rename(pl.name, newName)) return void (await ctx.reply(`There is already a playlist called "${newName}".`));
      await ctx.reply(`Renamed "${pl.name}" to "${newName}".`);
    });
  }

  let unprovide: (() => void) | undefined;

  return {
    commands: [
      {
        name: 'playlist',
        aliases: ['pl'],
        description: 'Save, edit and load named playlists',
        usage: `${p}playlist save|load|list|show|add|remove|move|rename|delete [name]`,
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          const rest = ctx.rest.slice(ctx.args[0]?.length ?? 0).trim();

          switch (sub) {
            case 'save':
              return save(ctx, rest);
            case 'load':
            case 'play':
              return load(ctx, rest);
            case 'add':
              return add(ctx, rest);
            case 'remove':
            case 'rm':
              return remove(ctx, rest);
            case 'move':
            case 'mv':
              return move(ctx, rest);
            case 'rename':
              return rename(ctx, rest);
            case 'list':
            case 'ls': {
              const all = store.list();
              if (!all.length) return ctx.reply(`No playlists yet. Queue some songs, then ${p}playlist save <name>.`);
              return ctx.reply(`Playlists (${all.length}):\n${all.map(summary).join('\n')}`);
            }
            case 'show': {
              const pl = await find(ctx, rest, 'show');
              if (!pl) return;
              const lines = pl.tracks.slice(0, 15).map((t, i) => `${i + 1}. ${t.title}${t.kind === 'radio' ? ' [radio]' : ` [${formatDuration(t.durationSec)}]`}`);
              if (pl.tracks.length > 15) lines.push(`...and ${pl.tracks.length - 15} more`);
              return ctx.reply(`${summary(pl)}\n${lines.join('\n')}`);
            }
            case 'delete':
            case 'del': {
              const pl = await find(ctx, rest, 'delete');
              if (!pl) return;
              if (!canModify(ctx, pl)) return ctx.reply(`"${pl.name}" belongs to ${pl.ownerName || 'someone else'}. Only its owner or a bot admin can delete it.`);
              store.delete(pl.name);
              return ctx.reply(`Deleted "${pl.name}".`);
            }
            default:
              return ctx.reply(usage);
          }
        },
      },
    ],

    onLoad() {
      unprovide = bot.services.provide<PlaylistsService>(PLAYLISTS_SERVICE, {
        list: () => store.list().map((pl) => ({ name: pl.name, tracks: pl.tracks.length, owner: pl.ownerName })),
      });
    },

    onUnload() {
      unprovide?.();
    },

    status: () => `${store.size} saved playlist${store.size === 1 ? '' : 's'}`,
  };
};

export default factory;
