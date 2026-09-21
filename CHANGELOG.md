# Changelog

## 0.11.0
- **Keeping it working.** A new **Tools** card on the dashboard's Admin tab (and `!tools`, `!ytcheck`, `!ytupdate` in chat, admins only) shows the yt-dlp and ffmpeg versions, tests whether YouTube playback still works, and updates yt-dlp with one click. The check explains the usual failures (a bot check needing cookies, a missing JavaScript runtime, a stale yt-dlp) and says what to do.
- **The bot now tests YouTube by itself** (`audio.healthCheckHours`, default every 12 hours, `0` = never). A failure is checked again a few minutes later, and only if it is still failing are the online admins told, once, by private message; they are told again when it recovers. A single hiccup bothers nobody.
- **A radio station that drops is reconnected.** `audio.radioRetries` (default 3) and `audio.radioRetrySeconds` (default 2, later tries wait longer) control it, listeners are told once, and a problem that retrying cannot fix (a missing ffmpeg) is not retried. `audio.radioFallback` names a station to switch to when one will not come back. Auto-DJ reconnects silently.
- **Search and pick:** `!search <words>` lists five YouTube results and `!pick <number>` queues one. On the dashboard, a Search button beside the Add music box shows results with an Add button each.
- **Play history:** `!history` (`!recent`) shows what was played, newest first, and `!again <#number>` plays one again (subject to the same limits and blocks as any request). The dashboard has a Recently played card with a Play again button. Kept in `data/history.json`: the last 300 requested tracks, plus the last 100 Auto-DJ picks kept apart so a long night of them cannot push out what people asked for. Repeats and seeks are not counted as new plays.
- `!status` now reads the tool versions from the same cached check.
- Development: the audio tests' shared pieces (`test/audio-helpers.ts`) now include fake search, check and update tools.

## 0.10.0
- **Queue control:** `!seek <1:30 | 90 | +30 | -30>` jumps within the current track (not live radio), `!repeat [off|track|queue]` (`!loop`) repeats the track or the whole queue, and `!move <from> <to>` reorders queued tracks. Live radio, failed tracks and Auto-DJ picks are never repeated, and a skip always moves on. On the dashboard: click the progress bar to jump, a Repeat button, and Up/Down buttons on queued tracks.
- **Auto-DJ** (admins): `!autodj on|off` and `!autodj source radio <station>` or `!autodj source playlist <name>`. When the queue is empty and someone is in the bot's channel, it plays a station, or a random track from a playlist (never the same one twice in a row). A person's request always goes ahead of it, `!stop` keeps it quiet for ten minutes, and it never chats about its own trouble; if a source fails it waits a minute before trying again. Settings are remembered in `state.json`; `audio.autoDj` in `config.json` sets the starting values.
- **24/7 mode** (admins): `!stay on|off` (`!247`). The bot stays in whatever channel it is in instead of going home when idle or leaving when alone (Auto-DJ music still pauses in an empty room, and starts again when someone joins). After a restart it returns to its home channel, so set `server.homeChannel` to where it should live. `audio.stayInChannel` sets the starting value.
- **Troll control** (admins): `!block <name or #number> [minutes]`, `!unblock`, `!blocklist`, `!blockword`, `!unblockword`. A blocked person cannot queue, skip, stop, seek, move, repeat, change the volume, summon the bot or vote to skip; they can still look at the queue. Bot admins cannot be blocked. `audio.maxQueuePerUser` limits how many tracks one person may have queued (admins exempt), and `audio.blockedWords` (plus `!blockword`) keeps tracks with a word in the title or address out.
- **Dashboard:** the Admin tab gains an Auto-DJ and 24/7 card and a Troll control card (blocked people and words, and a Block button for anyone online).
- `!status` now also shows repeat, Auto-DJ and 24/7. The playlists service can now hand out a playlist's tracks (used by Auto-DJ).
- Fixed: a caller who moves the bot now claims it before it moves, so nothing else can start playing in the gap.

## 0.9.0
- **The dashboard has an Admin tab, for bot admins only.** Non-admins never see it, and the server refuses its requests even if a group rule lets someone sign in.
  - **Bot:** version, uptime, connection and channel at a glance, a Full status button, and a Restart button that asks first.
  - **Cogs:** which cogs are on, with Reload, Unload and Load buttons. `core` and `web` are left alone because the page needs them.
  - **Who is online:** every channel with the people in it, and a Bring bot here button on each. The bot still heads home by itself after it has been idle.
  - **Radio stations:** add, rename, reorder and remove stations in the browser and save. The change works at once with no restart, the old file is kept as `config.json.web.bak`, and a list the bot would not accept is refused with the reason. Stations must be public web addresses; add ones on your own network by editing `config.json`.
  - **Log:** the most recent lines of today's log, filterable to warnings or errors, with optional auto-refresh. Login codes, passwords and tokens are hidden.
- New admin command `!goto <channel name>` (or `!goto #<id>`) sends the bot to a channel. The dashboard's Bring bot here button uses it.
- Every button still just runs a chat command as you, except the two things that have no command (saving stations and reading the log), which check that you are a bot admin.
- Fixed: loaded configs shared one object for the built-in defaults, so changing one could change another. Each now has its own copy.
- Development: the page and browser test helpers moved to `test/web-helpers.ts`.

## 0.8.0
- **The dashboard can now be reached over the internet, safely, through a reverse proxy.** New setting `web.publicUrl` (for example `"https://ts6.example.com"`). The bot itself still listens only on `127.0.0.1`; a web server such as Caddy on the same machine handles HTTPS and forwards requests to it. With `publicUrl` set, the dashboard also accepts requests addressed to exactly that name, with a matching `https` origin, and refuses every other name as before.
- Over the public address the login cookie is marked `Secure` and browsers are told to keep using HTTPS (`Strict-Transport-Security`). The local address behaves exactly as in 0.7.0.
- **Guessing login codes is now limited per visitor**, using the address the proxy reports, so a stranger guessing cannot lock out the real users. A shared allowance across everyone still stops guessing spread over many addresses.
- `!weblogin` tells people to open the public address when one is set.
- README: a new section shows a Caddy setup, including the case where port 80 is not free.

## 0.7.0
- **New `web` cog: a browser dashboard** (opt-in: add `"web"` to `cogs`). Shows what is playing with a progress bar and controls for pause, skip, stop and volume, plus the queue, adding music by link or search, radio stations, saved playlists and the bot's replies. It listens only on this machine (`127.0.0.1`).
- **Sign in with `!weblogin`:** a one-time code, sent privately, signs you in as your TeamSpeak identity. No passwords. Wrong guesses are rate-limited.
- **Same rules as chat, by construction:** every button runs the matching chat command as you via the new `bot.runCommandAs`, so admin lists, group rules and cooldowns all apply.
- Protections: Host and Origin checks, JSON-only requests, size and rate limits, strict security headers, and outside text shown only as plain text.
- New `web` settings (`web.host`, `web.port`, `web.codeMinutes`, `web.sessionHours`); the audio cog now offers a read-only `state()`, and the playlists cog offers a `playlists` service.
- Spotify: a featured artist who is already credited is no longer repeated in the title ("Post Malone, Morgan Wallen - I Had Some Help").
- Development: jsdom is a new dev-only dependency, used to test the real page.
- README: Spotify song links, the Spotify album message and radio song titles are recorded as verified on a real server.

## 0.6.0
- **Spotify song links now work**, with no Spotify account or keys: the bot reads the song and artist from the link's public preview data and plays the best YouTube match, named after the Spotify song. Albums, playlists, artists and podcasts get a clear explanation instead. Only Spotify's own pages are ever contacted, including through short-link redirects.
- **Radio "now playing":** while a station plays, the bot reads the song titles it announces (ICY) and `!np` shows the current one. `audio.radioNowPlaying` (default on) controls the small second connection this needs, and `audio.announceRadioTitles` (default off) posts each new title in the channel.
- The audio service's current track gained `liveTitle`.
- README: playlist editing, vote skip, SoundCloud and Bandcamp links, and server-group reporting are now recorded as verified on a real server.

## 0.5.0
- New `voteskip` cog: `!voteskip` (`!vs`) skips the current track once more than half of the people in the bot's channel have voted (`voteskip.threshold`).
- New permission rules by server group or unique ID, per command (`permissions.commands`), for restricting everyday commands or delegating admin ones. `!whoami` now shows your server groups so you can find the IDs. The bot warns at start-up about rules that match no command.
- Playlists can now be edited: `!playlist add <name> | <link or search>`, `remove`, `move` and `rename`.
- The audio service gained `skip()` and `resolve()`, and the playing track has an `id`.
- Spotify links now get a clear explanation instead of a failed lookup. SoundCloud and Bandcamp links (including sets and albums) are documented; yt-dlp recognises them.
- README: the verified-status table now records playlists and starting after a reboot as verified on a real server.
- Existing installs: add `"voteskip"` to `cogs` in `config.json`.

## 0.4.0
- New `playlists` cog: `!playlist save|load|list|show|delete`. Saves the current track plus the queue under a name and loads it later; loading follows the caller into their channel like `!play`. Only a playlist's owner or an admin can overwrite or delete it. Stored in `data/playlists.json` (a damaged file is set aside, never overwritten).
- New service registry for cogs (`bot.services`), so one cog can use another without importing it. The audio cog now offers an `audio` service; playlists use it.
- New settings `playlists.maxPlaylists` and `playlists.maxTracks`.
- Existing installs: add `"playlists"` to `cogs` in `config.json`.

## 0.3.1
- Fixed: restarting the bot, or using `!reload audio` / `!unload audio`, while a track was playing logged a harmless "audio cog is not loaded" error. The audio cog now finishes quietly.
- README: the avatar upload and updating a live Windows service are now marked as verified on a real server.

## 0.3.0
- New `avatar` cog: `!avatar` (admins) uploads the bot's avatar, the Roadie icon by default, and `!avatar clear` removes it. The avatar is also set automatically on connect when the server does not already show it (`avatar.applyOnConnect`, `avatar.file`).
- Uses TeamSpeak's file-transfer port (TCP), which must be reachable from the bot. See the README's Avatar section.
- Existing installs: add `"avatar"` to `cogs` in `config.json`.

## 0.2.0
- Renamed to **TS6 Roadie**; added MIT license and third-party notices.
- Example config and tests no longer contain any server-specific values.
- Added GitHub Actions CI (typecheck, build, tests).

## 0.1.0
- First working release: connects to TeamSpeak 6 as a normal voice client,
  follows the caller, plays YouTube (yt-dlp) and radio streams, cog system,
  versioned config with migrations, scripted install/update/rollback.
