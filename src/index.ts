import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TeamspeakAdapter } from './adapter/teamspeak.js';
import { loadOrCreateIdentity } from './adapter/identity.js';
import { ConfigError, loadConfig } from './config.js';
import { Bot } from './core/bot.js';
import { createLogger } from './logger.js';
import { StateStore } from './state.js';
import { BOT_VERSION, tsLibVersion } from './version.js';

async function main(): Promise<void> {
  const dataDir = resolve(process.env.TSBOT_DATA ?? './data');
  for (const d of ['', 'logs', 'cogs']) mkdirSync(join(dataDir, d), { recursive: true });

  const bootLog = createLogger({ level: 'info', dir: join(dataDir, 'logs') });
  let config;
  try {
    config = loadConfig(dataDir);
  } catch (e) {
    if (e instanceof ConfigError) {
      bootLog.error(e.message);
      process.exit(2);
    }
    throw e;
  }
  const log = createLogger({ level: config.logLevel, dir: join(dataDir, 'logs') });
  log.info(`TS6 Roadie ${BOT_VERSION} starting (TS library ${tsLibVersion()}, Node ${process.versions.node}, data: ${dataDir})`);

  const { identity, uid } = await loadOrCreateIdentity(join(dataDir, 'identity.json'), config.server.identityLevel, log);
  log.info(`Bot identity UID: ${uid}`);

  const adapter = new TeamspeakAdapter({
    address: config.server.address,
    password: config.server.password,
    nickname: config.server.nickname,
    homeChannel: config.server.homeChannel,
    homeChannelPassword: config.server.homeChannelPassword,
    identity,
    selfUid: uid,
    log: log.child('adapter'),
  });

  const bot = new Bot({
    config,
    adapter,
    state: new StateStore(dataDir),
    log,
    dataDir,
    builtinCogsDir: join(dirname(fileURLToPath(import.meta.url)), 'cogs'),
    onRestart: () => void shutdown(0),
  });

  let stopping = false;
  async function shutdown(code: number): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info('shutting down');
    const force = setTimeout(() => process.exit(code), 8_000);
    force.unref();
    try {
      await bot.stop();
    } catch (e) {
      log.error('error during shutdown', e);
    }
    process.exit(code);
  }
  process.on('SIGINT', () => void shutdown(0));
  process.on('SIGTERM', () => void shutdown(0));
  process.on('unhandledRejection', (e) => log.error('unhandled rejection', e));
  process.on('uncaughtException', (e) => {
    log.error('uncaught exception - exiting so the service manager restarts the bot', e);
    void shutdown(1);
  });

  await bot.start();
  log.info(`Ready. Prefix "${config.prefix}". Connecting to ${config.server.address}...`);
}

main().catch((e) => {
  console.error('fatal:', e);
  process.exit(1);
});
