/**
 * Post-build smoke test: proves the built bot can still do the TeamSpeak handshake and
 * see the channel list against the real server. deploy.mjs runs this before switching to
 * a new release, so a protocol change in a server update is caught before the live bot
 * is touched.
 *
 *   node dist/smoke.js            connect, check the directory, disconnect
 *   node dist/smoke.js --tone     ...and also play one second of test tone in the bot's channel
 *
 * It uses its own identity (data/smoke-identity.json) and nickname so it never collides
 * with the running bot.
 */
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { TeamspeakAdapter } from './adapter/teamspeak.js';
import { loadOrCreateIdentity } from './adapter/identity.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createOpusEncoder } from './cogs/audio/opus.js';
import { FRAME_BYTES, FRAME_MS } from './cogs/audio/player.js';
import { sleep } from './util/text.js';
import { BOT_VERSION, tsLibVersion } from './version.js';

async function main(): Promise<void> {
  const dataDir = resolve(process.env.TSBOT_DATA ?? './data');
  const config = loadConfig(dataDir);
  const log = createLogger({ level: config.logLevel });
  const fail = (msg: string): never => {
    console.error(`SMOKE FAIL: ${msg}`);
    process.exit(1);
  };

  log.info(`smoke test: bot ${BOT_VERSION}, TS library ${tsLibVersion()}`);
  const { identity, uid } = await loadOrCreateIdentity(join(dataDir, 'smoke-identity.json'), config.server.identityLevel, log);
  const nickname = `${config.server.nickname.slice(0, 22)}-smoke`;

  const adapter = new TeamspeakAdapter({
    address: config.server.address,
    password: config.server.password,
    nickname,
    homeChannel: config.server.homeChannel,
    homeChannelPassword: config.server.homeChannelPassword,
    identity,
    selfUid: uid,
    log: log.child('adapter'),
  });

  const connected = new Promise<void>((res) => adapter.events.on('connected', res));
  adapter.start();
  const timeout = sleep(45_000).then(() => 'timeout' as const);
  if ((await Promise.race([connected.then(() => 'ok' as const), timeout])) === 'timeout') {
    await adapter.stop();
    fail(`could not connect and finish the handshake within 45s. Last error: ${adapter.lastError ?? 'none - the server never answered (wrong address/port, or UDP blocked?)'}`);
  }

  // Give the channel list a moment to arrive.
  for (let i = 0; i < 50 && adapter.channels().length === 0; i++) await sleep(200);
  const channels = adapter.channels();
  if (channels.length === 0) {
    await adapter.stop();
    fail('connected, but the channel list stayed empty');
  }
  const home = config.server.homeChannel ? adapter.findChannel(config.server.homeChannel) : undefined;
  if (config.server.homeChannel && !home) {
    await adapter.stop();
    fail(`connected, but the home channel "${config.server.homeChannel}" does not exist`);
  }
  log.info(`smoke: ${channels.length} channels, ${adapter.users().length} other users visible, in channel #${adapter.selfChannelId()}`);

  if (process.argv.includes('--tone')) {
    log.info('smoke: sending 1s of test tone');
    const enc = createOpusEncoder(config.audio.bitrate);
    const ff = spawn(config.audio.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-af', 'volume=0.2', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1'], {
      stdio: ['ignore', 'pipe', 'inherit'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    for await (const c of ff.stdout) chunks.push(c as Buffer);
    const pcm = Buffer.concat(chunks);
    const start = Date.now();
    for (let i = 0, n = 0; i + FRAME_BYTES <= pcm.length; i += FRAME_BYTES, n++) {
      adapter.sendVoice(enc.encode(pcm.subarray(i, i + FRAME_BYTES)), config.audio.codec);
      await sleep(Math.max(0, start + (n + 1) * FRAME_MS - Date.now()));
    }
    adapter.sendVoice(new Uint8Array(0), config.audio.codec);
    enc.destroy();
  }

  await adapter.stop();
  console.log('SMOKE OK');
  process.exit(0);
}

main().catch((e) => {
  console.error('SMOKE FAIL:', e instanceof Error ? e.message : e);
  process.exit(1);
});
