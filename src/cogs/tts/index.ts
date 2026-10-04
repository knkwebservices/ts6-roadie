import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage } from '../../adapter/types.js';
import { AUDIO_SERVICE, type AudioService } from '../../core/services.js';
import type { BotApi, Cog, CogFactory, CogManifest, CommandContext } from '../../core/types.js';
import { errMessage } from '../../util/text.js';
import { normalizePcm, scalePcm, synthesize, windowsVoices, type SynthOptions, type TtsEngine } from './engine.js';

export const manifest: CogManifest = {
  name: 'tts',
  version: '1.0.0',
  description: 'Text to speech: !say reads a message aloud, and !tts on reads everything you type to the bot',
};

/** At most this many messages waiting to be read out. */
const MAX_WAITING = 5;
/** After this long without hearing from someone, their name is said again before their next message. */
const NAME_AGAIN_MS = 2 * 60_000;

export interface TtsDeps {
  /** Turn text into 48 kHz 16-bit stereo PCM. */
  synthesize(text: string, o: SynthOptions): Promise<Buffer>;
  voices(): Promise<string[]>;
}

const defaultDeps: TtsDeps = { synthesize, voices: windowsVoices };

interface Settings {
  engine: TtsEngine;
  voice: string;
  rate: number;
  volume: number;
  /** What happens to music in the same channel while speaking: turned right down, or paused. */
  music: 'duck' | 'pause';
}

/** Make chat text fit to be read aloud: no BBCode, links said as "a link", one line, not too long. */
export function speakable(text: string, maxChars: number): string {
  let t = text
    .replace(/\[url=[^\]]*\]([\s\S]*?)\[\/url\]/gi, ' a link ')
    .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, ' a link ')
    .replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, ' ')
    .replace(/https?:\/\/\S+/gi, ' a link ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (t.length > maxChars) t = `${t.slice(0, maxChars).replace(/\s+\S*$/, '')}...`;
  return t;
}

export function createTtsCog(bot: BotApi, deps: TtsDeps = defaultDeps): Cog {
  const cfg = bot.config.tts;
  const p = bot.config.prefix;
  const log = bot.log.child('tts');
  const adapter = bot.adapter;
  const tmpDir = join(bot.dataDir, 'tts');

  let settings: Settings = { engine: cfg.engine, voice: cfg.voice, rate: cfg.rate, volume: cfg.volume, music: cfg.music, ...bot.state.get<Partial<Settings>>('tts.settings', {}) };
  /** People who have "read everything I type" on (by unique ID). */
  let readers = new Set(bot.state.get<string[]>('tts.readers', []));
  const lastUsed = new Map<string, number>();
  let lastSpeaker = '';
  let lastSpokeAt = 0;
  let waiting = 0;
  let chain: Promise<void> = Promise.resolve();
  let fileNo = 0;
  let offMessage: (() => void) | undefined;

  const save = (next: Settings): void => {
    settings = next;
    bot.state.set('tts.settings', next);
  };
  const saveReaders = (): void => bot.state.set('tts.readers', [...readers]);
  const allowed = (uid: string, groups: number[]): boolean => bot.isAdmin(uid) || !cfg.allowedGroups.length || groups.some((g) => cfg.allowedGroups.includes(g));

  /**
   * Read `text` aloud for this person, in their channel. Returns '' when it was said, or a reason it wasn't
   * (safe to show them).
   */
  function speak(who: { id: number; uid: string; name: string }, text: string, opts: { force?: boolean } = {}): Promise<string> {
    const audio = bot.services.get<AudioService>(AUDIO_SERVICE);
    if (!audio) return Promise.resolve('Text to speech needs the audio cog, which is not loaded.');
    const clean = speakable(text, cfg.maxChars);
    if (!clean) return Promise.resolve('There is nothing to say in that message.');
    const now = Date.now();
    const last = lastUsed.get(who.uid);
    if (!opts.force && !bot.isAdmin(who.uid) && last !== undefined && now - last < cfg.cooldownSeconds * 1000) {
      return Promise.resolve(`Slow down a little: one message every ${cfg.cooldownSeconds} seconds.`);
    }
    if (waiting >= MAX_WAITING) return Promise.resolve("I've got a few messages to read already. Try again in a moment.");
    lastUsed.set(who.uid, now);
    if (lastUsed.size > 500) for (const [k, t] of lastUsed) if (now - t > 600_000) lastUsed.delete(k);
    waiting++;

    const job = chain.then(async (): Promise<string> => {
      try {
        const withName = cfg.sayName && (lastSpeaker !== who.uid || Date.now() - lastSpokeAt > NAME_AGAIN_MS) ? `${who.name} says: ${clean}` : clean;
        mkdirSync(tmpDir, { recursive: true });
        const pcm = await deps.synthesize(withName, {
          engine: settings.engine,
          voice: settings.voice,
          rate: settings.rate,
          piperPath: cfg.piperPath,
          piperModel: cfg.piperModel,
          ffmpegPath: bot.config.audio.ffmpegPath,
          wavFile: join(tmpDir, `say-${process.pid}-${++fileNo}.wav`),
        });
        const r = await audio.speakFor(who.id, scalePcm(normalizePcm(pcm), settings.volume / 100), { pauseMusic: settings.music === 'pause' });
        if (!r.ok) return r.reason;
        lastSpeaker = who.uid;
        lastSpokeAt = Date.now();
        log.debug(`said a message for ${who.name} (${clean.length} characters)`);
        return '';
      } catch (e) {
        const why = errMessage(e);
        log.warn(`could not read out a message for ${who.name}: ${why}`);
        return `Sorry, I couldn't say that (${why}).`;
      } finally {
        waiting--;
      }
    });
    chain = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  /** "Read everything I type": plain messages (not commands) from people who switched it on. */
  function onMessage(m: IncomingMessage): void {
    if (m.scope === 'server' || !readers.has(m.senderUid)) return;
    const text = m.text.trim();
    if (!text || text.startsWith(p)) return;
    if (!allowed(m.senderUid, m.senderGroups)) return;
    void speak({ id: m.senderId, uid: m.senderUid, name: m.senderName }, text).then((why) => {
      if (why) adapter.sendPrivate(m.senderId, why).catch(() => {});
    });
  }

  const status = (): string => {
    const engine = settings.engine === 'piper' ? `Piper (${cfg.piperModel || 'no voice model set!'})` : `Windows voices (${settings.voice || 'the default voice'}, speed ${settings.rate})`;
    return `Text to speech: ${engine}, volume ${settings.volume}, music ${settings.music === 'pause' ? 'pauses' : 'is turned down'} while it speaks. ${readers.size} ${readers.size === 1 ? 'person reads' : 'people read'} everything they type.`;
  };

  async function adminSub(ctx: CommandContext, sub: string): Promise<void> {
    if (!ctx.isAdmin) return ctx.reply('Only bot admins can change the voice settings.');
    const arg = ctx.rest.trim().slice(sub.length).trim();
    if (sub === 'voices') {
      const list = await deps.voices().catch(() => [] as string[]);
      return ctx.reply(list.length ? `Windows voices on this computer: ${list.join(', ')}. Pick one with ${p}tts voice <name>.` : 'I could not list any Windows voices (they only exist when the bot runs on Windows).');
    }
    if (sub === 'voice') {
      if (!arg || arg.toLowerCase() === 'default') {
        save({ ...settings, voice: '' });
        return ctx.reply('Using the default Windows voice.');
      }
      const list = await deps.voices().catch(() => [] as string[]);
      const hit = list.find((v) => v.toLowerCase() === arg.toLowerCase()) ?? list.find((v) => v.toLowerCase().includes(arg.toLowerCase()));
      if (!hit) return ctx.reply(`I don't have a voice called "${arg}". ${p}tts voices lists them.`);
      save({ ...settings, voice: hit });
      return ctx.reply(`The voice is now ${hit}. Try it with ${p}say hello.`);
    }
    if (sub === 'speed' || sub === 'rate') {
      const n = Number(ctx.args[1]);
      if (!Number.isInteger(n) || n < -10 || n > 10) return ctx.reply(`Give a speed from -10 (slow) to 10 (fast), 0 is normal: ${p}tts speed 1`);
      save({ ...settings, rate: n });
      return ctx.reply(`Speaking speed is ${n}.`);
    }
    if (sub === 'volume') {
      const n = Number(ctx.args[1]);
      if (!Number.isInteger(n) || n < 0 || n > 100) return ctx.reply(`Give a volume from 0 to 100: ${p}tts volume 80`);
      save({ ...settings, volume: n });
      return ctx.reply(`Speech volume is ${n}.`);
    }
    if (sub === 'music') {
      const m = ctx.args[1]?.toLowerCase();
      if (m !== 'pause' && m !== 'duck') return ctx.reply(`Usage: ${p}tts music pause (music stops while I speak) or ${p}tts music duck (music is turned right down)`);
      save({ ...settings, music: m });
      return ctx.reply(m === 'pause' ? 'Music in the channel pauses while I speak, then carries on.' : 'Music in the channel is turned right down while I speak.');
    }
    if (sub === 'engine') {
      const e = ctx.args[1]?.toLowerCase();
      if (e !== 'windows' && e !== 'piper') return ctx.reply(`Usage: ${p}tts engine windows|piper`);
      if (e === 'piper' && !cfg.piperModel) return ctx.reply('Set tts.piperModel in config.json to a Piper voice model (.onnx) first, then restart.');
      save({ ...settings, engine: e });
      return ctx.reply(e === 'piper' ? 'Using Piper voices.' : 'Using Windows voices.');
    }
  }

  const cog: Cog = {
    commands: [
      {
        name: 'say',
        aliases: ['speak'],
        description: `Read a message aloud in your channel: ${p}say <text>`,
        usage: `${p}say <text>`,
        run: async (ctx) => {
          const text = ctx.rest.trim();
          if (!text) return ctx.reply(`Usage: ${p}say <text>. Or ${p}tts on to have everything you type to me read out.`);
          if (!allowed(ctx.msg.senderUid, ctx.msg.senderGroups)) return ctx.reply("Text to speech isn't switched on for your server group.");
          const why = await speak({ id: ctx.msg.senderId, uid: ctx.msg.senderUid, name: ctx.msg.senderName }, text);
          if (why) return ctx.reply(why);
        },
      },
      {
        name: 'tts',
        description: `Text to speech. ${p}tts on: everything you type to me (not commands) is read out in your channel; ${p}tts off stops it. Admins: ${p}tts voices|voice|speed|volume|music|engine`,
        usage: `${p}tts [on|off|voices|voice <name>|speed <-10..10>|volume <0-100>|music pause|duck|engine windows|piper]`,
        run: async (ctx) => {
          const sub = ctx.args[0]?.toLowerCase();
          if (!sub || sub === 'status') return ctx.reply(`${status()}\nYou: ${readers.has(ctx.msg.senderUid) ? 'on' : 'off'}. ${p}say <text> reads one message; ${p}tts on reads everything you type to me.`);
          if (sub === 'on') {
            if (!allowed(ctx.msg.senderUid, ctx.msg.senderGroups)) return ctx.reply("Text to speech isn't switched on for your server group.");
            readers.add(ctx.msg.senderUid);
            saveReaders();
            return ctx.reply(`Read-out is on: everything you type to me in a private message (or in my channel) is said aloud in your channel. Commands like ${p}help are not read. ${p}tts off stops it.`);
          }
          if (sub === 'off') {
            readers.delete(ctx.msg.senderUid);
            saveReaders();
            return ctx.reply('Read-out is off.');
          }
          if (['voices', 'voice', 'speed', 'rate', 'volume', 'music', 'engine'].includes(sub)) return adminSub(ctx, sub);
          return ctx.reply(`Usage: ${p}tts [on|off] (admins: voices, voice <name>, speed <n>, volume <n>, engine windows|piper)`);
        },
      },
    ],

    onLoad() {
      readers = new Set(bot.state.get<string[]>('tts.readers', []));
      offMessage = adapter.events.on('message', onMessage);
    },

    onUnload() {
      offMessage?.();
    },

    status,
  };
  return cog;
}

const factory: CogFactory = (bot) => createTtsCog(bot);
export default factory;
