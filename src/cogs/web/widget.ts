import { AUDIO_SERVICE, type AudioService } from '../../core/services.js';
import type { BotApi } from '../../core/types.js';

/**
 * The public widget: what is playing and who is online, for a website.
 * It is off by default. Nothing here needs a login, so it only ever holds what an admin has chosen to make public.
 */

export interface WidgetSettings {
  enabled: boolean;
  /** List people by name and channel; otherwise only how many are in each channel. */
  showNames: boolean;
}

export interface WidgetData {
  updatedAt: number;
  nowPlaying: null | { title: string; live: boolean; paused: boolean; /** The song a radio station is announcing right now. */ song?: string };
  /** Everyone online, including people who chose to be hidden. */
  online: number;
  /** Only channels that have someone in them. */
  channels: { name: string; count: number; users?: string[] }[];
}

/** Work out what the public may see right now. */
export function buildWidgetData(bot: BotApi, settings: WidgetSettings, hiddenUids: ReadonlySet<string>): WidgetData {
  const audio = bot.services.get<AudioService>(AUDIO_SERVICE);
  const s = audio?.state?.();
  const cur = s?.current;
  const users = bot.adapter.users();
  const channels: WidgetData['channels'] = [];
  for (const c of bot.adapter.channels()) {
    const here = users.filter((u) => u.channelId === c.id);
    if (!here.length) continue;
    channels.push({
      name: c.name,
      count: here.length,
      ...(settings.showNames ? { users: here.filter((u) => !hiddenUids.has(u.uid)).map((u) => u.name) } : {}),
    });
  }
  return {
    updatedAt: Date.now(),
    nowPlaying: cur ? { title: cur.title, live: cur.kind === 'radio', paused: !!s?.paused, ...(cur.liveTitle ? { song: cur.liveTitle } : {}) } : null,
    online: users.length,
    channels,
  };
}

export const WIDGET_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Now playing and who is online</title>
<link rel="stylesheet" href="/widget.css">
</head>
<body>
<main>
  <section>
    <h2>Now playing</h2>
    <p id="np" class="np">Nothing is playing.</p>
    <p id="np-sub" class="sub"></p>
  </section>
  <section>
    <h2>Online <span id="count"></span></h2>
    <ul id="channels"></ul>
    <p id="empty" class="sub">Nobody is online.</p>
  </section>
</main>
<script src="/widget.js"></script>
</body>
</html>
`;

export const WIDGET_CSS = `
:root { color-scheme: light dark; --text:#e6ebf5; --sub:#93a0bb; --line:#25324f; --accent:#ff8a3d; }
@media (prefers-color-scheme: light) { :root { --text:#1b2333; --sub:#5a667f; --line:#d5dbe8; --accent:#d9631a; } }
* { box-sizing: border-box; }
body { margin:0; padding:12px; background:transparent; color:var(--text); font:15px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { display:grid; gap:14px; }
h2 { margin:0 0 6px; font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--sub); }
.np { margin:0; font-size:18px; font-weight:600; overflow-wrap:anywhere; }
.sub { margin:2px 0 0; color:var(--sub); font-size:13px; overflow-wrap:anywhere; }
ul { margin:0; padding:0; list-style:none; }
li { padding:6px 0; border-top:1px solid var(--line); }
li:first-child { border-top:0; }
li strong { color:var(--accent); }
[hidden] { display:none !important; }
`;

export const WIDGET_JS = String.raw`
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function render(d) {
    var np = d.nowPlaying;
    $('np').textContent = np ? np.title : 'Nothing is playing.';
    $('np-sub').textContent = np ? (np.live ? 'Live radio' : (np.paused ? 'Paused' : '')) + (np.song ? (np.live ? ' - now: ' : '') + np.song : '') : '';
    $('count').textContent = '(' + d.online + ')';
    var list = $('channels'); clear(list);
    d.channels.forEach(function (c) {
      var li = document.createElement('li');
      var strong = document.createElement('strong');
      strong.textContent = c.name;
      li.appendChild(strong);
      li.appendChild(document.createTextNode(c.users ? '  -  ' + c.users.join(', ') + (c.users.length < c.count ? (c.users.length ? ' and ' : '') + (c.count - c.users.length) + ' more' : '') : '  -  ' + c.count));
      list.appendChild(li);
    });
    $('empty').hidden = d.channels.length > 0;
  }
  function load() {
    fetch('/widget.json', { cache: 'no-store' }).then(function (r) {
      if (r.status === 404) { $('np').textContent = 'This widget is switched off.'; $('np-sub').textContent = ''; return null; }
      return r.ok ? r.json() : null;
    }).then(function (d) { if (d) render(d); }).catch(function () {});
  }
  load();
  setInterval(load, 15000);
})();
`;
