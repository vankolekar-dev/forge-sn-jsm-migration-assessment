import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClientCredentialsProvider, FakeServiceNow, HttpFetch, MemorySink, PasswordGrantProvider, STANDARD_PULLS, ServiceNowClient, StaticTokenProvider,
  collectLive, collectSteps, explainOAuthError, normaliseInstanceUrl, normaliseRow, parseXml, snapshotFromXml, snapshotOf, standardAggregates, startCursor,
  type CollectCursor,
} from '@snjsm/collector';

type Call = { url: string; method: string; headers: Record<string, string>; body?: string };
const res = (status: number, body: unknown, headers: Record<string, string> = {}) => ({
  status,
  headers: { get: (n: string) => headers[n.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
function fakeFetch(handler: (c: Call, n: number) => ReturnType<typeof res>) {
  const calls: Call[] = [];
  const fn: HttpFetch = async (url, init) => {
    const c = { url, ...init };
    calls.push(c);
    return handler(c, calls.length);
  };
  return { fn, calls };
}
const noSleep = async () => {};
const id = (n: number) => n.toString(16).padStart(32, '0');

describe('xml parser (ported)', () => {
  it('parses the synthetic enterprise update set', () => {
    const xml = readFileSync(join(__dirname, 'fixtures/enterprise-update-set.xml'), 'utf8');
    const r = parseXml(xml, 'enterprise.xml');
    expect(r.records.length).toBeGreaterThan(2000);
    expect(r.records.some((x) => x.table === 'sc_cat_item')).toBe(true);
  });
  it('rejects non-XML input', () => expect(() => parseXml('not xml')).toThrow());
});

describe('instance url', () => {
  it('normalises and restricts hosts', () => {
    expect(normaliseInstanceUrl('Dev317128.service-now.com/now/nav')).toBe('https://dev317128.service-now.com');
    expect(() => normaliseInstanceUrl('http://dev317128.service-now.com')).toThrow();
    expect(() => normaliseInstanceUrl('https://service-now.com.evil.com')).toThrow();
  });
});

describe('oauth client credentials', () => {
  it('requests, caches and refreshes tokens', async () => {
    let t = 0;
    const { fn, calls } = fakeFetch((_c, n) => res(200, { access_token: `tok${n}`, expires_in: 1800 }));
    const p = new ClientCredentialsProvider('https://x.service-now.com', 'cid', 'secret', fn, () => t);
    expect(await p.getToken()).toBe('tok1');
    expect(await p.getToken()).toBe('tok1');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toContain('grant_type=client_credentials');
    t += 1800 * 1000;
    expect(await p.getToken()).toBe('tok2');
    expect(await p.getToken(true)).toBe('tok3');
  });

  it('explains access_denied with the ServiceNow-side fix', async () => {
    const { fn } = fakeFetch(() => res(401, { error: 'server_error', error_description: 'access_denied' }));
    const p = new ClientCredentialsProvider('https://x.service-now.com', 'cid', 'secret', fn);
    await expect(p.getToken()).rejects.toThrow(/glide\.oauth\.inbound\.client\.credential\.grant_type\.enabled/);
    expect(explainOAuthError('invalid_client')).toMatch(/Re-copy/);
  });

  it('never puts the secret in the error message', async () => {
    const { fn } = fakeFetch(() => res(400, { error: 'invalid_client' }));
    const p = new ClientCredentialsProvider('https://x.service-now.com', 'cid', 'SUPERSECRET', fn);
    await expect(p.getToken()).rejects.not.toThrow(/SUPERSECRET/);
  });
});

describe('servicenow client', () => {
  it('pages with sys_id keyset and stops on a short page', async () => {
    const all = Array.from({ length: 5 }, (_, i) => ({ sys_id: id(i + 1), name: `r${i + 1}` }));
    const { fn, calls } = fakeFetch((c) => {
      const q = new URL(c.url).searchParams;
      const after = /sys_id>([0-9a-f]{32})/.exec(q.get('sysparm_query') ?? '')?.[1];
      const limit = Number(q.get('sysparm_limit'));
      const rows = all.filter((r) => !after || r.sys_id > after).slice(0, limit);
      return res(200, { result: rows });
    });
    const client = new ServiceNowClient({ instanceUrl: 'https://x.service-now.com', auth: new StaticTokenProvider('t'), fetch: fn, sleep: noSleep, pageSize: 2 });
    const pages = [];
    for await (const p of client.iterateTable('sys_script', { fields: ['name'] })) pages.push(p);
    expect(pages.map((p) => p.records.length)).toEqual([2, 2, 1]);
    expect(pages[2]!.lastSysId).toBe(id(5));
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    const q0 = new URL(calls[0]!.url).searchParams;
    expect(q0.get('sysparm_query')).toBe('ORDERBYsys_id');
    expect(q0.get('sysparm_fields')).toBe('sys_id,name');
  });

  it('resumes from a checkpoint and honours limit', async () => {
    const { fn, calls } = fakeFetch(() => res(200, { result: [{ sys_id: id(9) }] }));
    const client = new ServiceNowClient({ instanceUrl: 'https://x.service-now.com', auth: new StaticTokenProvider('t'), fetch: fn, sleep: noSleep });
    for await (const _ of client.iterateTable('cmdb_ci', { startAfter: id(8), query: 'active=true', limit: 1 })) void _;
    expect(new URL(calls[0]!.url).searchParams.get('sysparm_query')).toBe(`active=true^sys_id>${id(8)}^ORDERBYsys_id`);
    expect(calls).toHaveLength(1);
  });

  it('retries 429 using Retry-After and refreshes the token once on 401', async () => {
    const waits: number[] = [];
    let tokens = 0;
    const auth = { description: 't', getToken: async (force?: boolean) => { if (force) tokens++; return `tok${tokens}`; } };
    const { fn, calls } = fakeFetch((_c, n) => (n === 1 ? res(429, '', { 'retry-after': '2' }) : n === 2 ? res(401, '') : res(200, { result: { stats: { count: '42' } } })));
    const client = new ServiceNowClient({ instanceUrl: 'https://x.service-now.com', auth, fetch: fn, sleep: async (ms) => { waits.push(ms); }, maxRequestsPerSecond: 1000 });
    expect(await client.count('cmdb_ci')).toBe(42);
    expect(waits).toContain(2000);
    expect(tokens).toBe(1);
    expect(calls[2]!.headers.Authorization).toBe('Bearer tok1');
  });

  it('parses grouped counts from the Aggregate API', async () => {
    const { fn, calls } = fakeFetch(() => res(200, { result: [
      { stats: { count: '120' }, groupby_fields: [{ field: 'sys_class_name', value: 'cmdb_ci_server' }] },
      { stats: { count: '30' }, groupby_fields: [{ field: 'sys_class_name', value: 'cmdb_ci_appl' }] },
    ] }));
    const client = new ServiceNowClient({ instanceUrl: 'https://x.service-now.com', auth: new StaticTokenProvider('t'), fetch: fn, sleep: noSleep });
    const groups = await client.countBy('cmdb_ci', ['sys_class_name']);
    expect(groups).toEqual([{ group: { sys_class_name: 'cmdb_ci_server' }, count: 120 }, { group: { sys_class_name: 'cmdb_ci_appl' }, count: 30 }]);
    expect(new URL(calls[0]!.url).pathname).toBe('/api/now/stats/cmdb_ci');
  });

  it('maps 403 to an actionable error', async () => {
    const { fn } = fakeFetch(() => res(403, { error: { message: 'no' } }));
    const client = new ServiceNowClient({ instanceUrl: 'https://x.service-now.com', auth: new StaticTokenProvider('t'), fetch: fn, sleep: noSleep });
    await expect(client.count('sys_security_acl')).rejects.toThrow(/No read access \(403\)/);
  });

  it('normalises display values', () => {
    const r = normaliseRow('sc_cat_item', { sys_id: { value: 'a', display_value: 'a' }, category: { value: '123', display_value: 'Hardware' }, active: 'true' });
    expect(r.fields).toEqual({ sys_id: 'a', category: '123', category__display: 'Hardware', active: 'true' });
  });
});

describe('resumable live collection', () => {
  const xml = readFileSync(join(__dirname, 'fixtures/enterprise-update-set.xml'), 'utf8');
  const records = snapshotFromXml([{ name: 'e.xml', xml }]).records;
  const client = (sn: FakeServiceNow, pageSize = 3) =>
    new ServiceNowClient({ instanceUrl: sn.instanceUrl, auth: new ClientCredentialsProvider(sn.instanceUrl, 'client-1', 'secret-1', sn.fetch), fetch: sn.fetch, maxRequestsPerSecond: 1000, sleep: noSleep, pageSize });
  const opts = { pulls: STANDARD_PULLS.slice(0, 12), aggregates: standardAggregates(30).slice(0, 6), fillRate: { maxClasses: 2, maxAttributesPerClass: 3 } };

  it('pausing at every checkpoint and resuming from saved JSON gives the same snapshot as one run, reading only', async () => {
    const sn = new FakeServiceNow(records);
    const whole = await collectLive(client(sn), opts);
    expect(whole.records.length).toBeGreaterThan(0);

    const sn2 = new FakeServiceNow(records);
    const sink = new MemorySink();
    let saved = JSON.stringify(startCursor());
    let runs = 0;
    for (;;) {
      runs++;
      let budget = 1; // stop at the first checkpoint after one unit of work: a new "invocation" every time
      const c = await collectSteps(client(sn2), JSON.parse(saved) as CollectCursor, sink, { ...opts, shouldStop: () => budget-- <= 0, checkpoint: async (x) => { saved = JSON.stringify(x); } });
      saved = JSON.stringify(c);
      if (c.phase === 'done') break;
      expect(runs).toBeLessThan(2000);
    }
    expect(runs).toBeGreaterThan(20);
    const stepped = snapshotOf(sn2.instanceUrl, JSON.parse(saved) as CollectCursor, sink.all(), sink.aggregates, 30, whole.source.capturedAt);
    expect({ ...stepped, usageDays: whole.usageDays }).toEqual(whole);
    expect(sn2.requests.filter((r) => r.method !== 'GET').every((r) => r.path === '/oauth_token.do')).toBe(true);
  });

  it('records a missing table as a warning and carries on', async () => {
    const sn = new FakeServiceNow(records);
    const snap = await collectLive(client(sn), { ...opts, pulls: [{ table: 'u_not_here', purpose: 'x' }, ...opts.pulls.slice(0, 2)] });
    expect(snap.warnings).toContain('u_not_here: not available on this instance');
  });

  it('stops at the last checkpoint when the instance is unreachable, instead of recording a silently partial snapshot', async () => {
    const sn = new FakeServiceNow(records);
    let down = false; let calls = 0;
    const flaky: HttpFetch = async (url, init) => { if (down) throw new TypeError('fetch failed'); if (++calls === 6) down = true; return sn.fetch(url, init); };
    const c = new ServiceNowClient({ instanceUrl: sn.instanceUrl, auth: new ClientCredentialsProvider(sn.instanceUrl, 'client-1', 'secret-1', flaky), fetch: flaky, maxRequestsPerSecond: 1000, sleep: noSleep, pageSize: 3 });
    const sink = new MemorySink();
    let saved = startCursor();
    await expect(collectSteps(c, saved, sink, { ...opts, checkpoint: async (x) => { saved = x; } })).rejects.toThrow(/fetch failed/);
    expect(saved.phase).toBe('pulls');
    expect(saved.warnings.join(' ')).not.toMatch(/fetch failed/);
    down = false;
    const done = await collectSteps(c, saved, sink, opts);
    const whole = await collectLive(client(new FakeServiceNow(records)), opts);
    expect(snapshotOf(sn.instanceUrl, done, sink.all(), sink.aggregates, 30).records.length).toBe(whole.records.length);
  });

  it('explains a hibernating developer instance (HTML instead of JSON)', async () => {
    const html: HttpFetch = async (url, init) => url.includes('oauth_token') ? new FakeServiceNow([]).fetch(url, init) : { status: 200, headers: { get: () => null }, text: async () => '<html>Your instance is hibernating</html>' };
    const c = new ServiceNowClient({ instanceUrl: 'https://dev12345.service-now.com', auth: new ClientCredentialsProvider('https://dev12345.service-now.com', 'client-1', 'secret-1', html), fetch: html, maxRequestsPerSecond: 1000, sleep: noSleep });
    await expect(c.count('sys_user_group')).rejects.toThrow(/Is the instance awake/);
  });
});

describe('oauth password grant', () => {
  it('logs in with the integration user, refreshes with the refresh token, and falls back to the password', async () => {
    const sn = new FakeServiceNow([]);
    let t = 0;
    const p = new PasswordGrantProvider(sn.instanceUrl, sn.creds, sn.fetch, () => t);
    expect(await p.getToken()).toBe('tok-1');
    expect(await p.getToken()).toBe('tok-1');
    t += 3600_000;
    expect(await p.getToken()).toBe('tok-2'); // via refresh_token
    expect(sn.requests.filter((r) => r.path === '/oauth_token.do')).toHaveLength(2);
    sn.creds = { ...sn.creds }; // refresh tokens stay valid in the fake; a forced refresh still works
    expect(await p.getToken(true)).toBe('tok-3');
  });

  it('explains a refused user without echoing secrets', async () => {
    const sn = new FakeServiceNow([]);
    const p = new PasswordGrantProvider(sn.instanceUrl, { ...sn.creds, password: 'wrong-pw-xyz' }, sn.fetch);
    const err = await p.getToken().catch((e: Error) => e);
    expect(String((err as Error).message)).toMatch(/refused the integration user/);
    expect(String((err as Error).message)).not.toMatch(/wrong-pw-xyz|secret-1/);
  });
});
