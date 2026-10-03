# Changelog

## 0.20.0
- **New `fallout76` cog** (opt-in: add `"fallout76"` to `cogs` and restart; no settings).
  - **`!nukes [alpha|bravo|charlie]`** (alias `!nuke`, everyone): this week's nuke codes from [NukaCrypt](https://nukacrypt.com) (credited in every reply), with when they change. Fetched once per weekly change and kept in `data/state.json`; after the change the bot retries every 15 minutes (never more often) until NukaCrypt has the new codes, and says so instead of showing last week's. `!nukes refresh` (admins) fetches now.
  - **`!minerva`** (everyone): where Minerva is now and when she leaves, or where and when she comes next; `!minerva list` shows her next visits. Her published schedule (lists 4 to 16, October 2026 to January 2027) is built in, at noon US Eastern with daylight saving handled. Admins can `!minerva add <date> <place> [list]` and `!minerva remove <date>` to keep it current between releases.

## 0.19.0
- **New `events` cog** (opt-in: add `"events"` to `cogs` and restart): event reminders and rotating announcements, posted in the bot's channel (`events.postTo` / `announcements.postTo` can be `"server"` for the server-wide chat, which the TeamSpeak 6 client has nowhere to show).
  - **Events:** `!event add Friday 8pm | Nuke run` (also `tomorrow 7:30pm`, `today 9pm`, `10/31 8pm`, `in 2h`, and `weekly Friday 8pm` to repeat), `!events`, `!event <n>`, `!event remove <n>`. Everyone can `!going [n]` / `!notgoing [n]`. A reminder goes out `events.remindMinutes` (default 60) before, and privately to everyone going who is online; at the start the bot posts "Starting now" and pokes everyone going who is online. Weekly events roll on with an empty going list; a start missed while the bot was down isn't announced late. Bot admins add events unless `events.whoCanAdd` is `"everyone"`; the person who added one (or an admin) can remove it.
  - **Rotating announcements:** `!announce add <text>`, `!announce on`, `!announce every <minutes>`, `!announce now`, `!announce remove <n>` (admins). One message at a time, in turn, every `announcements.everyMinutes` (default 60), only while someone is online.
- **New `nickfilter` cog** (opt-in): blocked words in nicknames, matched ignoring case and common letter swaps (`N00B` for `noob`). The person is poked and asked to rename within `nickfilter.graceSeconds` (default 60); then, by `!nickfilter action`, the admins are told (**warn**, the default), they're moved to `nickfilter.moveChannel` (**move**), or they're kicked (**kick**). Bot admins and `nickfilter.exemptGroups` are never checked.
- **`!record reset`** (admins) starts the online record again from who's online now.
- **The deploy smoke test's client is no longer counted as a person**, so it can't set the online record or show up in `!seen`, the AFK mover, analytics or ranks. It's recognised by its saved identity (`data/smoke-identity.json`) and its nickname.
- The adapter can now post in the server-wide chat, poke and kick (`sendServer`, `poke`, `kickUser`).
- CI: `actions/checkout` and `actions/setup-node` updated to v5 (GitHub is retiring the Node 20 versions).

## 0.18.0
- **New `grouptools` cog** (opt-in: add `"grouptools"` to `cogs` and restart).
  - **Ranks for time online** (`!ranks`, admins; `!rank [name]`, alias `!hours`, everyone). A ladder of `hours -> server group` (`!ranks add 10 9 Regular`, then `!ranks on`). Time is counted every minute for everyone online, but not while away (`grouptools.ranks.countAway`), in `grouptools.ranks.ignoreChannels` (default "AFK Room"), or for `grouptools.ranks.exemptGroups`. Reaching a rank adds its group, tells the person, and (with `grouptools.ranks.replaceLower`, default on) takes away the lower ranks' groups. `!ranks give <name> <hours>` sets someone's total, for people who were around before ranks. Kept in `data/ranks.json`; a gap longer than five minutes (sleep, a long reconnect) is never counted as time online. Nobody is ever demoted.
  - **Protected server groups** (`!protect`, admins). Only listed unique IDs (plus bot admins) may be in a protected group. `!protect add <group>` allows everyone online in it at that moment and says offline members must be added with `!protect allow`. Starts in **warn mode** (`grouptools.protect.mode`): online bot admins are warned privately, at most every 30 minutes per person, and nothing is changed. `!protect mode remove` makes the bot take people out, and tell the admins. A failed change is retried after ten minutes, not hammered.
  - `!ranks give` and `!ranks check` say why a rank could not be given (for example a missing permission), instead of only logging it.
  - Every group decision uses the person's groups **asked from the server** (up to 10 people per check, refreshed every two minutes, newcomers first), not the client list: on TeamSpeak 6 the client list is not told about server-group changes made while someone is online, so it can be out of date indefinitely. This also means someone given a protected group while online is noticed. A rank is only congratulated when it was really added, and the server answering "already in that group" or "already out of it" counts as done, not as a failure.
- The adapter can now add people to and remove them from server groups, and ask the server for someone's current groups (`addServerGroup`, `removeServerGroup`, `userGroups`).

## 0.17.0
- **New `rooms` cog: temporary rooms** (opt-in: add `"rooms"` to `cogs`, restart, and `!rooms on`). Join a "Create a Room" channel (`rooms.creatorChannel`) and the bot makes you a temporary channel of your own ("Ann's Room", from `rooms.nameTemplate`), moves you in and makes you its channel admin (`rooms.ownerChannelGroup`, default 5) so you can rename it or set a password yourself. The **server** deletes the room once it has been empty for `rooms.deleteDelaySeconds` (default 60), so cleanup never depends on the bot. Rooms are sub-channels of the join channel unless `!rooms under <channel>` says otherwise; clashing names get "(2)". Joining again takes you back to your room instead of making another, and `!room` (everyone) moves you there from anywhere. One new room per person per `rooms.cooldownSeconds` (default 30), at most `rooms.maxRooms` (default 25) open at once. If the server moves the bot into a room it created, the bot goes back to where it was once the owner is in. A refused create (usually a missing permission) is explained to the person and logged.
- The adapter can now create temporary channels (`createTempChannel`) and assign channel groups (`setChannelGroup`).

## 0.16.0
- **New `servertools` cog** (opt-in: add `"servertools"` to `cogs` and restart): things TeamSpeak 3 servers used to get from separate bots.
  - **Support notifier** (`!notify`, admins only). When someone joins a chosen channel, the online members of chosen server groups get a private message. `!notify add Support Room | 12`, then `!notify on`. Connecting straight into the channel counts; members of the notified groups joining it themselves do not; the same person is announced at most once every `servertools.notify.cooldownSeconds` (default 120); people already there when the bot connects are not announced. `!notify message` changes the text (`{name}`, `{channel}`), `!notify test <n>` sends it now. Rules remember the channel by its number, so renaming the channel does not break them.
  - **Live channel names** (`!livename`, admins only). Keeps a channel's name up to date from a template: `{online}` (people online now), `{record}` (most ever at once) and `{song}` (what Roadie is playing, the live title for radio). `!livename add Online | [cspacer]Online: {online}`, then `!livename on`. Names are kept within TeamSpeak's 40 characters (a long song is shortened with "..."), and each channel is renamed only when the name would change and at most every `servertools.liveNames.updateSeconds` (default 60, minimum 30). `!livename now` updates at once. A refused rename (usually a missing `b_channel_modify_name` permission) is reported in chat and logged once, then retried after a few minutes rather than hammered.
  - **`!seen <name>`** (everyone, alias `!lastseen`): online now and in which channel, or when last seen. Part of a name works, and people are remembered by unique ID so a new nickname is still the same person. Kept in `data/seen.json` (name, first and last seen only); people not seen for `servertools.seen.keepDays` (default 365) are forgotten. `servertools.seen.enabled: false` switches it off.
  - **`!record`** (everyone): the most people ever online at once, and when.
- The adapter can now rename channels (`renameChannel`).
- Chat commands keep channel spacer markers (`[cspacer]`, `[lspacer]`, `[rspacer]`) instead of stripping them as formatting, so they can be typed into `!livename`.
- `deploy.mjs --no-service` no longer prints "stopping service" and "starting service" lines for a service it does not touch, and says so on its last line.
- README: a link to the write-up on knkws.com.

## 0.15.0
- **New `twitch` cog** (opt-in: add `"twitch"` to `cogs` and restart): posts in the channel when someone you're tracking goes live on Twitch. Needs a free app from https://dev.twitch.tv/console/apps (`twitch.clientId` / `twitch.clientSecret`; Twitch requires two-factor authentication on the account registering it). `!twitch add <channel> [label]` tracks a channel by its Twitch login (admins), plain `!twitch` (or `!live`) lists everyone tracked and who's live, `!twitch on|off|interval <seconds>|check` (admins) control it. Up to 25 channels. The first check after loading (or adding someone) never announces a stream that was already running, so a restart is quiet; only *going live* is posted, with the game and title when Twitch reports them. Going offline is not announced. An expired app token is refreshed automatically (once per failed check, never silently retried forever), and a bad client ID/secret or a Twitch outage shows up in `!twitch` rather than spamming the channel.
- The steam, community, playlists and analytics cogs' services are joined by a `twitch` service (`src/core/services.ts`), for a future dashboard card.

## 0.14.0
- **New `analytics` cog** (opt-in: add `"analytics"` to `cogs` and restart): tracks peak times, the busiest channels, the most-played songs, and uptime. `!analytics` (or `!stats`) gives everyone a summary; `!analytics hours|channels|songs [count]` drill into each one; `!analytics on|off|interval <seconds>|reset|check` (admins) control it. Samples who's online every `analytics.pollSeconds` (default 300s) and keeps running totals rather than a raw log, so it stays lightweight over time. Song counts are pulled from the audio cog's own play history, so they need `"audio"` loaded too. Uptime is tracked as a series of sessions in `data/analytics.json`, so a crash still leaves a close estimate of when the bot went down, and nothing is lost across restarts.
- The steam, community and playlists cogs' services are joined by an `analytics` service (`src/core/services.ts`), for a future dashboard card.

## 0.13.0
- **New `steam` cog** (opt-in: add `"steam"` to `cogs` and restart): tells the channel when someone you're tracking starts (or switches) a game on Steam. Needs a free API key from https://steamcommunity.com/dev/apikey (`steam.apiKey`). `!steam add <steamid64> [label]` tracks a person (admins), plain `!steam` lists everyone tracked and what they're doing, `!steam on|off|interval <seconds>|check` (admins) control it. Up to 25 people. The first check after loading (or adding someone) never announces what was already true, so a restart is quiet; only a change is posted, and stopping is not announced. A bad key or a Steam outage shows up in `!steam` rather than spamming the channel.
- The community and playlists cogs' services are joined by a `steam` service (`src/core/services.ts`), for a future dashboard card.

## 0.12.0
- **New `community` cog** (opt-in: add `"community"` to `cogs` in `config.json` and restart): an AFK mover and a welcome message.
  - **AFK mover** (`!afk`, admins only). Someone who has been away, muted (microphone or speakers) or idle for `community.afk.minutes` (default 30) is moved to the AFK channel (`community.afk.channel`, default "AFK Room"). They get a private warning `community.afk.warnSeconds` (default 60) seconds before, and a note when they are moved. When they are active again (not away, not muted, and something done in the last minute) they are moved back to the channel they were in, even after a bot restart. Bot admins, members of `community.afk.exemptGroups` and people in `community.afk.ignoreChannels` are never moved, and people who choose the AFK channel themselves are left alone. Idle time is asked from the server for a few people at a time (never a flood of questions) and checked again just before anyone is moved, so someone who has just come back is not moved by an out-of-date figure.
  - **Welcome message** (`!welcome`, admins only): a private message to everyone each time they join (`{name}` becomes their nickname). People already there when the bot connects are not greeted, and the same person reconnecting within `community.welcome.cooldownSeconds` is not greeted twice. Change the text with `!welcome set <text>`, try it with `!welcome test`.
  - Turn them on with `!afk on` and `!welcome on` or from the dashboard's new **Community** card on the Admin tab; the settings are remembered.
- **A public widget** for your website (`!widget on`, off by default): `/widget` is a small page to embed, and `/widget.json` is the data. It shows what is playing and who is online, by name and channel (or only counts with `!widget names off`). Only channels with people in them are listed, no unique IDs or track addresses are included, and anyone can leave their name off with `!hideme`. Websites that may embed the page or read the data are listed in `web.widget.origins`; none may until you list them. Read-only, rate limited per visitor, cached for a few seconds, and marked noindex. The rest of the dashboard is exactly as closed as before.
- The adapter can now move other people, read a person's idle time, and see who is away or muted.

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
