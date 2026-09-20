# Third-party notices

TS6 Roadie is MIT-licensed (see `LICENSE`). It builds on the work below. Each
component keeps its own license and copyright.

## Bundled or installed with the bot

| Component | Used for | License | Copyright |
| --- | --- | --- | --- |
| [`@echosixhiya/teamspeak-client`](https://github.com/EchoSixHIYA/teamspeak-js) v0.2.4 | The TeamSpeak protocol (connecting, chat, voice). Vendored as a pinned build in `vendor/`, commit `79cb2afb374c5f9727ed15db9f30346fa78b2c05`. Its own license text ships inside the tarball. | MIT | (c) 2026 BBQ |
| [`opusscript`](https://github.com/abalabahaha/opusscript) v0.1.1 | Opus audio encoding (WebAssembly build of libopus 1.4) | MIT | (c) 2016-2021 abalabahaha |
| [libopus](https://opus-codec.org/) (inside `opusscript`) | The Opus codec | BSD-style license | Xiph.Org Foundation and contributors |
| [`@noble/curves`](https://github.com/paulmillr/noble-curves) and [`@noble/hashes`](https://github.com/paulmillr/noble-hashes) | Cryptography used by the TeamSpeak library | MIT | (c) Paul Miller |

The TeamSpeak library's authors credit the [TSLib](https://github.com/Splamy/TS3AudioBot)
implementation in TS3AudioBot by Splamy as the main source of their protocol
knowledge.

## Programs you install yourself (not bundled)

| Program | Used for | License |
| --- | --- | --- |
| [ffmpeg](https://ffmpeg.org/) | Decoding audio | LGPL or GPL, depending on the build you install |
| [yt-dlp](https://github.com/yt-dlp/yt-dlp) | Looking up and fetching audio from YouTube and other sites | Unlicense |

Roadie runs these as separate programs. It does not include or link to them.

## Trademarks

TeamSpeak is a registered trademark of TeamSpeak Systems GmbH. This project is
not affiliated with, endorsed by, or associated with TeamSpeak Systems GmbH.
