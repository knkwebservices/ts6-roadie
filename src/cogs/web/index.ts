import { AUDIO_SERVICE, PLAYLISTS_SERVICE, type AudioService, type PlaylistsService } from '../../core/services.js';
import type { Cog, CogFactory, CogManifest } from '../../core/types.js';
import { createAdminApi } from './admin.js';
import { WebAuth, type Person } from './auth.js';
import { startWebServer, type RunningWeb } from './server.js';

export const manifest: CogManifest = {
  name: 'web',
  version: '1.1.0',
  description: 'A web dashboard for the bot: this machine only, or a public https address through a reverse proxy',
};

/** Offered so tests (and later stages) can find out where the dashboard is listening. */
export const WEB_SERVICE = 'web';
export interface WebService {
  port: number;
  url: string;
}

const factory: CogFactory = (bot): Cog => {
  const p = bot.config.prefix;
  const cfg = bot.config.web;
  const log = bot.log.child('web');
  const auth = new WebAuth({ codeTtlMs: cfg.codeMinutes * 60_000, sessionTtlMs: cfg.sessionHours * 3_600_000 });
  let running: RunningWeb | undefined;
  let unprovide: (() => void) | undefined;

  const channelName = (id: bigint): string | undefined => bot.adapter.channels().find((c) => c.id === id)?.name;

  /** Everything the page shows for one signed-in person. */
  function stateFor(person: Person): unknown {
    const me = bot.adapter.users().find((u) => u.uid === person.uid);
    return {
      user: { name: person.name },
      admin: bot.isAdmin(person.uid),
      prefix: p,
      connected: !!me,
      bot: { connected: bot.adapter.connected, channel: channelName(bot.adapter.selfChannelId()) },
      audio: bot.services.get<AudioService>(AUDIO_SERVICE)?.state() ?? null,
      playlists: bot.services.get<PlaylistsService>(PLAYLISTS_SERVICE)?.list() ?? [],
      stations: Object.entries(bot.config.audio.radioStations).map(([key, s], i) => ({ n: i + 1, key, name: s.name })),
    };
  }

  return {
    commands: [
      {
        name: 'weblogin',
        description: 'Get a one-time code to sign in to the web dashboard',
        usage: `${p}weblogin`,
        run: async (ctx) => {
          const code = auth.issueCode({ uid: ctx.msg.senderUid, name: ctx.msg.senderName });
          const expires = `It works once and expires in ${cfg.codeMinutes} minute${cfg.codeMinutes === 1 ? '' : 's'}.`;
          const text = cfg.publicUrl
            ? `Your dashboard code is ${code}. ${expires}\nOpen ${cfg.publicUrl} in any browser and type the code in.`
            : `Your dashboard code is ${code}. ${expires}\n` +
              `Open ${running ? `http://127.0.0.1:${running.port}` : 'the dashboard address'} in a browser on the machine the bot runs on, and type the code in.`;
          // The code is a password for a few minutes: it always goes to the person privately, never to a channel.
          if (ctx.msg.scope === 'private') return ctx.reply(text);
          await bot.adapter.sendPrivate(ctx.msg.senderId, text);
          return ctx.reply('I sent your dashboard code to you in a private message.');
        },
      },
    ],

    async onLoad() {
      running = await startWebServer(
        { host: cfg.host, port: cfg.port, publicUrl: cfg.publicUrl },
        {
          auth,
          runCommandAs: (uid, text) => bot.runCommandAs(uid, text),
          state: stateFor,
          isAdmin: (uid) => bot.isAdmin(uid),
          admin: createAdminApi(bot),
          sessionTtlMs: cfg.sessionHours * 3_600_000,
          log,
        },
      ).catch((e: NodeJS.ErrnoException) => {
        throw new Error(e.code === 'EADDRINUSE' ? `the dashboard port ${cfg.port} is already in use (change web.port in config.json)` : `could not start the dashboard: ${e.message}`);
      });
      unprovide = bot.services.provide<WebService>(WEB_SERVICE, { port: running.port, url: cfg.publicUrl || `http://127.0.0.1:${running.port}` });
      log.info(`dashboard listening on http://${cfg.host}:${running.port} (this machine only)${cfg.publicUrl ? `; also accepts requests for ${cfg.publicUrl} from a reverse proxy` : ''}`);
    },

    async onUnload() {
      unprovide?.();
      await running?.close();
      running = undefined;
    },

    status: () => (running ? `listening on 127.0.0.1:${running.port}` : 'not running'),
  };
};

export default factory;
