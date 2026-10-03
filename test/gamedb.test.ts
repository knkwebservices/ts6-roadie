import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { formatEntry, GameDb, LookupError, parseEntry, parseSearch, rankHits } from '../src/util/gamedb.js';
import { CH, makeBot, makeConfig, until } from './helpers.js';

// Trimmed copies of the real page structure (October 2026), not whole pages.
const OH_SEARCH = `<html><body><nav><a href="/weapons">Weapons</a><a href="/items/category/ammo"><span>item</span><span>Ammo</span></a></nav>
<a class="group card-left" href="/memetics/shotgun-trap"><div><span class="text-rare">memetic</span><h3>Shotgun Trap</h3></div><p>Gathering - Tier 1</p></a>
<a class="group card-left" href="/items/shotgun-brake"><div><span>item</span><h3>Shotgun Brake</h3></div><p>Weapon Accessory</p></a>
<a class="group card-left" href="/attachments/shotgun-brake"><div><span>attachment</span><h3>Shotgun Brake</h3></div><p>Muzzle - rare - Range +2, Accuracy +10</p></a>
<a class="group card-left" href="/items/shotgun-doombringer"><div><span>item</span><h3>Shotgun - Doombringer</h3></div><p>Weapon Blueprints</p></a>
<a class="group card-left" href="/items/shotgun-doombringer"><div><span>item</span><h3>Shotgun - Doombringer</h3></div><p>duplicate</p></a>
</body></html>`;

const OH_ITEM = `<html><head><meta name="description" content="Once Human Shotgun - Doombringer — Legendary Weapon Blueprints."/></head><body>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"WebSite","name":"Once Human DB"}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemPage","name":"Shotgun - Doombringer","description":"Once Human Shotgun - Doombringer — Legendary Weapon Blueprints.","mainEntity":{"@type":"Thing","name":"Shotgun - Doombringer","additionalProperty":[{"@type":"PropertyValue","name":"Category","value":"Weapon Blueprints"},{"@type":"PropertyValue","name":"Rarity","value":"legendary"},{"@type":"PropertyValue","name":"Stack Size","value":"1"}]}}</script>
<script type="application/ld+json">{"@type":"BreadcrumbList","itemListElement":[]}</script>
<h1>Shotgun - Doombringer</h1></body></html>`;

const IC_SEARCH = `<html><body>
<a class="card group block p-4" href="/items/cat-bowl-food"><div><span class="badge">item</span><span>Cat Food Bowl</span></div><p>A simple bowl to fill with food for your cat.</p></a>
<a class="card group block p-4" href="/items/compound-bow"><div><span class="badge">item</span><span>Compound Bow</span></div><p>Lightweight, long-range lethality.</p></a>
<a class="card group block p-4" href="/items/meta-bow-larkwell"><div><span class="badge">item</span><span>Larkwell Martinez Compound Bow</span></div><p>A powerful, military-grade Compound Bow.</p></a>
<a class="card group block p-4" href="/talents/bow-mastery"><div><span class="badge">talent</span><span>Compound Bow</span></div><p>A talent with the same name.</p></a>
</body></html>`;

const IC_ITEM = `<html><head><meta name="description" content="Icarus Compound Bow &amp; more"/></head><body>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"ItemPage","name":"Compound Bow","description":"Compound Bow is a Weapon in Icarus. Lightweight, long-range lethality. Tier 4, 20000 durability, 2x damage."}</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":"How do I craft Compound Bow?","acceptedAnswer":{"@type":"Answer","text":"Compound Bow can be crafted at the Foundry using 16x Aluminium, 8x Carbon Fiber, 18x Composites, 4x Steel Screw."}}]}</script>
</body></html>`;

const OH_SECTIONS = ['weapons', 'items', 'attachments', 'memetics', 'recipes'];
const IC_SECTIONS = ['items', 'talents', 'recipes', 'creatures'];

test('search results are read from the result links, skipping navigation, categories and duplicates', () => {
  const hits = parseSearch(OH_SEARCH, OH_SECTIONS);
  assert.deepEqual(
    hits.map((h) => `${h.kind}|${h.name}|${h.path}`),
    ['memetic|Shotgun Trap|/memetics/shotgun-trap', 'item|Shotgun Brake|/items/shotgun-brake', 'attachment|Shotgun Brake|/attachments/shotgun-brake', 'item|Shotgun - Doombringer|/items/shotgun-doombringer'],
  );
  assert.equal(hits[2]!.detail, 'Muzzle - rare - Range +2, Accuracy +10');
  assert.equal(parseSearch(IC_SEARCH, IC_SECTIONS).length, 4);
});

test('ranking puts an exact name first, then preferred kinds', () => {
  const ranked = rankHits(parseSearch(IC_SEARCH, IC_SECTIONS), 'compound bow', ['item', 'talent']);
  assert.deepEqual(ranked.slice(0, 3).map((h) => `${h.kind} ${h.name}`), ['item Compound Bow', 'talent Compound Bow', 'item Larkwell Martinez Compound Bow']);
  const oh = rankHits(parseSearch(OH_SEARCH, OH_SECTIONS), 'shotgun', ['weapon', 'item', 'attachment', 'memetic']);
  assert.equal(oh[0]!.kind, 'item', 'an item beats the memetic the site lists first');
});

test('entry pages are read from their structured data', () => {
  const oh = parseEntry(OH_ITEM, 'https://www.oncehumandb.com/items/shotgun-doombringer');
  assert.equal(oh.name, 'Shotgun - Doombringer');
  assert.deepEqual(oh.props, [
    { name: 'Category', value: 'Weapon Blueprints' },
    { name: 'Rarity', value: 'legendary' },
    { name: 'Stack Size', value: '1' },
  ]);
  const ic = parseEntry(IC_ITEM, 'https://www.icarusdatabase.com/items/compound-bow');
  assert.match(ic.description!, /Tier 4, 20000 durability/);
  assert.match(ic.faq[0]!.a, /crafted at the Foundry using 16x Aluminium/);
  // no JSON-LD: the h1 and meta description still work
  const bare = parseEntry('<meta name="description" content="Tom &amp; Jerry"/><h1>Plain <b>Page</b></h1>', 'u');
  assert.equal(bare.name, 'Plain Page');
  assert.equal(bare.description, 'Tom & Jerry');
  assert.throws(() => parseEntry('<html></html>', 'u'), LookupError);
});

test('a reply keeps the link and credit even when the text is long', () => {
  const e = parseEntry(IC_ITEM, 'https://www.icarusdatabase.com/items/compound-bow');
  const long = formatEntry({ ...e, description: 'x'.repeat(2000) }, { kind: 'item', credit: 'Data from Icarus Database', others: ['Longbow'], command: '!icarus' });
  assert.ok(long.length <= 900);
  assert.match(long, /\.\.\.\nhttps:\/\/www\.icarusdatabase\.com\/items\/compound-bow\nAlso: Longbow \(!icarus <name>\)\nData from Icarus Database$/);
});

function fakeSite(pages: Record<string, string | number>) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    asked.push(url);
    assert.match(new Headers(init.headers).get('user-agent') ?? '', /TS6-Roadie/);
    assert.ok(!url.includes('/api/'), 'never touches /api/');
    const path = url.replace(/^https:\/\/www\.example\.com/, '');
    const page = pages[path];
    if (page === undefined) return new Response('nope', { status: 404 });
    if (typeof page === 'number') return new Response('err', { status: page });
    return new Response(page, { status: 200 });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

test('GameDb searches, caches, and explains failures', async () => {
  const f = fakeSite({ '/search?q=compound%20bow': IC_SEARCH, '/items/compound-bow': IC_ITEM, '/search?q=down': 503 });
  const db = new GameDb({ base: 'https://www.example.com', sections: IC_SECTIONS, fetchImpl: f.fetchImpl });
  assert.equal((await db.search('Compound Bow')).length, 4);
  await db.search('compound bow');
  assert.equal(f.asked.length, 1, 'the second search came from the cache');
  assert.equal((await db.entry('/items/compound-bow')).name, 'Compound Bow');
  await assert.rejects(db.search('down'), /example\.com answered HTTP 503/);
});

// ---- the cogs, in a real bot with a fake site ------------------------------------------

async function rig(cog: 'oncehuman' | 'icarus', pages: Record<string, string | number>) {
  const f = fakeSite(pages);
  const sections = cog === 'oncehuman' ? OH_SECTIONS : IC_SECTIONS;
  (globalThis as Record<string, unknown>).__gameDb = new GameDb({ base: 'https://www.example.com', sections, fetchImpl: f.fetchImpl });
  const entry = resolve(import.meta.dirname, `../src/cogs/${cog}/index.ts`);
  const create = cog === 'oncehuman' ? 'createOnceHumanCog' : 'createIcarusCog';
  const h = await makeBot({
    config: makeConfig({ cogs: ['core', 'gdbtest'] }),
    customCogs: {
      gdbtest: `
        import { ${create} } from ${JSON.stringify('file://' + entry)};
        export const manifest = { name: 'gdbtest', version: '1', description: 'game db with a fake site' };
        export default (bot) => ${create}(bot, globalThis.__gameDb);`,
    },
  });
  const user = h.adapter.addUser(10, 'Ann', CH.home, 'uid-Ann');
  const ask = async (text: string): Promise<string> => {
    const n = h.adapter.sent.length;
    h.adapter.say(user, text);
    await until(() => h.adapter.sent.length > n, 8000, `an answer to ${text}`);
    return h.adapter.sent.at(-1)!.text;
  };
  return { ...h, ask, asked: f.asked };
}

test('!icarus finds the best match, shows its recipe, link, other matches and credit', async () => {
  const r = await rig('icarus', { '/search?q=compound%20bow': IC_SEARCH, '/items/compound-bow': IC_ITEM, '/search?q=dragon': '<html><body>0 results</body></html>' });
  try {
    const out = await r.ask('!icarus compound bow');
    assert.match(out, /^Compound Bow \(item\)\n/);
    assert.match(out, /crafted at the Foundry/);
    assert.match(out, /https:\/\/www\.example\.com\/items\/compound-bow/);
    assert.match(out, /Also: Larkwell Martinez Compound Bow, Cat Food Bowl \(!icarus <name>\)/);
    assert.match(out, /Data from Icarus Database \(icarusdatabase\.com\)$/);
    assert.match(await r.ask('!ic x'), /Usage: !icarus <name>/);
    assert.match(await r.ask('!icarus dragon'), /Nothing in the Icarus database matches "dragon"/);
  } finally {
    r.cleanup();
  }
});

test('!oh works the same, and falls back to the search result if the entry page fails', async () => {
  const r = await rig('oncehuman', { '/search?q=doombringer': OH_SEARCH, '/items/shotgun-doombringer': OH_ITEM, '/search?q=brake': OH_SEARCH, '/items/shotgun-brake': 500 });
  try {
    const out = await r.ask('!oh Doombringer');
    assert.match(out, /^Shotgun - Doombringer \(item\)\n/);
    assert.match(out, /Category: Weapon Blueprints \| Rarity: legendary \| Stack Size: 1/);
    assert.match(out, /Data from Once Human DB/);
    const fallback = await r.ask('!oncehuman brake');
    assert.match(fallback, /^Shotgun Brake \(item\)\nWeapon Accessory\nhttps:\/\/www\.example\.com\/items\/shotgun-brake/);
  } finally {
    r.cleanup();
  }
});

test('when the site is down, the bot says so', async () => {
  const r = await rig('icarus', { '/search?q=bow': 503 });
  try {
    assert.match(await r.ask('!icarus bow'), /couldn't search the Icarus database right now \(example\.com answered HTTP 503\)/);
  } finally {
    r.cleanup();
  }
});
