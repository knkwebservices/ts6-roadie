import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Cog, CogFactory, CogManifest } from '../../core/types.js';
import { errMessage } from '../../util/text.js';

export const manifest: CogManifest = {
  name: 'avatar',
  version: '1.0.0',
  description: "Sets the bot's TeamSpeak avatar (the Roadie icon by default)",
};

/** How long after connecting to wait before uploading, so the session has settled. */
const APPLY_DELAY_MS = 3_000;

const factory: CogFactory = (bot): Cog => {
  const p = bot.config.prefix;
  const cfg = bot.config.avatar;
  const log = bot.log.child('avatar');

  // <install>/assets/roadie-avatar.png, whether we are running from src/ (dev) or dist/ (built).
  const bundled = fileURLToPath(new URL('../../../assets/roadie-avatar.png', import.meta.url));
  const imagePath = (): string => (cfg.file ? (isAbsolute(cfg.file) ? cfg.file : join(bot.dataDir, cfg.file)) : bundled);

  async function apply(force: boolean): Promise<string> {
    const file = imagePath();
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch (e) {
      throw new Error(`could not read the avatar image at ${file} (${errMessage(e)})`);
    }
    const r = await bot.adapter.setAvatar(bytes, { force });
    return r.status === 'unchanged' ? 'The avatar is already up to date.' : `Avatar uploaded (${Math.round(r.bytes / 102.4) / 10} KB).`;
  }

  let off: (() => void) | undefined;
  let timer: NodeJS.Timeout | undefined;

  function scheduleApply(): void {
    if (!cfg.applyOnConnect) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!bot.adapter.connected) return;
      apply(false).then(
        (m) => log.info(m),
        // Never chat about this: a failing upload (closed port, no permission) should not spam the channel.
        (e) => log.warn(`could not set the avatar: ${errMessage(e)}`),
      );
    }, APPLY_DELAY_MS);
    timer.unref?.();
  }

  return {
    commands: [
      {
        name: 'avatar',
        description: "Upload the bot's avatar now (or remove it with 'clear')",
        usage: `${p}avatar [clear]`,
        perm: 'admin',
        run: async (ctx) => {
          if (ctx.args[0]?.toLowerCase() === 'clear') {
            try {
              await bot.adapter.clearAvatar();
              return ctx.reply('Avatar removed.');
            } catch (e) {
              return ctx.reply(errMessage(e));
            }
          }
          try {
            return ctx.reply(await apply(true));
          } catch (e) {
            return ctx.reply(`Could not set the avatar: ${errMessage(e)}`);
          }
        },
      },
    ],

    onLoad() {
      off = bot.events.on('ready', scheduleApply);
      if (bot.adapter.connected) scheduleApply(); // loaded with !load while already connected
    },

    onUnload() {
      off?.();
      if (timer) clearTimeout(timer);
    },

    status() {
      return cfg.applyOnConnect ? `sets ${cfg.file || 'the bundled icon'} on connect` : 'manual only';
    },
  };
};

export default factory;
