import type { Cog, CogManifest, CogFactory } from '../../core/types.js';
import { formatUptime } from '../../util/text.js';
import { BOT_VERSION, tsLibVersion } from '../../version.js';

export const manifest: CogManifest = {
  name: 'core',
  version: '1.0.0',
  description: 'Help, status and cog management',
};

const factory: CogFactory = (bot): Cog => {
  const p = bot.config.prefix;

  return {
    commands: [
      {
        name: 'help',
        aliases: ['commands'],
        description: 'List commands, or show details for one',
        usage: `${p}help [command]`,
        run: async (ctx) => {
          const wanted = ctx.args[0]?.replace(p, '').toLowerCase();
          const all = bot.listCommands();
          if (wanted) {
            const hit = all.find(({ def }) => [def.name, ...(def.aliases ?? [])].includes(wanted));
            if (!hit) return ctx.reply(`No command called "${wanted}".`);
            const d = hit.def;
            const lines = [`${p}${d.name} - ${d.description}`];
            if (d.usage) lines.push(`Usage: ${d.usage}`);
            if (d.aliases?.length) lines.push(`Also: ${d.aliases.map((a) => p + a).join(', ')}`);
            if (d.perm === 'admin') lines.push('Bot admins only.');
            return ctx.reply(lines.join('\n'));
          }
          const byCog = new Map<string, string[]>();
          for (const { cog, def } of all) {
            if (def.perm === 'admin' && !ctx.isAdmin) continue;
            byCog.set(cog, [...(byCog.get(cog) ?? []), p + def.name]);
          }
          const out = [...byCog].map(([cog, names]) => `[${cog}] ${names.join('  ')}`);
          out.push(`Type ${p}help <command> for details.`);
          return ctx.reply(out.join('\n'));
        },
      },
      {
        name: 'ping',
        description: 'Check the bot is alive',
        run: (ctx) => ctx.reply('pong'),
      },
      {
        name: 'whoami',
        description: 'Show the identity the bot sees for you (use this to find your unique ID)',
        run: async (ctx) => {
          const u = await ctx.user();
          const ch = u ? bot.adapter.channels().find((c) => c.id === u.channelId)?.name : undefined;
          return ctx.reply(
            [
              `Name: ${ctx.msg.senderName}`,
              `Unique ID: ${ctx.msg.senderUid}`,
              `Bot admin: ${ctx.isAdmin ? 'yes' : 'no'}`,
              `Server groups: ${ctx.msg.senderGroups.length ? ctx.msg.senderGroups.join(', ') : 'none reported'}`,
              `Channel: ${ch ?? (u ? `#${u.channelId}` : 'unknown - I cannot see you')}`,
            ].join('\n'),
          );
        },
      },
      {
        name: 'status',
        description: 'Versions, uptime and connection state',
        perm: 'admin',
        run: async (ctx) => {
          const ch = bot.adapter.channels().find((c) => c.id === bot.adapter.selfChannelId())?.name;
          const lines = [
            `Bot ${BOT_VERSION} | TS library ${tsLibVersion()} | Node ${process.versions.node}`,
            `Uptime: ${formatUptime((Date.now() - bot.startedAt) / 1000)} | Connected: ${bot.adapter.connected ? 'yes' : 'no'} | Channel: ${ch ?? '?'}`,
            ...(await bot.statusLines()),
          ];
          return ctx.reply(lines.join('\n'));
        },
      },
      {
        name: 'cogs',
        description: 'List cogs and whether they are loaded',
        perm: 'admin',
        run: (ctx) =>
          ctx.reply(
            bot
              .listCogs()
              .map((c) => `${c.loaded ? '[on] ' : '[off]'} ${c.manifest.name} ${c.manifest.version} (${c.source}) - ${c.manifest.description}`)
              .join('\n') || 'No cogs found.',
          ),
      },
      {
        name: 'load',
        description: 'Load a cog',
        usage: `${p}load <cog>`,
        perm: 'admin',
        run: async (ctx) => {
          if (!ctx.args[0]) return ctx.reply(`Usage: ${p}load <cog>`);
          try {
            const m = await bot.loadCog(ctx.args[0]);
            return ctx.reply(`Loaded ${m.name} ${m.version}.`);
          } catch (e) {
            return ctx.reply(`Could not load: ${(e as Error).message}`);
          }
        },
      },
      {
        name: 'unload',
        description: 'Unload a cog',
        usage: `${p}unload <cog>`,
        perm: 'admin',
        run: async (ctx) => {
          if (!ctx.args[0]) return ctx.reply(`Usage: ${p}unload <cog>`);
          try {
            await bot.unloadCog(ctx.args[0]);
            return ctx.reply(`Unloaded ${ctx.args[0]}.`);
          } catch (e) {
            return ctx.reply(`Could not unload: ${(e as Error).message}`);
          }
        },
      },
      {
        name: 'reload',
        description: 'Reload a cog from disk (only its entry file - use !restart for deeper changes)',
        usage: `${p}reload <cog>`,
        perm: 'admin',
        run: async (ctx) => {
          if (!ctx.args[0]) return ctx.reply(`Usage: ${p}reload <cog>`);
          try {
            const m = await bot.reloadCog(ctx.args[0]);
            return ctx.reply(`Reloaded ${m.name} ${m.version}.`);
          } catch (e) {
            return ctx.reply((e as Error).message);
          }
        },
      },
      {
        name: 'restart',
        description: 'Restart the bot process (the service manager brings it back)',
        perm: 'admin',
        run: async (ctx) => {
          await ctx.reply('Restarting - back in a few seconds.');
          bot.restart();
        },
      },
    ],
  };
};

export default factory;
