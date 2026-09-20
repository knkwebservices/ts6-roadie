import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Log } from '../logger.js';
import type { BotApi, Cog, CogManifest, CogModule, CommandDef } from './types.js';

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ENTRY_FILES = ['index.js', 'index.mjs', 'index.ts'];
/** Cogs that hold the bot together and cannot be unloaded from chat. */
const PROTECTED = new Set(['core']);

interface Loaded {
  manifest: CogManifest;
  cog: Cog;
  source: 'builtin' | 'custom';
  commands: string[];
}

export class CogManager {
  readonly #loaded = new Map<string, Loaded>();
  readonly #commands = new Map<string, { cog: string; def: CommandDef }>();
  #generation = 0;

  constructor(
    private readonly bot: () => BotApi,
    private readonly log: Log,
    /** Bundled cogs (dist/cogs). */
    private readonly builtinDir: string,
    /** Optional drop-in cogs (data/cogs) - survive updates of the bot itself. */
    private readonly customDir: string,
  ) {}

  #locate(name: string): { file: string; source: 'builtin' | 'custom' } | undefined {
    for (const [dir, source] of [
      [this.builtinDir, 'builtin'],
      [this.customDir, 'custom'],
    ] as const) {
      for (const f of ENTRY_FILES) {
        const file = join(dir, name, f);
        if (existsSync(file)) return { file, source };
      }
    }
    return undefined;
  }

  /** Every cog folder that could be loaded, loaded or not. */
  available(): { name: string; source: 'builtin' | 'custom' }[] {
    const out: { name: string; source: 'builtin' | 'custom' }[] = [];
    for (const [dir, source] of [
      [this.builtinDir, 'builtin'],
      [this.customDir, 'custom'],
    ] as const) {
      if (!existsSync(dir)) continue;
      for (const n of readdirSync(dir)) {
        if (NAME_RE.test(n) && statSync(join(dir, n)).isDirectory() && this.#locate(n)) {
          if (!out.some((o) => o.name === n)) out.push({ name: n, source });
        }
      }
    }
    return out;
  }

  isLoaded(name: string): boolean {
    return this.#loaded.has(name);
  }

  list(): { manifest: CogManifest; loaded: boolean; source: 'builtin' | 'custom' }[] {
    return this.available().map(({ name, source }) => {
      const l = this.#loaded.get(name);
      return {
        manifest: l?.manifest ?? { name, version: '?', description: '(not loaded)' },
        loaded: !!l,
        source,
      };
    });
  }

  commands(): { cog: string; def: CommandDef }[] {
    const seen = new Set<CommandDef>();
    const out: { cog: string; def: CommandDef }[] = [];
    for (const v of this.#commands.values()) {
      if (!seen.has(v.def)) {
        seen.add(v.def);
        out.push(v);
      }
    }
    return out;
  }

  find(name: string): CommandDef | undefined {
    return this.#commands.get(name.toLowerCase())?.def;
  }

  async status(): Promise<string[]> {
    const lines: string[] = [];
    for (const [name, l] of this.#loaded) {
      if (!l.cog.status) continue;
      try {
        lines.push(`${name}: ${await l.cog.status()}`);
      } catch (e) {
        lines.push(`${name}: status failed (${(e as Error).message})`);
      }
    }
    return lines;
  }

  async load(name: string): Promise<CogManifest> {
    if (!NAME_RE.test(name)) throw new Error(`"${name}" is not a valid cog name`);
    if (this.#loaded.has(name)) throw new Error(`cog "${name}" is already loaded (use reload)`);
    const found = this.#locate(name);
    if (!found) throw new Error(`no cog named "${name}" was found`);

    // The query string defeats the ESM module cache so reload really re-reads the file.
    const mod = (await import(`${pathToFileURL(found.file).href}?v=${++this.#generation}`)) as Partial<CogModule>;
    if (!mod.manifest || typeof mod.default !== 'function') {
      throw new Error(`cog "${name}" must export "manifest" and a default factory function`);
    }
    if (mod.manifest.name !== name) {
      throw new Error(`cog folder "${name}" declares manifest.name "${mod.manifest.name}" - they must match`);
    }

    const cog = await mod.default(this.bot());

    // Register commands; refuse the whole cog if any name is already taken.
    const claimed: string[] = [];
    try {
      for (const def of cog.commands) {
        for (const n of [def.name, ...(def.aliases ?? [])].map((s) => s.toLowerCase())) {
          const clash = this.#commands.get(n);
          if (clash) throw new Error(`command "${n}" is already provided by cog "${clash.cog}"`);
          this.#commands.set(n, { cog: name, def });
          claimed.push(n);
        }
      }
      await cog.onLoad?.();
    } catch (e) {
      for (const n of claimed) this.#commands.delete(n);
      throw e;
    }

    this.#loaded.set(name, { manifest: mod.manifest, cog, source: found.source, commands: claimed });
    this.log.info(`loaded cog ${name} v${mod.manifest.version} (${found.source})`);
    return mod.manifest;
  }

  async unload(name: string): Promise<void> {
    if (PROTECTED.has(name)) throw new Error(`the "${name}" cog cannot be unloaded`);
    const l = this.#loaded.get(name);
    if (!l) throw new Error(`cog "${name}" is not loaded`);
    try {
      await l.cog.onUnload?.();
    } catch (e) {
      this.log.warn(`cog ${name} onUnload threw`, e);
    }
    for (const n of l.commands) this.#commands.delete(n);
    this.#loaded.delete(name);
    this.log.info(`unloaded cog ${name}`);
  }

  /**
   * Re-read a cog's entry file. If the new version fails to load, the old one is put back
   * so a typo can never leave the bot without its commands.
   */
  async reload(name: string): Promise<CogManifest> {
    if (!this.#loaded.has(name)) return this.load(name);
    const previous = this.#loaded.get(name)!;
    await this.#unloadForReload(name);
    try {
      return await this.load(name);
    } catch (e) {
      // Restore the old instance.
      for (const def of previous.cog.commands) {
        for (const n of [def.name, ...(def.aliases ?? [])].map((s) => s.toLowerCase())) this.#commands.set(n, { cog: name, def });
      }
      this.#loaded.set(name, previous);
      try {
        await previous.cog.onLoad?.();
      } catch {
        /* keep going */
      }
      throw new Error(`reload failed, kept the previous version: ${(e as Error).message}`);
    }
  }

  async #unloadForReload(name: string): Promise<void> {
    const l = this.#loaded.get(name)!;
    try {
      await l.cog.onUnload?.();
    } catch (e) {
      this.log.warn(`cog ${name} onUnload threw`, e);
    }
    for (const n of l.commands) this.#commands.delete(n);
    this.#loaded.delete(name);
  }

  async loadAll(names: string[]): Promise<void> {
    for (const n of names) {
      try {
        await this.load(n);
      } catch (e) {
        // "core" failing is fatal; anything else just gets logged so one broken cog can't stop the bot.
        if (PROTECTED.has(n)) throw e;
        this.log.error(`failed to load cog "${n}"`, e);
      }
    }
  }

  async unloadAll(): Promise<void> {
    for (const n of [...this.#loaded.keys()].reverse()) {
      const l = this.#loaded.get(n)!;
      try {
        await l.cog.onUnload?.();
      } catch (e) {
        this.log.warn(`cog ${n} onUnload threw`, e);
      }
    }
    this.#loaded.clear();
    this.#commands.clear();
  }
}
