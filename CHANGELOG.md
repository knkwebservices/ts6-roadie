# Changelog

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
