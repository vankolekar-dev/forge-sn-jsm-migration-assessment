import { describe, expect, it } from 'vitest';
import { AtlassianClient, type AtlassianAuth, type HttpFetch } from '@snjsm/atlassian';
import { ReferenceFile, referenceArtifacts } from '@snjsm/reference';
import jsmItsm from '../../reference/src/data/atlassian/jsm-itsm.json';
import { applyReport, captureSite, compareCapture, diffStatuses, parseArgs, runSpike } from '../src';

const auth: AtlassianAuth = { description: 'test', header: async () => 'Basic dGVzdA==' };
const SITE = 'https://example.atlassian.net';
const ASSETS = 'https://api.atlassian.com/jsm/assets/workspace/ws-1/v1';

type Route = (method: string, body: any) => { status: number; json?: unknown } | undefined;

/** Fake site: routes keyed by "METHOD url-without-query" or by url-with-query. Records every call. */
function fakeSite(routes: Record<string, unknown | Route>) {
  const calls: string[] = [];
  const fetch: HttpFetch = async (url, init) => {
    calls.push(`${init.method} ${url}`);
    const bare = url.split('?')[0];
    const hit = routes[`${init.method} ${url}`] ?? routes[`${init.method} ${bare}`];
    let res: { status: number; json?: unknown } = { status: 404, json: { errorMessages: ['not found'] } };
    if (typeof hit === 'function') res = (hit as Route)(init.method, init.body ? JSON.parse(init.body) : undefined) ?? res;
    else if (hit !== undefined) res = { status: 200, json: hit };
    return { status: res.status, headers: { get: () => null }, text: async () => (res.json === undefined ? '' : JSON.stringify(res.json)) };
  };
  return { fetch, calls };
}

const STATUSES_WITH_APPROVALS = [
  { name: 'Waiting for approval', statusCategory: { key: 'new' } },
  { name: 'Waiting for support', statusCategory: { key: 'new' } },
  { name: 'In progress', statusCategory: { key: 'indeterminate' } },
  { name: 'Waiting for customer', statusCategory: { key: 'indeterminate' } },
  { name: 'Resolved', statusCategory: { key: 'done' } },
  { name: 'Declined', statusCategory: { key: 'done' } },
  { name: 'Canceled', statusCategory: { key: 'done' } },
  { name: 'Closed', statusCategory: { key: 'done' } },
  { name: 'Escalated', statusCategory: { key: 'indeterminate' } },
];

function referenceSite() {
  return fakeSite({
    [`GET ${SITE}/rest/api/3/project/REFITSM`]: {
      id: '10001', key: 'REFITSM', name: 'Reference ITSM', projectTypeKey: 'service_desk', style: 'classic',
      issueTypes: [
        { id: '1', name: 'Service request', subtask: false },
        { id: '2', name: 'Service request with approvals', subtask: false },
        { id: '3', name: 'Incident', subtask: false },
        { id: '9', name: 'Emailed request', subtask: false },
      ],
    },
    [`GET ${SITE}/rest/api/3/project/REFITSM/statuses`]: [
      { name: 'Service request with approvals', statuses: STATUSES_WITH_APPROVALS },
      { name: 'Service request', statuses: STATUSES_WITH_APPROVALS.slice(1) },
    ],
    [`GET ${SITE}/rest/api/3/workflowscheme/project`]: { values: [{ workflowScheme: { id: 5, name: 'REFITSM scheme', defaultWorkflow: 'jira', issueTypeMappings: { '2': 'REFITSM: Service Request Fulfilment workflow with approvals' } } }] },
    [`GET ${SITE}/rest/servicedeskapi/servicedesk`]: { isLastPage: true, values: [{ id: '7', projectId: '10001', projectKey: 'REFITSM' }, { id: '8', projectId: '10002', projectKey: 'SPIKE' }] },
    [`GET ${SITE}/rest/servicedeskapi/servicedesk/7/requesttypegroup`]: { isLastPage: true, values: [{ id: '11', name: 'Computers' }, { id: '12', name: 'Common requests' }, { id: '13', name: 'Logins and accounts' }] },
    [`GET ${SITE}/rest/servicedeskapi/servicedesk/7/requesttype`]: { isLastPage: true, values: [
      { id: '21', name: 'Request new hardware', issueTypeId: '2', groupIds: ['11'] },
      { id: '22', name: 'Report broken hardware', issueTypeId: '1', groupIds: ['11'] },
    ] },
    [`GET ${SITE}/rest/servicedeskapi/servicedesk/7/requesttype/21/field`]: { requestTypeFields: [{ fieldId: 'summary', name: 'Summary', required: true }] },
    [`GET ${SITE}/rest/servicedeskapi/servicedesk/7/requesttype/22/field`]: { requestTypeFields: [] },
    [`GET ${SITE}/rest/servicedeskapi/servicedesk/7/queue`]: { isLastPage: true, values: [{ id: '31', name: 'Service requests', jql: 'type = "Service request"' }] },
    [`GET ${SITE}/rest/api/3/field`]: [{ id: 'customfield_10003', name: 'Approvers', custom: true, schema: { type: 'array', custom: 'com.atlassian.servicedesk:sd-approvals' } }],
    [`GET ${SITE}/rest/servicedeskapi/assets/workspace`]: { values: [{ workspaceId: 'ws-1' }] },
    [`GET ${ASSETS}/objectschema/list`]: { values: [{ id: '4', name: 'Reference ITAM', objectSchemaKey: 'RITAM' }] },
    [`GET ${ASSETS}/objectschema/4/objecttypes/flat`]: [
      { id: '40', name: 'Hardware' },
      { id: '41', name: 'Laptops', parentObjectTypeId: '40' },
      { id: '42', name: 'Location' },
    ],
    [`GET ${ASSETS}/objecttype/40/attributes`]: [{ name: 'Name', type: 0, defaultType: { id: 0 } }, { name: 'Location', type: 1 }],
    [`GET ${ASSETS}/objecttype/41/attributes`]: [{ name: 'Serial number', type: 0, defaultType: { id: 0 } }],
    [`GET ${ASSETS}/objecttype/42/attributes`]: [],
    [`GET ${ASSETS}/config/statustype`]: [{ name: 'In use', category: 1 }, { name: 'Retired', category: 0 }],
  });
}

describe('client read-only guard', () => {
  it('refuses mutations but allows known query POSTs', async () => {
    const { fetch, calls } = fakeSite({ [`POST ${SITE}/rest/api/3/workflows`]: { workflows: [] } });
    const c = new AtlassianClient({ site: 'example.atlassian.net', auth, fetch });
    await expect(c.raw('POST', `${SITE}/rest/api/3/workflows/create`, {})).rejects.toThrow(/read-only/);
    await expect(c.raw('DELETE', `${SITE}/rest/api/3/field/x`)).rejects.toThrow(/read-only/);
    expect((await c.raw('POST', `${SITE}/rest/api/3/workflows`, {})).status).toBe(200);
    expect(calls).toEqual([`POST ${SITE}/rest/api/3/workflows`]);
  });
});

describe('capture + compare', () => {
  it('captures a site read-only and classifies findings against the library', async () => {
    const { fetch, calls } = referenceSite();
    const client = new AtlassianClient({ site: SITE, auth, fetch });
    const cap = await captureSite(client, { projectKey: 'REFITSM', schemaName: 'reference itam' });
    expect(calls.every((c) => c.startsWith('GET '))).toBe(true);
    expect(cap.serviceDesk?.requestTypes.find((r) => r.name === 'Request new hardware')?.groups).toEqual(['Computers']);
    expect(cap.assets?.objectTypes.find((t) => t.name === 'Laptops')?.parent).toBe('Hardware');

    const r = compareCapture(cap, referenceArtifacts(), { jsmTemplate: 'atl.jsm.template.itsm', assetsTemplate: 'atl.assets.template.itam' });
    const f = (id: string) => r.findings.find((x) => x.artifactId === id);
    expect(f('atl.jsm.template.itsm')?.result).toBe('matched');
    expect(f('atl.jsm.itsm.work-type.service-request')?.result).toBe('matched');
    expect(f('atl.jsm.itsm.work-type.problem')?.result).toBe('missing');
    const wf = f('atl.jsm.itsm.workflow.service-request-fulfilment-with-approvals')!;
    expect(wf.result).toBe('mismatched');
    expect(wf.details).toContain('extra status "Escalated" (IN_PROGRESS)');
    expect(wf.captured?.siteWorkflowName).toMatch(/with approvals/);
    expect(f('atl.jsm.itsm.request-type.request-new-hardware')?.result).toBe('matched');
    expect(f('atl.jsm.itsm.request-type.report-broken-hardware')?.details[0]).toMatch(/work type "Service request", expected "Incident"/);
    expect(f('atl.jsm.itsm.sla.time-to-first-response')?.result).toBe('not-captured');
    expect(f('atl.jsm.field.approvers')?.captured).toMatchObject({ fields: [{ customType: 'com.atlassian.servicedesk:sd-approvals' }] });
    expect(f('atl.assets.itam.object-type.model')?.result).toBe('missing');
    const extras = r.findings.filter((x) => x.result === 'extra').map((x) => `${x.kind}:${x.name}`);
    expect(extras).toEqual(expect.arrayContaining(['work-type:Emailed request', 'portal-group:Logins and accounts', 'assets-object-type:Laptops']));
    expect(r.summary.matched + r.summary.mismatched + r.summary.missing + r.summary.extra + r.summary['not-captured']).toBe(r.findings.length);
  });

  it('diffStatuses reports missing, recategorised and extra statuses', () => {
    expect(diffStatuses([{ name: 'A', category: 'TODO' }, { name: 'B', category: 'DONE' }], [{ name: 'a', category: 'TODO' }, { name: 'B', category: 'IN_PROGRESS' }, { name: 'C', category: 'DONE' }]))
      .toEqual(['status "B" category IN_PROGRESS, expected DONE', 'extra status "C" (DONE)']);
  });
});

describe('applyReport', () => {
  it('verifies matches, corrects workflow statuses, flags the rest and never adds extras', async () => {
    const { fetch } = referenceSite();
    const cap = await captureSite(new AtlassianClient({ site: SITE, auth, fetch }), { projectKey: 'REFITSM' });
    const report = compareCapture(cap, referenceArtifacts(), { jsmTemplate: 'atl.jsm.template.itsm' });
    const file = ReferenceFile.parse(jsmItsm);
    const { file: next, changes } = applyReport(file, report, '2026-10-14');
    const a = (id: string) => next.artifacts.find((x) => x.id === id)!;

    expect(ReferenceFile.parse(next).artifacts).toHaveLength(file.artifacts.length);
    expect(a('atl.jsm.itsm.work-type.service-request').verification).toMatchObject({ status: 'verified', verifiedOn: '2026-10-14' });
    const wf = a('atl.jsm.itsm.workflow.service-request-fulfilment-with-approvals');
    expect(wf.verification.status).toBe('verified');
    expect((wf.attributes.statuses as { name: string }[]).map((s) => s.name)).toContain('Escalated');
    expect(a('atl.jsm.itsm.work-type.problem').verification).toMatchObject({ status: 'unverified', notes: expect.stringMatching(/^missing/) });
    expect(a('atl.jsm.itsm.request-type.report-broken-hardware').verification.status).toBe('unverified');
    expect(a('atl.jsm.itsm.sla.time-to-resolution')).toEqual(file.artifacts.find((x) => x.id === 'atl.jsm.itsm.sla.time-to-resolution'));
    expect(changes.some((c) => c.action === 'verified-with-corrections')).toBe(true);
    // the input is not mutated
    expect(file.artifacts.find((x) => x.id === 'atl.jsm.itsm.work-type.service-request')!.verification.status).toBe('unverified');
  });
});

describe('api spike', () => {
  const clientFor = (fetch: HttpFetch, readOnly = true) => new AtlassianClient({ site: SITE, auth, fetch, readOnly });

  it('refuses unsafe write configurations', async () => {
    const { fetch } = referenceSite();
    await expect(runSpike({ client: clientFor(fetch, false), projectKey: 'REFITSM', write: true, tag: 't' })).rejects.toThrow(/sandbox/);
    await expect(runSpike({ client: clientFor(fetch, false), projectKey: 'REFITSM', sandboxKey: 'refitsm', write: true, tag: 't' })).rejects.toThrow(/must not be the reference/);
    await expect(runSpike({ client: clientFor(fetch, true), projectKey: 'REFITSM', sandboxKey: 'SPIKE', write: true, tag: 't' })).rejects.toThrow(/readOnly/);
  });

  it('read mode only issues GETs / query POSTs and skips write probes', async () => {
    const { fetch, calls } = referenceSite();
    const r = await runSpike({ client: clientFor(fetch), projectKey: 'REFITSM', write: false, tag: 't' });
    expect(r.results.filter((x) => x.mode === 'write').every((x) => x.outcome === 'skipped')).toBe(true);
    expect(r.results.find((x) => x.probe === 'portal-group.read')).toMatchObject({ outcome: 'available', evidence: '3 groups readable' });
    expect(calls.every((c) => c.startsWith('GET ') || /rule\/summary$/.test(c))).toBe(true);
  });

  it('write mode cleans up and reports leftovers when cleanup fails', async () => {
    const group = `${SITE}/rest/servicedeskapi/servicedesk/8/requesttypegroup`;
    const rt = `${SITE}/rest/servicedeskapi/servicedesk/8/requesttype`;
    const { fetch, calls } = fakeSite({
      [`GET ${SITE}/rest/servicedeskapi/servicedesk`]: { isLastPage: true, values: [{ id: '8', projectId: '10002', projectKey: 'SPIKE' }] },
      [`GET ${SITE}/rest/api/3/issuetype/project`]: [{ id: '5', name: 'Task', subtask: false }],
      [`POST ${group}`]: () => ({ status: 201, json: { id: '99' } }),
      [`DELETE ${group}/99`]: () => ({ status: 204 }),
      [`POST ${rt}`]: (_m: string, body: any) => ({ status: 201, json: { id: '77', name: body.name } }),
      [`DELETE ${rt}/77`]: () => ({ status: 403, json: { errorMessage: 'nope' } }),
    });
    const r = await runSpike({ client: clientFor(fetch, false), projectKey: 'REFITSM', sandboxKey: 'SPIKE', write: true, tag: 't1' }, ['portal-group.create', 'request-type.create']);
    expect(r.results.map((x) => [x.probe, x.outcome, x.suggests?.status])).toEqual([
      ['portal-group.create', 'available', 'api'],
      ['request-type.create', 'available', 'partial'],
    ]);
    expect(calls).toContain(`DELETE ${group}/99`);
    expect(r.leftovers).toEqual([expect.objectContaining({ what: 'request type', id: '77' })]);
  });
});

describe('parseArgs', () => {
  it('parses flags, inline values and switches', () => {
    expect(parseArgs(['--site', 'x', '--schema=Reference ITAM', '--update', 'pos'])).toEqual({ flags: { site: 'x', schema: 'Reference ITAM', update: 'pos' }, positional: [] });
    expect(parseArgs(['--update', '--site', 'x'])).toEqual({ flags: { update: true, site: 'x' }, positional: [] });
  });
});
