import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from './util/fs.js';

/** Small persistent key/value store (data/state.json) for things the bot learns at runtime. */
export class StateStore {
  #file: string;
  #data: Record<string, unknown> = {};

  constructor(dataDir: string, fileName = 'state.json') {
    this.#file = join(dataDir, fileName);
    if (existsSync(this.#file)) {
      try {
        this.#data = JSON.parse(readFileSync(this.#file, 'utf8'));
      } catch {
        // A corrupt state file is not worth refusing to start over.
        this.#data = {};
      }
    }
  }

  get<T>(key: string, fallback: T): T {
    return key in this.#data ? (this.#data[key] as T) : fallback;
  }

  set(key: string, value: unknown): void {
    this.#data[key] = value;
    writeJsonAtomic(this.#file, this.#data);
  }

  delete(key: string): void {
    delete this.#data[key];
    writeJsonAtomic(this.#file, this.#data);
  }
}
