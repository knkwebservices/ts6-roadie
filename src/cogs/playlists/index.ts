import { join } from 'node:path';
import { AUDIO_SERVICE, type AudioService } from '../../core/services.js';
import type { Cog, CogFactory, CogManifest, CommandContext } from '../../core/types.js';
import { Mutex } from '../../util/mutex.js';
import { formatDuration } from '../../util/text.js';
import { PlaylistStore, validName, type Playlist } from './store.js';

export const manifest: CogManifest = {
  name: 'playlists',
  version: '1.0.0',
  description: 'Save what is queued as a named playlist and load it again with one command',
};

const factory: CogFactory = (bot): Cog => {
  const p = bot.config.prefix;
  const limits = bot.config.playlists;
  const store = new PlaylistStore(join(bot.dataDir, 'playlists.json'), bot.log.child('playlists'));
  const lock = new Mutex(); // saves are read-modify-write; keep them one at a time

  const usage = [
    `${p}playlist save <name>   - save what is playing and queued`,
    `${p}playlist load <name>   - queue a saved playlist`,
    `${p}playlist list          - all saved playlists`,
    `${p}playlist show <name>   - the tracks in one`,
    `${p}playlist delete <name> - remove one (its owner or an admin)`,
  ].join('\n');

  const audio = (): AudioService | undefined => bot.services.get<AudioService>(AUDIO_SERVICE);
  const canModify = (ctx: CommandContext, pl: Playlist): boolean => ctx.isAdmin || pl.ownerUid === ctx.msg.senderUid;
  const summary = (pl: Playlist): string => `${pl.name} (${pl.tracks.length} track${pl.tracks.length === 1 ? '' : 's'}, by ${pl.ownerName || 'unknown'})`;

  async function save(ctx: CommandContext, name: string): Promise<void> {
    if (!validName(name)) {
      return void (await ctx.reply(`A playlist name is 1-32 letters, numbers, spaces or _ . ' - characters. Example: ${p}playlist save friday night`));
    }
    const svc = audio();
    if (!svc) return void (await ctx.reply('The audio cog is not loaded, so there is nothing to save.'));

    await lock.run(async () => {
      const snap = svc.snapshot();
      const tracks = [...(snap.current ? [snap.current] : []), ...snap.upcoming];
      if (!tracks.length) return void (await ctx.reply(`Nothing is playing or queued yet. Queue some songs with ${p}play first.`));

      const existing = store.get(name);
      if (existing && !canModify(ctx, existing)) {
        return void (await ctx.reply(`"${existing.name}" belongs to ${existing.ownerName || 'someone else'}. Pick another name.`));
      }
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
        `${existing ? 'Updated' : 'Saved'} "${existing?.name ?? name}" with ${kept.length} track${kept.length === 1 ? '' : 's'}.` +
          (cut > 0 ? ` (${cut} more were left out: the limit is ${limits.maxTracks} per playlist.)` : ''),
      );
    });
  }

  async function load(ctx: CommandContext, name: string): Promise<void> {
    const pl = name ? store.get(name) : undefined;
    if (!pl) return void (await ctx.reply(name ? `No playlist called "${name}". ${p}playlist list shows them all.` : `Usage: ${p}playlist load <name>`));
    const svc = audio();
    if (!svc) return void (await ctx.reply('The audio cog is not loaded, so I cannot play anything.'));
    if (!pl.tracks.length) return void (await ctx.reply(`"${pl.name}" is empty.`));
    await svc.queue(ctx, pl.tracks, { label: pl.name });
  }

  return {
    commands: [
      {
        name: 'playlist',
        aliases: ['pl'],
        description: 'Save and load named playlists',
        usage: `${p}playlist save|load|list|show|delete [name]`,
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          const name = ctx.rest.slice(ctx.args[0]?.length ?? 0).trim();

          switch (sub) {
            case 'save':
              return save(ctx, name);
            case 'load':
            case 'play':
              return load(ctx, name);
            case 'list':
            case 'ls': {
              const all = store.list();
              if (!all.length) return ctx.reply(`No playlists yet. Queue some songs, then ${p}playlist save <name>.`);
              return ctx.reply(`Playlists (${all.length}):\n${all.map(summary).join('\n')}`);
            }
            case 'show': {
              const pl = name ? store.get(name) : undefined;
              if (!pl) return ctx.reply(name ? `No playlist called "${name}".` : `Usage: ${p}playlist show <name>`);
              const lines = pl.tracks.slice(0, 15).map((t, i) => `${i + 1}. ${t.title}${t.kind === 'radio' ? ' [radio]' : ` [${formatDuration(t.durationSec)}]`}`);
              if (pl.tracks.length > 15) lines.push(`...and ${pl.tracks.length - 15} more`);
              return ctx.reply(`${summary(pl)}\n${lines.join('\n')}`);
            }
            case 'delete':
            case 'remove':
            case 'del': {
              const pl = name ? store.get(name) : undefined;
              if (!pl) return ctx.reply(name ? `No playlist called "${name}".` : `Usage: ${p}playlist delete <name>`);
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

    status: () => `${store.size} saved playlist${store.size === 1 ? '' : 's'}`,
  };
};

export default factory;
