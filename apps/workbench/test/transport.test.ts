import { describe, expect, it } from 'vitest';
import { cloudIdOf, ForgeSiteClient, productPath, type ProductRequest } from '../src/transport';

const site = 'https://acme-sandbox.atlassian.net';
const cloud = '11111111-2222-3333-4444-555555555555';

describe('Forge transport', () => {
  it('maps this site and Assets URLs to product paths, and refuses the rest', () => {
    expect(productPath(`${site}/rest/api/3/project/ITSD?expand=x`, site, cloud)).toBe('/rest/api/3/project/ITSD?expand=x');
    expect(productPath(`${site}/rest/servicedeskapi/servicedesk`, site, cloud)).toBe('/rest/servicedeskapi/servicedesk');
    expect(productPath('https://api.atlassian.com/jsm/assets/workspace/abc-123/v1/objectschema/list', site, cloud)).toBe('/jsm/assets/workspace/abc-123/v1/objectschema/list');
    expect(productPath(`https://api.atlassian.com/ex/jira/${cloud}/rest/api/3/myself`, site, cloud)).toBe('/rest/api/3/myself');
    for (const bad of [
      'https://other.atlassian.net/rest/api/3/project',
      `https://api.atlassian.com/ex/jira/99999999-2222-3333-4444-555555555555/rest/api/3/myself`,
      `https://api.atlassian.com/automation/public/jira/${cloud}/rest/v1/rule/summary`,
      `${site}/_edge/tenant_info`,
      `${site}/rest/api/3/../../wiki/rest/api/content`,
      `${site}/rest/api/3/%2e%2e/x`,
      `http://acme-sandbox.atlassian.net/rest/api/3/project`,
      `https://user:pw@acme-sandbox.atlassian.net/rest/api/3/project`,
      `${site}/secure/admin`,
      'not a url',
    ]) expect(productPath(bad, site, cloud)).toBeUndefined();
  });

  it('sends client requests through Forge without credentials and uses the install cloud id', async () => {
    const calls: { path: string; method: string; headers: Record<string, string>; body?: string }[] = [];
    const request: ProductRequest = async (path, init) => {
      calls.push({ path, ...init });
      const json = path === '/rest/servicedeskapi/assets/workspace' ? { values: [{ workspaceId: 'ws-1' }] } : { ok: path };
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(json) };
    };
    const ro = new ForgeSiteClient({ siteUrl: site, cloudId: cloud, request, readOnly: true });
    expect(await ro.cloudId()).toBe(cloud);
    expect(await ro.jira('GET', '/rest/api/3/myself')).toEqual({ ok: '/rest/api/3/myself' });
    expect(await ro.assets('GET', '/objectschema/list')).toEqual({ ok: '/jsm/assets/workspace/ws-1/v1/objectschema/list' });
    expect(calls.every((c) => !('Authorization' in c.headers))).toBe(true);
    await expect(ro.jira('POST', '/rest/api/3/project', {})).rejects.toThrow(/read-only/i);
    await expect(ro.call('GET', `https://api.atlassian.com/automation/public/jira/${cloud}/rest/v1/rule/summary`)).rejects.toMatchObject({ name: 'UnreachableError', status: 0 });

    const rw = new ForgeSiteClient({ siteUrl: site, cloudId: cloud, request, readOnly: false });
    await rw.jira('POST', '/rest/api/3/project', { key: 'ITSD' });
    expect(calls.at(-1)).toMatchObject({ path: '/rest/api/3/project', method: 'POST', body: '{"key":"ITSD"}' });
  });

  it('reads the cloud id from the install context only', () => {
    expect(cloudIdOf(`ari:cloud:jira::site/${cloud}`)).toBe(cloud);
    expect(() => cloudIdOf(undefined)).toThrow(/install context/);
    expect(() => cloudIdOf('ari:cloud:jira::site/../x')).toThrow(/install context/);
  });
});
