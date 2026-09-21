import { AUDIO_SERVICE, PLAYLISTS_SERVICE, type AudioService, type PlaylistsService } from '../../core/services.js';
import type { Cog, CogFactory, CogManifest } from '../../core/types.js';
import { SourceError } from '../audio/sources.js';
import { createAdminApi } from './admin.js';
import { buildWidgetData, type WidgetSettings } from './widget.js';
import { WebAuth, type Person } from './auth.js';
import { startWebServer, type RunningWeb } from './server.js';

export const manifest: CogManifest = {
  name: 'web',
  version: '1.2.0',
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

  // ---- the public widget's settings (kept between restarts) ----
  let widget = bot.state.get<WidgetSettings>('web.widget', { enabled: cfg.widget.enabled, showNames: cfg.widget.showNames });
  const hiddenUids = (): Set<string> => new Set(bot.state.get<string[]>('web.widgetHidden', []));
  const saveWidget = (next: WidgetSettings): void => {
    widget = next;
    bot.state.set('web.widget', next);
    widgetCache = undefined;
  };
  let widgetCache: { at: number; data: unknown } | undefined;
  /** What the public feed holds, worked out at most every 5 seconds however many visitors there are. */
  const widgetData = (): unknown => {
    const now = Date.now();
    if (!widgetCache || now - widgetCache.at > 5_000) widgetCache = { at: now, data: buildWidgetData(bot, widget, hiddenUids()) };
    return widgetCache.data;
  };
  const widgetUrl = (): string => `${cfg.publicUrl || `http://127.0.0.1:${running?.port ?? cfg.port}`}/widget`;

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
        name: 'hideme',
        aliases: ['hide'],
        description: 'Hide your name from the public widget on the website: !hideme [on|off]',
        usage: `${p}hideme [on|off]`,
        run: (ctx) => {
          const want = ctx.args[0]?.toLowerCase();
          const list = bot.state.get<string[]>('web.widgetHidden', []);
          const hidden = list.includes(ctx.msg.senderUid);
          if (!want) return ctx.reply(hidden ? `Your name is hidden from the public widget. ${p}hideme off shows it again.` : `Your name can show in the public widget (if it is switched on). ${p}hideme on hides it.`);
          if (want !== 'on' && want !== 'off') return ctx.reply(`Usage: ${p}hideme [on|off]`);
          const next = want === 'on' ? [...new Set([...list, ctx.msg.senderUid])].slice(-2000) : list.filter((u) => u !== ctx.msg.senderUid);
          bot.state.set('web.widgetHidden', next);
          widgetCache = undefined;
          return ctx.reply(want === 'on' ? 'Done: your name will not be shown in the public widget (you still count in the total).' : 'Done: your name can show in the public widget again.');
        },
      },
      {
        name: 'widget',
        description: 'The public widget for the website: !widget [on|off|names on|names off] (bot admins only)',
        usage: `${p}widget [on|off|names on|names off]`,
        perm: 'admin',
        run: (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          const hiddenCount = hiddenUids().size;
          if (!sub) {
            return ctx.reply(
              `The public widget is ${widget.enabled ? 'ON' : 'off'}, and shows ${widget.showNames ? 'names and channels' : 'only how many are in each channel'}.\n` +
                `Page: ${widgetUrl()}  Data: ${widgetUrl()}.json\n` +
                `${cfg.widget.origins.length ? `Websites allowed to embed it: ${cfg.widget.origins.join(', ')}` : 'No website may embed it yet: list them in web.widget.origins in config.json.'}` +
                `${hiddenCount ? `\n${hiddenCount} ${hiddenCount === 1 ? 'person has' : 'people have'} hidden their name with ${p}hideme.` : ''}`,
            );
          }
          if (sub === 'on' || sub === 'off') {
            saveWidget({ ...widget, enabled: sub === 'on' });
            return ctx.reply(sub === 'on' ? `The public widget is on: anyone with the address can see ${widget.showNames ? 'what is playing and who is online, by name' : 'what is playing and how many are online'}. ${widgetUrl()}` : 'The public widget is off.');
          }
          if (sub === 'names') {
            const v = ctx.args[1]?.toLowerCase();
            if (v !== 'on' && v !== 'off') return ctx.reply(`Usage: ${p}widget names on|off`);
            saveWidget({ ...widget, showNames: v === 'on' });
            return ctx.reply(v === 'on' ? 'The widget will show names and channels (except people who used !hideme).' : 'The widget will show only how many people are in each channel.');
          }
          return ctx.reply(`Usage: ${p}widget [on|off|names on|names off]`);
        },
      },
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
          admin: createAdminApi(bot, { widget: () => ({ enabled: widget.enabled, showNames: widget.showNames, url: widgetUrl(), origins: cfg.widget.origins, hidden: hiddenUids().size }) }),
          widget: { enabled: () => widget.enabled, origins: cfg.widget.origins, data: widgetData },
          search: async (person, q) => {
            const audio = bot.services.get<AudioService>(AUDIO_SERVICE);
            if (!audio?.search) return { ok: false, status: 503, error: 'The audio cog is not loaded.' };
            if (audio.blocked?.(person.uid)) return { ok: false, status: 403, error: 'You are blocked from the music commands.' };
            try {
              return { ok: true, results: await audio.search(q) };
            } catch (e) {
              return { ok: false, status: 400, error: e instanceof SourceError ? e.message : 'That search did not work.' };
            }
          },
          history: () => bot.services.get<AudioService>(AUDIO_SERVICE)?.history?.(30) ?? [],
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
