import { describe, expect, it } from 'vitest';
import { AtlassianClient, AtlassianError, type HttpFetch, type HttpResponse } from '@snjsm/atlassian';

const res = (status: number, body: unknown = {}, headers: Record<string, string> = {}): HttpResponse => ({
  status, headers: { get: (n) => headers[n.toLowerCase()] ?? null }, text: async () => JSON.stringify(body),
});
function client(responses: (HttpResponse | Error)[]) {
  const calls: string[] = [];
  const fetch: HttpFetch = async (url, init) => {
    calls.push(`${init.method} ${url.replace(/^https:\/\/[^/]+/, '')}`);
    const r = responses.shift() ?? res(200);
    if (r instanceof Error) throw r;
    return r;
  };
  const c = new AtlassianClient({ site: 'x.atlassian.net', auth: { header: async () => 'Basic x', description: 'test' }, readOnly: false, fetch, sleep: async () => {} });
  return { c, calls };
}

describe('retries never repeat a write that may have been applied', () => {
  it('does not re-send a POST after a 5xx, and marks it uncertain', async () => {
    const { c, calls } = client([res(503), res(201, { id: 1 })]);
    const e = await c.jira('POST', '/rest/api/3/field', { name: 'x' }).catch((x) => x);
    expect(e).toBeInstanceOf(AtlassianError);
    expect(e.uncertain).toBe(true);
    expect(e.message).toMatch(/may have been applied/);
    expect(calls).toHaveLength(1);
  });
  it('marks a POST with no response as uncertain, without re-sending', async () => {
    const { c, calls } = client([new Error('socket hang up'), res(201)]);
    const e = await c.jira('POST', '/rest/api/3/project', {}).catch((x) => x);
    expect(e).toMatchObject({ uncertain: true, status: 0 });
    expect(calls).toHaveLength(1);
  });
  it('retries 429 for any method (rejected unprocessed)', async () => {
    const { c, calls } = client([res(429, {}, { 'retry-after': '1' }), res(201, { id: 7 })]);
    expect(await c.jira('POST', '/rest/api/3/field', {})).toEqual({ id: 7 });
    expect(calls).toHaveLength(2);
  });
  it('retries 5xx and lost responses for reads, PUT and query-only POSTs', async () => {
    const { c, calls } = client([res(502), new Error('reset'), res(200, { ok: 1 }), res(503), res(200, { values: [] }), res(500), res(204)]);
    expect(await c.jira('GET', '/rest/api/3/myself')).toEqual({ ok: 1 });
    expect(await c.jira('POST', '/rest/api/3/search/jql', {})).toEqual({ values: [] });
    await c.jira('PUT', '/rest/api/3/field/x/context/1/option', {});
    expect(calls).toHaveLength(7);
  });
  it('4xx is not uncertain', async () => {
    const { c } = client([res(400, { errorMessages: ['bad'] })]);
    const e = await c.jira('POST', '/rest/api/3/field', {}).catch((x) => x);
    expect(e).toMatchObject({ status: 400, uncertain: false });
  });
});
