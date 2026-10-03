import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { TsUser } from '../src/adapter/types.js';
import { buildConfig } from '../src/config.js';
import { problemsFor, type IpGuardDeps } from '../src/cogs/ipguard/index.js';
import { isPrivateIp, lookupIp, parseVerdict, type IpVerdict } from '../src/cogs/ipguard/lookup.js';
import { clockValues, renderLiveName } from '../src/cogs/servertools/livenames.js';
import { CH, makeBot, makeConfig, until, type Harness } from './helpers.js';

const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function say(h: Harness, user: TsUser, text: string): Promise<string> {
  const n = h.adapter.sent.length;
  const mine = () => h.adapter.sent.slice(n).find((s) => s.kind === 'private' && s.to === user.id);
  h.adapter.say(user, text);
  await until(() => !!mine(), 10000, `an answer to ${text}`);
  return mine()!.text;
}
const to = (h: Harness, user: TsUser) => h.adapter.sent.filter((s) => s.kind === 'private' && s.to === user.id).map((s) => s.text);

// ---- clock -------------------------------------------------------------------------------------

test('{time} and {date} fill in live channel names', () => {
  const c = clockValues(new Date(2026, 9, 3, 21, 5));
  assert.equal(c.time, '9:05 PM');
  assert.equal(c.date, 'Sat, Oct 3');
  assert.equal(renderLiveName('[cspacer]{date} | {time}', { online: 1, record: 1, song: '', ...c }), '[cspacer]Sat, Oct 3 | 9:05 PM');
});

// ---- lookups -----------------------------------------------------------------------------------

test('private and local addresses are never looked up', () => {
  for (const ip of ['192.168.0.2', '10.1.2.3', '172.16.0.1', '172.31.9.9', '127.0.0.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::5', '']) assert.ok(isPrivateIp(ip), ip);
  for (const ip of ['50.90.22.229', '8.8.8.8', '172.32.0.1', '2001:4860::8888']) assert.ok(!isPrivateIp(ip), ip);
});

test("proxycheck.io's answers are read in the old and newer shapes", () => {
  assert.deepEqual(parseVerdict({ status: 'ok', '1.2.3.4': { proxy: 'yes', type: 'VPN', provider: 'NordVPN' } }, '1.2.3.4'), { flagged: true, type: 'VPN', provider: 'NordVPN' });
  assert.deepEqual(parseVerdict({ status: 'ok', '1.2.3.4': { proxy: 'no', type: 'Residential', provider: 'Comcast' } }, '1.2.3.4'), { flagged: false, type: 'Residential', provider: 'Comcast' });
  assert.equal(parseVerdict({ status: 'ok', '1.2.3.4': { detections: { proxy: false, vpn: true }, network: { type: 'Hosting' } } }, '1.2.3.4').flagged, true);
  assert.throws(() => parseVerdict({ status: 'denied', message: 'Daily limit reached.' }, '1.2.3.4'), /Daily limit reached/);
  assert.throws(() => parseVerdict({ status: 'ok' }, '1.2.3.4'), /didn't include that address/);
});

test('lookupIp sends the key only when there is one, and explains failures', async () => {
  const urls: string[] = [];
  const ok = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify({ status: 'ok', '8.8.8.8': { proxy: 'no', type: 'Business' } }), { status: 200 });
  }) as typeof fetch;
  assert.equal((await lookupIp('8.8.8.8', '', ok)).flagged, false);
  assert.match(urls[0]!, /^https:\/\/proxycheck\.io\/v2\/8\.8\.8\.8\?vpn=1&asn=1$/);
  await lookupIp('8.8.8.8', 'abc-123', ok);
  assert.match(urls[1]!, /&key=abc-123$/);
  const down = (async () => new Response('<html>', { status: 502 })) as typeof fetch;
  await assert.rejects(lookupIp('8.8.8.8', '', down), /HTTP 502 without JSON/);
});

test('problemsFor checks country, VPN and clones', () => {
  const base = { vpn: true, clones: true, maxPerIp: 2, countryMode: 'off' as const, countries: [] as string[] };
  assert.deepEqual(problemsFor(base, { country: 'US', sameIp: 1, verdict: { flagged: false } }), []);
  assert.deepEqual(problemsFor(base, { country: 'US', sameIp: 1, verdict: { flagged: true, type: 'VPN', provider: 'Mullvad' } }), ['using a VPN or proxy (VPN, Mullvad)']);
  assert.deepEqual(problemsFor(base, { country: 'US', sameIp: 3 }), ['connected 3 times from the same address (the limit is 2)']);
  assert.deepEqual(problemsFor({ ...base, countryMode: 'allow', countries: ['US', 'CA'] }, { country: 'de', sameIp: 1 }), ["connecting from a country that isn't allowed (DE)"]);
  assert.deepEqual(problemsFor({ ...base, countryMode: 'block', countries: ['DE'] }, { country: 'DE', sameIp: 1 }), ['connecting from a blocked country (DE)']);
  assert.deepEqual(problemsFor({ ...base, countryMode: 'allow', countries: ['US'] }, { country: '', sameIp: 1 }), [], 'no country (same network) is never blocked');
});

test('ipguard settings are checked', () => {
  const c = buildConfig({});
  assert.equal(c.ipguard.enabled, false);
  assert.equal(c.ipguard.action, 'warn');
  assert.throws(() => buildConfig({ ipguard: { countries: ['USA'] } }), /ipguard\.countries/);
  assert.throws(() => buildConfig({ ipguard: { maxPerIp: 0 } }), /ipguard\.maxPerIp/);
});

// ---- the cog -------------------------------------------------------------------------------------

const entry = resolve(import.meta.dirname, '../src/cogs/ipguard/index.ts');

async function rig(verdicts: Record<string, IpVerdict>, guard: Record<string, unknown> = {}) {
  const asked: string[] = [];
  const deps: IpGuardDeps = {
    lookup: async (ip) => {
      asked.push(ip);
      const v = verdicts[ip];
      if (!v) throw new Error('unknown');
      return v;
    },
  };
  (globalThis as Record<string, unknown>).__ipDeps = deps;
  const h = await makeBot({
    config: makeConfig({ cogs: ['core', 'iptest'], ipguard: guard }),
    customCogs: {
      iptest: `
        import { createIpGuardCog } from ${JSON.stringify('file://' + entry)};
        export const manifest = { name: 'iptest', version: '1', description: 'ipguard with a fake lookup' };
        export default (bot) => createIpGuardCog(bot, globalThis.__ipDeps);`,
    },
  });
  return { ...h, asked };
}

test('a VPN user joining is reported to admins (warn mode), looked up once, and admins are never checked', async () => {
  const r = await rig({ '5.5.5.5': { flagged: true, type: 'VPN', provider: 'NordVPN' }, '6.6.6.6': { flagged: false, type: 'Residential' } });
  try {
    const admin = r.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    r.adapter.details.set(2, { connection_client_ip: '5.5.5.5', client_country: 'US' });
    await pause(3200);
    assert.match(await say(r, admin, '!ipguard on'), /IP guard is on\. People joining from now on are checked; admins are told/);

    const vic = r.adapter.addUser(10, 'Vic', CH.a);
    r.adapter.details.set(10, { connection_client_ip: '5.5.5.5', client_country: 'NL' });
    r.adapter.events.emit('directory');
    await until(() => to(r, admin).some((t) => /IP guard: Vic is using a VPN or proxy \(VPN, NordVPN\)/.test(t)), 5000, 'the report');
    assert.equal(r.adapter.kicks.length, 0);
    assert.ok(!to(r, admin).some((t) => /5\.5\.5\.5/.test(t)), 'the address itself is not sent around');

    const ann = r.adapter.addUser(11, 'Ann', CH.a);
    r.adapter.details.set(11, { connection_client_ip: '6.6.6.6', client_country: 'US' });
    r.adapter.events.emit('directory');
    await until(() => r.asked.includes('6.6.6.6'), 5000, 'the lookup');
    await pause(100);
    assert.ok(!to(r, admin).some((t) => /Ann/.test(t)), 'nothing to report');

    // the check command, and the cache: Vic's address isn't looked up again
    const n = r.asked.length;
    assert.match(await say(r, admin, '!ipguard check vic'), /Vic: country NL\.\nVPN\/proxy: YES \(VPN, NordVPN\)\.\nWould be caught for: using a VPN/);
    assert.equal(r.asked.length, n);
    assert.match(await say(r, admin, '!ipguard exempt vic'), /never checked now/);
    assert.match(await say(r, admin, '!ipguard check vic'), /\(but they are exempt\)/);
    assert.match(await say(r, admin, '!ipguard'), /VPN\/proxy check: on \(proxycheck\.io, no key: about 100 checks a day; 2 today\)[\s\S]*1 exempt person/);
  } finally {
    r.cleanup();
  }
});

test('kick and move modes, clones, countries, and local addresses', async () => {
  const r = await rig({}, { enabled: true, vpn: false, clones: true, maxPerIp: 1, action: 'kick' });
  try {
    const admin = r.adapter.addUser(2, 'Admin', CH.home, 'uid-Admin');
    const a = r.adapter.addUser(10, 'Al', CH.a);
    r.adapter.details.set(10, { connection_client_ip: '9.9.9.9', client_country: 'US' });
    await pause(3300); // Al was here first: noted, not acted on

    const b = r.adapter.addUser(11, 'Bo', CH.a);
    r.adapter.details.set(11, { connection_client_ip: '9.9.9.9', client_country: 'US' });
    r.adapter.events.emit('directory');
    await until(() => r.adapter.kicks.length === 1, 5000, 'the clone kicked');
    assert.equal(r.adapter.kicks[0]!.id, 11);
    assert.match(r.adapter.kicks[0]!.reason, /connected 2 times from the same address/);

    assert.match(await say(r, admin, '!ipguard countries allow US CA'), /Only people connecting from US, CA/);
    assert.match(await say(r, admin, '!ipguard countries allow USA'), /Usage/);
    assert.match(await say(r, admin, '!ipguard action move'), /move them to "AFK Room"/);
    r.adapter.chans.push({ id: 99n, name: 'AFK Room', parentId: 0n });
    const d = r.adapter.addUser(12, 'Di', CH.a);
    r.adapter.details.set(12, { connection_client_ip: '7.7.7.7', client_country: 'DE' });
    r.adapter.events.emit('directory');
    await until(() => d.channelId === 99n, 5000, 'the move');
    assert.ok(to(r, admin).some((t) => /moved Di to "AFK Room": connecting from a country that isn't allowed \(DE\)/.test(t)));

    // someone at home on the same network: no country, local address, nothing happens
    const e = r.adapter.addUser(13, 'Ed', CH.a);
    r.adapter.details.set(13, { connection_client_ip: '192.168.0.2', client_country: '' });
    r.adapter.events.emit('directory');
    await pause(300);
    assert.equal(e.channelId, CH.a);
    void a;
    void b;
  } finally {
    r.cleanup();
  }
});
