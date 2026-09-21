# Changelog

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
