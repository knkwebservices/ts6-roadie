# Changelog

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
