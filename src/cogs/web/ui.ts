/**
 * The dashboard's web page, kept as three strings so the bot serves it with no extra files.
 *
 * Two rules the code below follows on purpose:
 *  - Everything that comes from outside (song titles, station names, playlist names, replies) is put
 *    on the page with textContent, never as HTML, so a hostile title cannot inject anything.
 *  - Every button just sends a chat command (like "!skip") to the server, which runs it as the
 *    signed-in person with the same permissions they have in chat. The page holds no power of its own.
 */

export const APP_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>TS6 Roadie</title>
<link rel="stylesheet" href="/app.css">
</head>
<body>
<header>
  <h1>TS6 Roadie</h1>
  <div id="who" hidden><span id="who-name"></span> <button id="logout" type="button" class="quiet">Sign out</button></div>
</header>

<main id="login" hidden>
  <section class="card">
    <h2>Sign in</h2>
    <p>Send the bot <strong>!weblogin</strong> in TeamSpeak. It replies with a one-time code. Type it here.</p>
    <form id="login-form" autocomplete="off">
      <label for="code">Login code</label>
      <input id="code" name="code" type="text" inputmode="text" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" maxlength="16" required>
      <button type="submit">Sign in</button>
    </form>
    <p id="login-error" class="error" role="alert" hidden></p>
  </section>
</main>

<main id="app" hidden>
  <p id="banner" class="banner" role="status" hidden></p>

  <nav id="tabs" class="tabs" aria-label="Sections" hidden>
    <button id="tab-btn-player" type="button" class="tab active" aria-selected="true">Player</button>
    <button id="tab-btn-admin" type="button" class="tab" aria-selected="false">Admin</button>
  </nav>

  <div id="tab-player" class="tab-body">
  <section class="card" id="now">
    <h2>Now playing</h2>
    <p id="now-title" class="title">Nothing is playing.</p>
    <p id="now-sub" class="sub"></p>
    <div id="progress-wrap" class="progress" hidden><div id="progress-bar"></div></div>
    <p id="now-time" class="sub"></p>
    <div class="row">
      <button id="btn-pause" type="button">Pause</button>
      <button id="btn-skip" type="button">Skip</button>
      <button id="btn-stop" type="button" class="danger">Stop</button>
    </div>
    <div class="row">
      <label for="volume">Volume <span id="volume-label">50</span></label>
      <input id="volume" type="range" min="0" max="100" step="1" value="50">
    </div>
  </section>

  <section class="card">
    <h2>Add music</h2>
    <form id="add-form" class="row" autocomplete="off">
      <input id="add-input" type="text" placeholder="A YouTube, Spotify, SoundCloud or Bandcamp link, or search words" aria-label="Link or search words" required>
      <button type="submit">Add to queue</button>
    </form>
    <h3>Radio</h3>
    <div id="stations" class="row wrap"></div>
  </section>

  <section class="card">
    <h2>Queue</h2>
    <ol id="queue"></ol>
    <p id="queue-empty" class="sub">The queue is empty.</p>
    <div class="row">
      <button id="btn-shuffle" type="button" class="quiet">Shuffle</button>
      <button id="btn-clear" type="button" class="quiet">Clear queue</button>
    </div>
  </section>

  <section class="card">
    <h2>Playlists</h2>
    <ul id="playlists"></ul>
    <p id="playlists-empty" class="sub">No saved playlists yet. Save one in chat with !playlist save &lt;name&gt;.</p>
  </section>

  <section class="card">
    <h2>Messages</h2>
    <ul id="log" class="log"></ul>
  </section>
  </div>

  <div id="tab-admin" class="tab-body" hidden>
    <section class="card">
      <h2>Bot</h2>
      <p id="admin-facts" class="sub">Loading...</p>
      <div class="row wrap">
        <button id="btn-status" type="button" class="quiet">Full status</button>
        <button id="btn-restart" type="button" class="danger">Restart bot</button>
      </div>
      <pre id="admin-output" class="output" hidden></pre>
    </section>

    <section class="card">
      <h2>Cogs</h2>
      <ul id="cogs"></ul>
    </section>

    <section class="card">
      <h2>Who is online</h2>
      <p class="sub">The bot heads back to its home channel by itself after a couple of idle minutes.</p>
      <ul id="channels"></ul>
      <div class="row">
        <button id="btn-home" type="button" class="quiet">Stop and go home</button>
      </div>
    </section>

    <section class="card">
      <h2>Radio stations</h2>
      <p id="stations-count" class="sub"></p>
      <ul id="station-editor"></ul>
      <p id="stations-msg" class="sub" role="status"></p>
      <div class="row wrap">
        <button id="btn-st-add" type="button" class="quiet">Add a station</button>
        <button id="btn-st-save" type="button" disabled>Save stations</button>
        <button id="btn-st-discard" type="button" class="quiet" disabled>Discard changes</button>
      </div>
    </section>

    <section class="card">
      <h2>Log</h2>
      <div class="row wrap">
        <label for="log-level">Show</label>
        <select id="log-level" aria-label="Which log lines to show">
          <option value="all">Everything</option>
          <option value="warn">Warnings and errors</option>
          <option value="error">Errors only</option>
        </select>
        <button id="btn-log-refresh" type="button" class="quiet">Refresh</button>
        <label><input id="log-auto" type="checkbox"> Auto-refresh</label>
      </div>
      <pre id="logs" class="logs">Loading...</pre>
      <p id="logs-note" class="sub"></p>
    </section>
  </div>
</main>
<script src="/app.js"></script>
</body>
</html>
`;

export const APP_CSS = `
:root { color-scheme: dark; --bg:#0b1120; --card:#131c31; --line:#25324f; --text:#e6ebf5; --sub:#93a0bb; --orange:#ff8a3d; --teal:#2dd4bf; --red:#f0655a; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--text); font:16px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 20px; border-bottom:1px solid var(--line); }
h1 { margin:0; font-size:20px; letter-spacing:.3px; }
h1::before { content:""; display:inline-block; width:10px; height:10px; margin-right:10px; border-radius:2px; background:var(--orange); }
h2 { margin:0 0 10px; font-size:14px; text-transform:uppercase; letter-spacing:.08em; color:var(--sub); }
h3 { margin:14px 0 8px; font-size:13px; color:var(--sub); }
main { max-width:760px; margin:0 auto; padding:16px; display:grid; gap:14px; }
.card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; }
.title { margin:0; font-size:20px; font-weight:600; overflow-wrap:anywhere; }
.sub { margin:4px 0 0; color:var(--sub); font-size:14px; overflow-wrap:anywhere; }
.error { color:var(--red); }
.banner { margin:0; padding:10px 14px; border-radius:10px; background:#3a2a12; border:1px solid #6b4a1a; color:#ffd9a3; }
.row { display:flex; align-items:center; gap:10px; margin-top:12px; }
.row.wrap { flex-wrap:wrap; }
button { font:inherit; padding:8px 14px; border-radius:8px; border:1px solid var(--line); background:#1b2745; color:var(--text); cursor:pointer; }
button:hover { border-color:var(--teal); }
button:focus-visible, input:focus-visible { outline:2px solid var(--teal); outline-offset:2px; }
button.danger { border-color:#6b2f2a; }
button.danger:hover { border-color:var(--red); }
button.quiet { background:transparent; }
button[type=submit] { background:var(--orange); border-color:var(--orange); color:#1a0f05; font-weight:600; }
input[type=text] { flex:1; min-width:0; font:inherit; padding:9px 12px; border-radius:8px; border:1px solid var(--line); background:#0d1528; color:var(--text); }
input[type=range] { flex:1; accent-color:var(--teal); }
label { color:var(--sub); font-size:14px; }
#login-form { display:grid; gap:10px; max-width:320px; }
#code { text-transform:uppercase; letter-spacing:.2em; font-size:20px; text-align:center; }
.progress { height:6px; margin-top:12px; border-radius:3px; background:#0d1528; overflow:hidden; }
.progress > div { height:100%; width:0; background:var(--teal); }
ol, ul { margin:0; padding:0; list-style:none; }
#queue li, #playlists li { display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid var(--line); }
#queue li:first-child, #playlists li:first-child { border-top:0; }
#queue .n { color:var(--sub); width:2em; text-align:right; flex:none; }
#queue .t, #playlists .t { flex:1; min-width:0; overflow-wrap:anywhere; }
.log { max-height:200px; overflow:auto; font-size:14px; color:var(--sub); }
.log li { padding:3px 0; }
.tabs { display:flex; gap:8px; }
.tab { background:transparent; }
.tab.active { border-color:var(--orange); color:var(--orange); }
.tab-body { display:grid; gap:14px; }
select { font:inherit; padding:8px 10px; border-radius:8px; border:1px solid var(--line); background:#0d1528; color:var(--text); }
pre.output, pre.logs { margin:12px 0 0; padding:10px 12px; border-radius:8px; border:1px solid var(--line); background:#0d1528; color:var(--text); font:12.5px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; white-space:pre-wrap; overflow-wrap:anywhere; overflow:auto; }
pre.output { max-height:220px; }
pre.logs { max-height:380px; }
#cogs li, #channels li { display:flex; align-items:center; gap:10px; padding:8px 0; border-top:1px solid var(--line); }
#cogs li:first-child, #channels li:first-child { border-top:0; }
#cogs .t, #channels .t { flex:1; min-width:0; overflow-wrap:anywhere; }
#station-editor li { display:flex; flex-wrap:wrap; align-items:center; gap:8px; padding:8px 0; border-top:1px solid var(--line); }
#station-editor li:first-child { border-top:0; }
#station-editor .n { color:var(--sub); width:2em; text-align:right; flex:none; }
#station-editor .st-name { flex:1 1 160px; }
#station-editor .st-url { flex:3 1 260px; }
button:disabled { opacity:.5; cursor:default; }
button:disabled:hover { border-color:var(--line); }
[hidden] { display:none !important; }
@media (max-width:520px) { .row { flex-wrap:wrap; } }
`;

export const APP_JS = String.raw`
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var state = null;
  var fetchedAt = 0;
  var pollTimer = null;
  var tab = 'player';
  var adminTimer = null;
  var overview = null;
  var draft = null;        // the radio station list being edited
  var draftDirty = false;
  var maxStations = 30;

  // ---- tiny DOM helpers. Text is only ever set with textContent / text nodes. ----
  function el(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
      });
    }
    (kids || []).forEach(function (c) { e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function fmt(sec) {
    if (sec === undefined || sec === null || !isFinite(sec)) return '';
    sec = Math.max(0, Math.round(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = h > 0 && m < 10 ? '0' + m : String(m);
    return (h > 0 ? h + ':' : '') + mm + ':' + (s < 10 ? '0' + s : s);
  }

  // ---- talking to the server ----
  function api(path, body) {
    var opts = { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j }; });
    });
  }

  function say(lines) {
    var log = $('log');
    var stamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    lines.forEach(function (t) { log.insertBefore(el('li', { text: stamp + '  ' + t }), log.firstChild); });
    while (log.children.length > 12) log.removeChild(log.lastChild);
  }

  function showOutput(lines) {
    if (tab !== 'admin') return;
    var o = $('admin-output');
    o.hidden = false;
    o.textContent = lines.join('\n');
  }

  function run(text) {
    return api('/api/command', { text: text }).then(function (r) {
      if (r.status === 401) return showLogin();
      if (r.status === 429) return say(['Slow down a little.']);
      var lines = (r.body && r.body.replies && r.body.replies.length) ? r.body.replies : (r.body && r.body.error ? [r.body.error] : ['Done.']);
      say(lines);
      showOutput(lines);
      return Promise.all([refresh(), tab === 'admin' ? refreshAdmin(false) : null]);
    }).catch(function () {
      var lines = ['Lost contact with the bot. If it is restarting, sign in again in a few seconds.'];
      say(lines);
      showOutput(lines);
    });
  }

  // ---- screens ----
  function showLogin(message) {
    $('app').hidden = true; $('who').hidden = true; $('login').hidden = false;
    var err = $('login-error');
    err.hidden = !message; err.textContent = message || '';
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    if (adminTimer) { clearTimeout(adminTimer); adminTimer = null; }
    overview = null; draft = null; draftDirty = false;
    applyTab('player');
  }

  function render() {
    var s = state, a = s.audio || {};
    $('login').hidden = true; $('app').hidden = false; $('who').hidden = false;
    $('who-name').textContent = 'Signed in as ' + s.user.name;
    $('tabs').hidden = !s.admin;
    if (!s.admin && tab === 'admin') setTab('player');

    var banner = $('banner'), msg = '';
    if (!s.bot.connected) msg = 'The bot is not connected to TeamSpeak right now.';
    else if (!s.connected) msg = 'You are not connected to TeamSpeak right now, so the buttons will not work until you are.';
    banner.hidden = !msg; banner.textContent = msg;

    // now playing
    var cur = a.current;
    $('now-title').textContent = cur ? cur.title : 'Nothing is playing.';
    var sub = '';
    if (cur && cur.kind === 'radio') sub = 'Live radio' + (cur.liveTitle ? ' - now: ' + cur.liveTitle : '');
    else if (cur) sub = 'In ' + (s.bot.channel || 'a channel');
    $('now-sub').textContent = sub;
    $('btn-pause').textContent = a.paused ? 'Resume' : 'Pause';
    $('btn-pause').disabled = !cur; $('btn-skip').disabled = !cur; $('btn-stop').disabled = !cur && !(a.upcoming && a.upcoming.length);
    var vol = $('volume');
    if (document.activeElement !== vol) { vol.value = String(a.volume); $('volume-label').textContent = String(a.volume); }
    tick();

    // radio
    var st = $('stations'); clear(st);
    (s.stations || []).forEach(function (x) {
      st.appendChild(el('button', { type: 'button', class: 'quiet', text: x.n + '. ' + x.name, onclick: function () { run(s.prefix + 'radio ' + x.n); } }));
    });

    // queue
    var q = $('queue'); clear(q);
    (a.upcoming || []).forEach(function (t, i) {
      q.appendChild(el('li', { class: 'queue-item' }, [
        el('span', { class: 'n', text: String(i + 1) }),
        el('span', { class: 't', text: t.title + (t.kind === 'radio' ? ' [radio]' : (t.durationSec !== undefined && t.durationSec !== null ? ' [' + fmt(t.durationSec) + ']' : '')) }),
        el('button', { type: 'button', class: 'quiet', 'aria-label': 'Remove ' + t.title, text: 'Remove', onclick: function () { run(s.prefix + 'remove ' + (i + 1)); } })
      ]));
    });
    $('queue-empty').hidden = !!(a.upcoming && a.upcoming.length);
    $('btn-shuffle').disabled = !(a.upcoming && a.upcoming.length > 1);
    $('btn-clear').disabled = !(a.upcoming && a.upcoming.length);

    // playlists
    var pl = $('playlists'); clear(pl);
    (s.playlists || []).forEach(function (p) {
      pl.appendChild(el('li', { class: 'playlist-item' }, [
        el('span', { class: 't', text: p.name + ' (' + p.tracks + ' track' + (p.tracks === 1 ? '' : 's') + ', by ' + (p.owner || 'unknown') + ')' }),
        el('button', { type: 'button', class: 'quiet', 'aria-label': 'Load ' + p.name, text: 'Load', onclick: function () { run(s.prefix + 'playlist load ' + p.name); } })
      ]));
    });
    $('playlists-empty').hidden = !!(s.playlists && s.playlists.length);
  }

  // the position advances locally between polls so the bar moves smoothly
  function tick() {
    if (!state || !state.audio) return;
    var a = state.audio, cur = a.current;
    var wrap = $('progress-wrap');
    if (!cur) { wrap.hidden = true; $('now-time').textContent = ''; return; }
    var pos = a.positionSec + ((a.playing && !a.paused) ? (Date.now() - fetchedAt) / 1000 : 0);
    if (cur.durationSec) {
      pos = Math.min(pos, cur.durationSec);
      wrap.hidden = false;
      $('progress-bar').style.width = (100 * pos / cur.durationSec).toFixed(1) + '%';
      $('now-time').textContent = fmt(pos) + ' / ' + fmt(cur.durationSec) + (a.paused ? '  (paused)' : '');
    } else {
      wrap.hidden = true;
      $('now-time').textContent = fmt(pos) + (cur.kind === 'radio' ? ' / live' : '') + (a.paused ? '  (paused)' : '');
    }
  }

  function refresh() {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    return api('/api/state').then(function (r) {
      if (r.status === 401) return showLogin();
      state = r.body; fetchedAt = Date.now();
      render();
      pollTimer = setTimeout(refresh, document.hidden ? 6000 : 2000);
    }).catch(function () {
      say(['Lost contact with the bot. Retrying...']);
      pollTimer = setTimeout(refresh, 4000);
    });
  }

  // ---- Admin tab: only bot admins see it, and the server refuses everyone else ----
  function applyTab(name) {
    tab = name;
    $('tab-player').hidden = name !== 'player';
    $('tab-admin').hidden = name !== 'admin';
    $('tab-btn-player').className = 'tab' + (name === 'player' ? ' active' : '');
    $('tab-btn-admin').className = 'tab' + (name === 'admin' ? ' active' : '');
    $('tab-btn-player').setAttribute('aria-selected', String(name === 'player'));
    $('tab-btn-admin').setAttribute('aria-selected', String(name === 'admin'));
  }

  function setTab(name) {
    applyTab(name);
    if (adminTimer) { clearTimeout(adminTimer); adminTimer = null; }
    if (name === 'admin') {
      if (!draftDirty) loadStations();
      refreshAdmin(true);
    }
  }

  function upText(sec) {
    var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
    return d > 0 ? d + 'd ' + h + 'h' : (h > 0 ? h + 'h ' + m + 'm' : m + 'm');
  }

  function renderAdmin() {
    var o = overview, prefix = state.prefix;
    var here = null;
    o.channels.forEach(function (c) { if (c.id === o.botChannelId) here = c; });
    $('admin-facts').textContent = 'Bot ' + o.version + '  |  TS library ' + o.tsLib + '  |  Node ' + o.node + '  |  Up ' + upText(o.uptimeSec) + '  |  ' + (o.connected ? 'Connected' : 'NOT connected') + '  |  Channel: ' + (here ? here.name : '?');

    var cogs = $('cogs'); clear(cogs);
    o.cogs.forEach(function (c) {
      var kids = [el('span', { class: 't', text: (c.loaded ? '[on]  ' : '[off]  ') + c.name + ' ' + c.version + ' (' + c.source + ') - ' + c.description })];
      if (c.name === 'core' || c.name === 'web') {
        kids.push(el('span', { class: 'sub', text: 'needed by this page' }));
      } else if (/^[A-Za-z0-9_-]+$/.test(c.name)) {
        if (c.loaded) {
          kids.push(el('button', { type: 'button', class: 'quiet', 'aria-label': 'Reload ' + c.name, text: 'Reload', onclick: function () { run(prefix + 'reload ' + c.name); } }));
          kids.push(el('button', { type: 'button', class: 'quiet danger', 'aria-label': 'Unload ' + c.name, text: 'Unload', onclick: function () {
            if (confirm('Unload ' + c.name + '? Whatever it does stops until it is loaded again.')) run(prefix + 'unload ' + c.name);
          } }));
        } else {
          kids.push(el('button', { type: 'button', class: 'quiet', 'aria-label': 'Load ' + c.name, text: 'Load', onclick: function () { run(prefix + 'load ' + c.name); } }));
        }
      }
      cogs.appendChild(el('li', { class: 'cog-item' }, kids));
    });

    var byParent = {}, known = {};
    o.channels.forEach(function (c) { known[c.id] = true; (byParent[c.parentId] = byParent[c.parentId] || []).push(c); });
    var list = $('channels'); clear(list);
    function add(c, depth) {
      var isHere = c.id === o.botChannelId;
      var go = el('button', { type: 'button', class: 'quiet', 'aria-label': 'Bring the bot to ' + c.name, text: isHere ? 'Bot is here' : 'Bring bot here', onclick: function () {
        if (/^[0-9]+$/.test(c.id)) run(prefix + 'goto #' + c.id);
      } });
      go.disabled = isHere;
      var who = c.users.map(function (u) { return u.name; }).join(', ');
      var li = el('li', { class: 'channel' }, [
        el('span', { class: 't' }, [el('strong', { text: c.name }), el('span', { class: 'sub', text: '  -  ' + (who || 'empty') })]),
        go
      ]);
      li.style.paddingLeft = (depth * 18) + 'px';
      list.appendChild(li);
      if (depth < 8) (byParent[c.id] || []).forEach(function (k) { add(k, depth + 1); });
    }
    o.channels.forEach(function (c) { if (c.parentId === '0' || !known[c.parentId]) add(c, 0); });
  }

  function refreshLogs() {
    var pre = $('logs');
    var atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    return api('/api/admin/logs?lines=300&level=' + encodeURIComponent($('log-level').value)).then(function (r) {
      if (r.status === 401) return showLogin();
      if (r.status !== 200) { pre.textContent = (r.body && r.body.error) || 'Could not load the log.'; return; }
      pre.textContent = r.body.lines.length ? r.body.lines.join('\n') : 'Nothing to show.';
      $('logs-note').textContent = (r.body.file || 'No log file yet') + (r.body.more ? '  -  older lines are not shown' : '');
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    });
  }

  function refreshAdmin(withLogs) {
    if (adminTimer) { clearTimeout(adminTimer); adminTimer = null; }
    if (tab !== 'admin') return Promise.resolve();
    var jobs = [api('/api/admin/overview').then(function (r) {
      if (r.status === 401) return showLogin();
      if (r.status !== 200) { $('admin-facts').textContent = (r.body && r.body.error) || 'Could not load.'; return; }
      overview = r.body;
      renderAdmin();
    })];
    if (withLogs || $('log-auto').checked) jobs.push(refreshLogs());
    return Promise.all(jobs).catch(function () {}).then(function () {
      if (tab === 'admin') adminTimer = setTimeout(function () { refreshAdmin(false); }, document.hidden ? 15000 : 5000);
    });
  }

  // radio stations: edit a copy here, and only "Save" sends it to the bot
  function setDirty(d) {
    draftDirty = d;
    $('btn-st-save').disabled = !d;
    $('btn-st-discard').disabled = !d;
  }

  function copyStations(list) {
    return list.map(function (x) { return { key: x.key, name: x.name, url: x.url }; });
  }

  function renderStationEditor() {
    var list = $('station-editor'); clear(list);
    var rows = draft || [];
    $('stations-count').textContent = rows.length + ' of ' + maxStations + ' stations. The numbers are what people type after !radio.';
    rows.forEach(function (row, i) {
      var name = el('input', { type: 'text', class: 'st-name', maxlength: '60', placeholder: 'Station name', 'aria-label': 'Name of station ' + (i + 1), value: row.name });
      var url = el('input', { type: 'text', class: 'st-url', maxlength: '500', placeholder: 'https://... stream address', 'aria-label': 'Address of station ' + (i + 1), value: row.url });
      name.addEventListener('input', function () { row.name = name.value; setDirty(true); });
      url.addEventListener('input', function () { row.url = url.value; setDirty(true); });
      var up = el('button', { type: 'button', class: 'quiet', 'aria-label': 'Move station ' + (i + 1) + ' up', text: 'Up', onclick: function () {
        var t = draft[i - 1]; draft[i - 1] = draft[i]; draft[i] = t; setDirty(true); renderStationEditor();
      } });
      var down = el('button', { type: 'button', class: 'quiet', 'aria-label': 'Move station ' + (i + 1) + ' down', text: 'Down', onclick: function () {
        var t = draft[i + 1]; draft[i + 1] = draft[i]; draft[i] = t; setDirty(true); renderStationEditor();
      } });
      up.disabled = i === 0;
      down.disabled = i === rows.length - 1;
      var del = el('button', { type: 'button', class: 'quiet danger', 'aria-label': 'Remove station ' + (i + 1), text: 'Remove', onclick: function () {
        draft.splice(i, 1); setDirty(true); renderStationEditor();
      } });
      list.appendChild(el('li', { class: 'station-row' }, [el('span', { class: 'n', text: String(i + 1) }), name, url, up, down, del]));
    });
  }

  function loadStations() {
    return api('/api/admin/stations').then(function (r) {
      if (r.status === 401) return showLogin();
      if (r.status !== 200) return;
      draft = copyStations(r.body.stations);
      maxStations = r.body.max || 30;
      setDirty(false);
      $('stations-msg').textContent = '';
      renderStationEditor();
    }).catch(function () {});
  }

  function saveStations() {
    var msg = $('stations-msg');
    msg.className = 'sub'; msg.textContent = 'Saving...';
    return api('/api/admin/stations/save', { stations: copyStations(draft) }).then(function (r) {
      if (r.status === 401) return showLogin();
      if (r.status === 200) {
        draft = copyStations(r.body.stations);
        setDirty(false);
        renderStationEditor();
        msg.textContent = 'Saved. The new list works right away.';
        return refresh();
      }
      msg.className = 'sub error';
      msg.textContent = (r.body && r.body.error) || 'That did not save.';
    }).catch(function () {
      msg.className = 'sub error';
      msg.textContent = 'Lost contact with the bot. Try again.';
    });
  }

  // ---- wiring ----
  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    api('/api/login', { code: $('code').value }).then(function (r) {
      if (r.status === 200) { $('code').value = ''; showLogin(''); return refresh(); }
      showLogin(r.body && r.body.error ? r.body.error : 'That did not work.');
    });
  });
  $('logout').addEventListener('click', function () { api('/api/logout', {}).then(function () { state = null; showLogin(''); }); });
  $('btn-pause').addEventListener('click', function () { run(state.prefix + (state.audio.paused ? 'resume' : 'pause')); });
  $('btn-skip').addEventListener('click', function () { run(state.prefix + 'skip'); });
  $('btn-stop').addEventListener('click', function () { run(state.prefix + 'stop'); });
  $('btn-shuffle').addEventListener('click', function () { run(state.prefix + 'shuffle'); });
  $('btn-clear').addEventListener('click', function () { run(state.prefix + 'clear'); });
  $('volume').addEventListener('input', function () { $('volume-label').textContent = $('volume').value; });
  $('volume').addEventListener('change', function () { run(state.prefix + 'volume ' + $('volume').value); });
  $('add-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('add-input'), v = input.value.trim();
    if (!v) return;
    input.value = '';
    run(state.prefix + 'play ' + v);
  });
  $('tab-btn-player').addEventListener('click', function () { setTab('player'); });
  $('tab-btn-admin').addEventListener('click', function () { setTab('admin'); });
  $('btn-status').addEventListener('click', function () { run(state.prefix + 'status'); });
  $('btn-restart').addEventListener('click', function () {
    if (confirm('Restart the bot? Music stops for a few seconds, and everyone has to sign in to this page again.')) run(state.prefix + 'restart');
  });
  $('btn-home').addEventListener('click', function () { run(state.prefix + 'leave'); });
  $('btn-log-refresh').addEventListener('click', function () { refreshLogs(); });
  $('log-level').addEventListener('change', function () { refreshLogs(); });
  $('btn-st-add').addEventListener('click', function () {
    if (!draft) return;
    if (draft.length >= maxStations) { $('stations-msg').className = 'sub error'; $('stations-msg').textContent = 'That is the most stations there can be (' + maxStations + ').'; return; }
    draft.push({ key: '', name: '', url: '' });
    setDirty(true);
    renderStationEditor();
    var names = $('station-editor').querySelectorAll('.st-name');
    if (names.length) names[names.length - 1].focus();
  });
  $('btn-st-save').addEventListener('click', function () { if (draft) saveStations(); });
  $('btn-st-discard').addEventListener('click', function () { loadStations(); });
  setInterval(tick, 1000);
  refresh();
})();
`;
