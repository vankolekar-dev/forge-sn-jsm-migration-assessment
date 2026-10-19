import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BasicAuthProvider,
  compileQuery,
  loggingFetch,
  type RequestLogEntry,
  ClientCredentialsProvider, FakeServiceNow, HttpFetch, MemorySink, PasswordGrantProvider, STANDARD_PULLS, ServiceNowClient, StaticTokenProvider,
  collectLive, collectSteps, INDEXED_TABLES, STREAMED_TABLES, explainOAuthError, normaliseInstanceUrl, normaliseRow, parseXml, snapshotFromXml, snapshotOf, standardAggregates, startCursor,
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

describe('fake encoded queries', () => {
  it('evaluates AND, OR, IN, STARTSWITH, emptiness and NULL like ServiceNow', () => {
    const q = (s: string, r: Record<string, string>) => compileQuery(s)(r);
    expect(q('elementSTARTSWITHu_^ORnameSTARTSWITHu_', { name: 'incident', element: 'u_cost' })).toBe(true);
    expect(q('elementSTARTSWITHu_^ORnameSTARTSWITHu_', { name: 'incident', element: 'state' })).toBe(false);
    expect(q('nameINa,b^elementISNOTEMPTY', { name: 'b', element: '' })).toBe(false);
    expect(q('nameINa,b^elementISNOTEMPTY^ORDERBYname', { name: 'a', element: 'x' })).toBe(true);
    expect(q('is_published=true^ORroles!=NULL', { is_published: 'false', roles: 'itil' })).toBe(true);
    expect(q('active=true', { name: 'no active field' })).toBe(true); // lenient on fields a fixture row lacks
  });
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
    // What we saw on a Zurich instance: say exactly what ServiceNow said, and the switch that fixes it.
    expect(explainOAuthError('disabled_grant_type', "'password' grant type is disabled", 'password')).toMatch(/ropc\.grant_type\.disabled = false.*ServiceNow said: disabled_grant_type: 'password' grant type is disabled/);
    expect(explainOAuthError('access_denied', undefined, 'password')).toMatch(/Client credentials grant" does not/);
    expect(explainOAuthError('access_denied')).toMatch(/default grant type.*System Logs.*crypto module/);
  });

  it('authenticates with basic auth when configured, and explains a rejected password', async () => {
    const sn = new FakeServiceNow([]);
    const c = new ServiceNowClient({ instanceUrl: sn.instanceUrl, auth: new BasicAuthProvider('svc.migration', 'pw-1'), fetch: sn.fetch, maxRequestsPerSecond: 1000, sleep: noSleep });
    expect(await c.count('sys_user_group')).toBeGreaterThanOrEqual(0);
    const bad = new ServiceNowClient({ instanceUrl: sn.instanceUrl, auth: new BasicAuthProvider('svc.migration', 'nope'), fetch: sn.fetch, maxRequestsPerSecond: 1000, sleep: noSleep });
    await expect(bad.count('sys_user_group')).rejects.toThrow(/user name or password \(401\)/);
  });

  it('logs every exchange without credentials, and redacts tokens in error bodies', async () => {
    const log: RequestLogEntry[] = [];
    const { fn } = fakeFetch((c) => c.url.includes('oauth') ? res(400, { error: 'invalid_scope', access_token: 'leaked-token' }) : res(200, { result: [] }));
    const http = loggingFetch(fn, (e) => log.push(e));
    const r = await http('https://x.service-now.com/oauth_token.do', { method: 'POST', headers: {}, body: 'client_secret=s3cret' });
    expect(await r.text()).toContain('leaked-token'); // the caller still gets the real body
    await http('https://x.service-now.com/api/now/table/sys_user?sysparm_limit=1', { method: 'GET', headers: { Authorization: 'Basic abc' } });
    expect(log).toHaveLength(2);
    expect(log[0]).toMatchObject({ method: 'POST', path: '/oauth_token.do', status: 400 });
    expect(log[0]!.detail).toContain('invalid_scope');
    expect(log[1]).toMatchObject({ status: 200, path: '/api/now/table/sys_user?sysparm_limit=1' });
    expect(JSON.stringify(log)).not.toMatch(/leaked-token|s3cret|Basic abc/);
  });

  it('sends an OAuth scope only when one is configured', async () => {
    const bodies: string[] = [];
    const { fn } = fakeFetch((c) => { bodies.push(String(c.body)); return res(200, { access_token: 't', expires_in: 1800 }); });
    await new ClientCredentialsProvider('https://x.service-now.com', 'cid', 'secret', fn).getToken();
    await new ClientCredentialsProvider('https://x.service-now.com', 'cid', 'secret', fn, Date.now, 'useraccount').getToken();
    expect(bodies[0]).not.toContain('scope=');
    expect(bodies[1]).toContain('scope=useraccount');
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

  it('pulls only customer fields from sys_dictionary, with named columns, and the fill-rate classes in one small query', async () => {
    const sn = new FakeServiceNow(records);
    await collectLive(client(sn, 500), { ...opts, pulls: STANDARD_PULLS });
    const dict = sn.requests.filter((r) => r.path === '/api/now/table/sys_dictionary');
    expect(dict[0]!.query).toMatch(/^elementSTARTSWITHu_\^ORelementSTARTSWITHx_\^ORnameSTARTSWITHu_\^ORnameSTARTSWITHx_/);
    expect(dict.some((r) => /nameSTARTSWITHcmdb|nameSTARTSWITHalm_/.test(r.query))).toBe(false);
    const fill = dict.filter((r) => r.query.startsWith('nameIN'));
    expect(fill.length).toBeLessThanOrEqual(1);
    if (fill[0]) expect(fill[0].query.split('^')[0]!.split(',').length).toBeLessThanOrEqual(15);
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
    expect(saved.phase).not.toBe('done');
    expect(saved.warnings.join(' ')).not.toMatch(/fetch failed/);
    down = false;
    const done = await collectSteps(c, saved, sink, opts);
    const whole = await collectLive(client(new FakeServiceNow(records)), opts);
    expect(snapshotOf(sn.instanceUrl, done, sink.all(), sink.aggregates, 30).records.length).toBe(whole.records.length);
  });

  it('counts before it pulls, and pulls context tables, then name indexes, then streamed tables', async () => {
    const sn = new FakeServiceNow(records);
    const sink = new MemorySink();
    const phases: string[] = [];
    await collectSteps(client(sn), startCursor(), sink, { ...opts, pulls: STANDARD_PULLS, checkpoint: async (x) => { if (phases.at(-1) !== x.phase) phases.push(x.phase); } });
    expect(phases).toEqual(['aggregates', 'fill', 'pulls', 'done']);
    const rank = (p: (typeof STANDARD_PULLS)[number]) => (p.stream ? 2 : p.index ? 1 : 0);
    expect(STANDARD_PULLS.map(rank)).toEqual([...STANDARD_PULLS.map(rank)].sort());
    expect(STANDARD_PULLS.filter((p) => p.stream).map((p) => p.table).sort()).toEqual([...STREAMED_TABLES].sort());
    for (const t of INDEXED_TABLES) expect(STREAMED_TABLES).toContain(t);
    // Index pages are names for streaming sinks; a memory sink keeps whole records only (no duplicates).
    const all = sink.all();
    expect(new Set(all.map((r) => `${r.table}:${r.sysId}`)).size).toBe(all.length);
  });

  it('refuses to resume a cursor from the previous plan order', async () => {
    const old = { ...startCursor(), version: undefined, phase: 'pulls' as const, index: 3 };
    await expect(collectSteps(client(new FakeServiceNow(records)), old, new MemorySink(), opts)).rejects.toThrow(/earlier version/);
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
    expect(String((err as Error).message)).toMatch(/refused the password grant.*ServiceNow said: invalid_grant: access_denied/);
    expect(String((err as Error).message)).not.toMatch(/wrong-pw-xyz|secret-1/);
  });
});
