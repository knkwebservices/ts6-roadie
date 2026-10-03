/**
 * Live lookups on game database sites (oncehumandb.com, icarusdatabase.com). Neither has a public API,
 * and both allow bots in robots.txt (Once Human DB asks bots to stay out of /api/, which this never
 * touches): the bot uses the same search page and entry pages a person would, reads the structured data
 * (JSON-LD) the pages carry for search engines, caches what it gets, and never asks more than once a second.
 */

import type { BotApi, CommandDef } from '../core/types.js';
import { errMessage } from './text.js';

const FETCH_TIMEOUT_MS = 8_000;
const MIN_GAP_MS = 1_000;
const CACHE_MS = 60 * 60_000;
const CACHE_MAX = 300;
const USER_AGENT = 'TS6-Roadie (TeamSpeak bot; https://github.com/knkwebservices/ts6-roadie)';

export class LookupError extends Error {}

export interface SearchHit {
  /** "item", "weapon", "recipe", ... as the site labels it. */
  kind: string;
  name: string;
  /** The short line under the name in the results. */
  detail: string;
  /** Path on the site, like /items/compound-bow. */
  path: string;
}

export interface Entry {
  name: string;
  description?: string;
  /** Name/value pairs the page gives (category, rarity, tier...). */
  props: { name: string; value: string }[];
  /** Question/answer pairs (like "How do I craft X?"). */
  faq: { q: string; a: string }[];
  url: string;
}

const decode = (s: string): string =>
  s
    .replace(/<!--.*?-->/gs, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/** The pieces of text inside an element, in order (each tag boundary splits them). */
function textParts(html: string): string[] {
  return html
    .replace(/<!--.*?-->/gs, '')
    .split(/<[^>]+>/)
    .map(decode)
    .filter(Boolean);
}

/**
 * Search results are links like <a href="/items/compound-bow"><span>item</span><span>Compound Bow</span><p>detail</p></a>.
 * `sections` lists the first path segments that count as results, so navigation links are ignored.
 */
export function parseSearch(html: string, sections: string[]): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*\bhref="(\/([a-z0-9-]+)\/[^"#?]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const [, path, section, inner] = m as unknown as [string, string, string, string];
    if (!sections.includes(section.toLowerCase())) continue;
    if (/\/category\//.test(path)) continue;
    const parts = textParts(inner);
    if (parts.length < 2) continue;
    const key = path.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: parts[0]!.toLowerCase(), name: parts[1]!, detail: parts.slice(2).join(' '), path });
  }
  return out;
}

const SKIP_TYPES = new Set(['WebSite', 'Organization', 'VideoGame', 'BreadcrumbList', 'FAQPage']);

/** Read an entry page: its JSON-LD (name, description, properties, FAQ), falling back to the meta tags. */
export function parseEntry(html: string, url: string): Entry {
  const blocks: Record<string, unknown>[] = [];
  for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const v = JSON.parse(m[1]!) as unknown;
      for (const b of Array.isArray(v) ? v : [v]) if (b && typeof b === 'object') blocks.push(b as Record<string, unknown>);
    } catch {
      // a broken block is skipped; the others may still be fine
    }
  }
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? decode(v) : undefined);

  const main = blocks.find((b) => typeof b['@type'] === 'string' && !SKIP_TYPES.has(b['@type'] as string) && str(b.name));
  const props: Entry['props'] = [];
  const me = main?.mainEntity as Record<string, unknown> | undefined;
  const add = me?.additionalProperty ?? main?.additionalProperty;
  if (Array.isArray(add)) {
    for (const p of add as Record<string, unknown>[]) {
      const n = str(p?.name);
      const v = p?.value;
      const val = typeof v === 'number' ? String(v) : str(v);
      if (n && val) props.push({ name: n, value: val });
    }
  }
  const faq: Entry['faq'] = [];
  for (const b of blocks.filter((x) => x['@type'] === 'FAQPage')) {
    const list = b.mainEntity;
    if (!Array.isArray(list)) continue;
    for (const q of list as Record<string, unknown>[]) {
      const question = str(q?.name);
      const answer = str((q?.acceptedAnswer as Record<string, unknown> | undefined)?.text);
      if (question && answer) faq.push({ q: question, a: answer });
    }
  }

  const meta = (name: string): string | undefined => {
    const m =
      new RegExp(`<meta[^>]+(?:name|property)="${name}"[^>]+content="([^"]*)"`, 'i').exec(html) ??
      new RegExp(`<meta[^>]+content="([^"]*)"[^>]+(?:name|property)="${name}"`, 'i').exec(html);
    return m ? str(m[1]) : undefined;
  };
  const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html);
  const name = str(main?.name) ?? (h1 ? str(h1[1]) : undefined) ?? meta('og:title');
  if (!name) throw new LookupError("That page didn't look like a database entry.");
  return { name, description: str(main?.description) ?? meta('description'), props, faq, url };
}

export interface SiteOptions {
  /** https://www.example.com, no trailing slash. */
  base: string;
  /** First path segments that are entries, for parsing search results. */
  sections: string[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** One site: search and entry fetches, with a cache and a one-request-per-second limit. */
export class GameDb {
  readonly base: string;
  readonly #sections: string[];
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #cache = new Map<string, { at: number; value: unknown }>();
  #chain: Promise<unknown> = Promise.resolve();
  #last = 0;

  constructor(opts: SiteOptions) {
    this.base = opts.base.replace(/\/+$/, '');
    this.#sections = opts.sections;
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#now = opts.now ?? Date.now;
  }

  async #get(path: string): Promise<string> {
    // one request at a time, at least MIN_GAP_MS apart
    const run = async (): Promise<string> => {
      const wait = this.#last + MIN_GAP_MS - this.#now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.#last = this.#now();
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      const host = new URL(this.base).hostname.replace(/^www\./, '');
      try {
        const res = await this.#fetch(this.base + path, { signal: ac.signal, headers: { 'User-Agent': USER_AGENT } });
        if (res.status === 404) throw new LookupError('not found');
        if (!res.ok) throw new LookupError(`${host} answered HTTP ${res.status}`);
        return await res.text();
      } catch (e) {
        if (e instanceof LookupError) throw e;
        if (e instanceof Error && e.name === 'AbortError') throw new LookupError(`${host} did not answer in time`);
        throw new LookupError(`could not reach ${host}`);
      } finally {
        clearTimeout(t);
      }
    };
    const p = this.#chain.then(run, run);
    this.#chain = p.catch(() => undefined);
    return p;
  }

  async #cached<T>(key: string, make: () => Promise<T>): Promise<T> {
    const hit = this.#cache.get(key);
    if (hit && this.#now() - hit.at < CACHE_MS) return hit.value as T;
    const value = await make();
    this.#cache.set(key, { at: this.#now(), value });
    if (this.#cache.size > CACHE_MAX) this.#cache.delete(this.#cache.keys().next().value!);
    return value;
  }

  search(query: string): Promise<SearchHit[]> {
    const q = query.trim().toLowerCase();
    return this.#cached(`s:${q}`, async () => parseSearch(await this.#get(`/search?q=${encodeURIComponent(q)}`), this.#sections));
  }

  entry(path: string): Promise<Entry> {
    return this.#cached(`e:${path}`, async () => parseEntry(await this.#get(path), this.base + path));
  }
}

/**
 * The best hit for what someone typed: an exact name first, then names starting with it, then the rest;
 * within each, the kinds listed first in `prefer` win, then the site's own order.
 */
export function rankHits(hits: SearchHit[], query: string, prefer: string[]): SearchHit[] {
  const q = query.trim().toLowerCase();
  const level = (h: SearchHit): number => {
    const n = h.name.toLowerCase();
    if (n === q) return 0;
    if (n.startsWith(q)) return 1;
    if (n.includes(q)) return 2;
    return 3;
  };
  const kindRank = (h: SearchHit): number => {
    const i = prefer.indexOf(h.kind);
    return i < 0 ? prefer.length : i;
  };
  return hits
    .map((h, i) => ({ h, i }))
    .sort((a, b) => level(a.h) - level(b.h) || kindRank(a.h) - kindRank(b.h) || a.i - b.i)
    .map((x) => x.h);
}

/** A chat reply for one entry, kept short enough for TeamSpeak chat (the link and credit are never cut). */
export function formatEntry(e: Entry, opts: { kind?: string; credit: string; others?: string[]; command: string }): string {
  const MAX = 900;
  const head: string[] = [`${e.name}${opts.kind ? ` (${opts.kind})` : ''}`];
  if (e.description) head.push(e.description);
  if (e.props.length) head.push(e.props.slice(0, 8).map((p) => `${p.name}: ${p.value}`).join(' | '));
  for (const f of e.faq.slice(0, 2)) head.push(f.a);
  const tail: string[] = [e.url];
  if (opts.others?.length) tail.push(`Also: ${opts.others.join(', ')} (${opts.command} <name>)`);
  tail.push(opts.credit);
  let body = head.join('\n');
  const room = MAX - tail.join('\n').length - 1;
  if (body.length > room) body = `${body.slice(0, Math.max(0, room - 3)).trimEnd()}...`;
  return `${body}\n${tail.join('\n')}`;
}

export interface GameDbCogOptions {
  name: string;
  game: string;
  command: string;
  aliases: string[];
  site: GameDb;
  /** Result kinds to prefer, best first. */
  prefer: string[];
  /** "Data from oncehumandb.com" */
  credit: string;
  example: string;
}

/** The !command <name> lookup shared by the Once Human and Icarus cogs. */
export function gameDbCommand(bot: BotApi, o: GameDbCogOptions): CommandDef {
  const p = bot.config.prefix;
  const log = bot.log.child(o.name);
  return {
    name: o.command,
    aliases: o.aliases,
    description: `Look something up in the ${o.game} database: ${p}${o.command} <name>, like ${p}${o.command} ${o.example}`,
    usage: `${p}${o.command} <name>`,
    run: async (ctx) => {
      const query = ctx.rest.trim().replace(/\s+/g, ' ').slice(0, 80);
      if (query.length < 2) return ctx.reply(`Usage: ${p}${o.command} <name>, like ${p}${o.command} ${o.example}`);
      let hits: SearchHit[];
      try {
        hits = rankHits(await o.site.search(query), query, o.prefer);
      } catch (e) {
        log.warn(`search failed: ${errMessage(e)}`);
        return ctx.reply(`I couldn't search the ${o.game} database right now (${errMessage(e)}). Try again in a bit.`);
      }
      const best = hits[0];
      if (!best) return ctx.reply(`Nothing in the ${o.game} database matches "${query}". Try a shorter or different name.`);
      const others = [...new Set(hits.slice(1).map((h) => h.name).filter((n) => n.toLowerCase() !== best.name.toLowerCase()))].slice(0, 4);
      try {
        const entry = await o.site.entry(best.path);
        return ctx.reply(formatEntry(entry, { kind: best.kind, credit: o.credit, others, command: `${p}${o.command}` }));
      } catch (e) {
        log.warn(`entry ${best.path} failed: ${errMessage(e)}`);
        // the search itself worked, so the name, its short line and the link are still worth giving
        return ctx.reply([`${best.name} (${best.kind})`, best.detail, o.site.base + best.path, o.credit].filter(Boolean).join('\n'));
      }
    },
  };
}
