import { AUDIO_SERVICE, type AudioService } from '../../core/services.js';
import type { Cog, CogFactory, CogManifest } from '../../core/types.js';

export const manifest: CogManifest = {
  name: 'voteskip',
  version: '1.0.0',
  description: 'Skip the current track when more than half of the people listening agree',
};

const factory: CogFactory = (bot): Cog => {
  const p = bot.config.prefix;
  const threshold = bot.config.voteskip.threshold;

  // Votes belong to one track. A different track id means a fresh vote.
  let votedFor: number | undefined;
  let voters = new Set<string>(); // unique IDs

  return {
    commands: [
      {
        name: 'voteskip',
        aliases: ['vs'],
        description: 'Vote to skip the current track; it skips once most of the channel agrees',
        run: async (ctx) => {
          const audio = bot.services.get<AudioService>(AUDIO_SERVICE);
          if (!audio) return ctx.reply('The audio cog is not loaded.');
          if (!ctx.isAdmin && audio.blocked?.(ctx.msg.senderUid)) return ctx.reply('You are blocked from the music commands.');
          const now = audio.snapshot().current;
          if (!now) return ctx.reply('Nothing is playing.');
          if (!(await ctx.withBot())) return ctx.reply('You need to be in my channel to vote.');

          if (votedFor !== now.id) {
            votedFor = now.id;
            voters = new Set();
          }

          // Who is listening right now (the caller always counts, even if the directory is a moment behind).
          const listening = new Set(bot.adapter.usersInChannel(bot.adapter.selfChannelId()).map((u) => u.uid));
          listening.add(ctx.msg.senderUid);

          // A vote only counts while its voter is still in the channel.
          for (const uid of [...voters]) if (!listening.has(uid)) voters.delete(uid);

          const already = voters.has(ctx.msg.senderUid);
          voters.add(ctx.msg.senderUid);

          const needed = Math.min(listening.size, Math.floor(listening.size * threshold) + 1);
          if (voters.size >= needed) {
            voters = new Set();
            votedFor = undefined;
            audio.skip();
            return ctx.reply(`Vote passed (${needed} of ${listening.size}). Skipping: ${now.title}`);
          }
          return ctx.reply(
            already
              ? `You already voted. ${voters.size}/${needed} votes to skip "${now.title}".`
              : `${ctx.msg.senderName} voted to skip. ${voters.size}/${needed} needed. Others in the channel can vote with ${p}voteskip.`,
          );
        },
      },
    ],
  };
};

export default factory;
