import { resolve } from 'node:path';
import type { AudioDeps } from '../src/cogs/audio/index.js';
import type { PlayInput, PlayResult, PlayerLike } from '../src/cogs/audio/player.js';
import type { MediaInfo } from '../src/cogs/audio/sources.js';
import { makeBot, makeConfig, type Harness } from './helpers.js';

/** Player whose tracks last until the test says so. */
export class FakePlayer implements PlayerLike {
  volume = 0.5;
  playing = false;
  paused = false;
  positionSec = 0;
  played: PlayInput[] = [];
  /** Make the next play() fail straight away with this message. */
  failNext: string | undefined;
  #finish?: (r: PlayResult) => void;
  play(input: PlayInput) {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = undefined;
      this.played.push(input);
      return Promise.resolve<PlayResult>({ reason: 'error', error, seconds: 0 });
    }
    this.playing = true;
    this.played.push(input);
    return new Promise<PlayResult>((res) => {
      this.#finish = (r) => {
        this.playing = false;
        this.paused = false;
        res(r);
      };
    });
  }
  stop() {
    this.#finish?.({ reason: 'stopped', seconds: 0 });
  }
  endTrack() {
    this.#finish?.({ reason: 'ended', seconds: 1 });
  }
  pause() {
    this.paused = true;
    return true;
  }
  resume() {
    const was = this.paused;
    this.paused = false;
    return was;
  }
  dispose() {
    this.stop(); // like the real Player: disposing ends whatever is playing
  }
}

export interface RadioListener {
  url: string;
  emit(title: string): void;
  stopped: boolean;
}

export interface Rig extends Harness {
  radio: RadioListener[];
  player: FakePlayer;
  resolveCalls: string[];
  setResolver(fn: (q: string) => Promise<MediaInfo[]>): void;
}

const audioEntry = resolve(import.meta.dirname, '../src/cogs/audio/index.ts');

export async function makeRig(configOver: Record<string, unknown> = {}): Promise<Rig> {
  const player = new FakePlayer();
  const resolveCalls: string[] = [];
  const radio: RadioListener[] = [];
  let resolver: (q: string) => Promise<MediaInfo[]> = async (q) => [{ title: `Song for "${q}"`, url: `https://www.youtube.com/watch?v=${encodeURIComponent(q)}`, durationSec: 200 }];
  const deps: AudioDeps = {
    resolveMedia: async (q) => {
      resolveCalls.push(q);
      return resolver(q);
    },
    createPlayer: () => player,
    toolVersion: async () => 'test',
    startRadioTitles: (url, onTitle) => {
      const l: RadioListener = { url, emit: onTitle, stopped: false };
      radio.push(l);
      return () => {
        l.stopped = true;
      };
    },
  };
  (globalThis as Record<string, unknown>).__audioDeps = deps;
  // A drop-in cog that wires the real audio cog to the fake dependencies.
  const h = await makeBot({
    config: makeConfig({ cogs: ['core', 'audiotest'], ...configOver }),
    customCogs: {
      audiotest: `
        import { createAudioCog } from ${JSON.stringify('file://' + audioEntry)};
        export const manifest = { name: 'audiotest', version: '1', description: 'audio with fakes' };
        export default (bot) => createAudioCog(bot, globalThis.__audioDeps);`,
    },
  });
  return { ...h, player, radio, resolveCalls, setResolver: (fn) => (resolver = fn) };
}

export const sentTexts = (r: Rig) => r.adapter.sent.map((s) => s.text);
