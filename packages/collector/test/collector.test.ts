import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ClientCredentialsProvider, HttpFetch, ServiceNowClient, StaticTokenProvider, explainOAuthError,
  normaliseInstanceUrl, normaliseRow, parseXml,
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
