import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFromXml } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import type { Blueprint } from '@snjsm/model';
import {
  FakeSite, apply, confirmManual, hashOf, newState, plan, readState, renderApply, renderPlan, renderVerify, scopeElements,
  stableStringify, strategyOf, verify, withLock, workBreakdown, writeState,
} from '@snjsm/builder';

const xml = readFileSync(join(__dirname, '../../collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
const base = analyse(snapshotFromXml([{ name: 'enterprise.xml', xml }]), { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;
const signed = (bp: Blueprint): Blueprint => ({ ...bp, decisions: [...bp.decisions, { id: 'd.sign-off', at: '2026-01-02T00:00:00Z', by: 'vish', subject: { kind: 'blueprint', id: bp.id }, action: 'sign-off' }] });
const clone = <T>(x: T): T => structuredClone(x);

/** dry-run → apply against a fake site, as a person would after reviewing the dry-run. */
async function build(site: FakeSite, bp: Blueprint, state = newState(bp.id, site.siteUrl)) {
  const dry = await plan({ bp, state, api: site.client(true) });
  const res = await apply({ bp, state, api: site.client(false), readApi: site.client(true), approvedPlanHash: dry.planHash, by: 'test' });
  return { dry, res, state };
}

describe('hash and state', () => {
  it('hashes independently of key order', () => {
    expect(stableStringify({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
    expect(hashOf({ a: 1, b: 2 })).toBe(hashOf({ b: 2, a: 1 }));
  });
  it('writes state atomically and refuses a second lock', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'snjsm-'));
    const p = join(dir, 'state.json');
    writeState(p, newState('bp.x', 'https://s'));
    expect(readState(p)?.blueprintId).toBe('bp.x');
    await withLock(p, async () => {
      await expect(withLock(p, async () => 1)).rejects.toThrow(/locked/);
    });
    expect(existsSync(`${p}.lock`)).toBe(false);
  });
});

describe('strategy and offline plan', () => {
  it('adopts template elements, creates API-buildable ones, guides the rest', () => {
    const el = (id: string) => base.design.find((d) => d.id === id)!;
    expect(strategyOf(el('rt.request-new-hardware')).strategy).toBe('adopt');
    expect(strategyOf(el('wf.service-request-approvals'))).toMatchObject({ strategy: 'adopt', aspects: ['approval steps'] });
    expect(strategyOf(el('fld.approvers')).strategy).toBe('adopt');
    expect(strategyOf(el('sp.it-service-desk')).strategy).toBe('create');
    expect(strategyOf(el('fld.hardware-model')).strategy).toBe('create+manual');
    expect(strategyOf(el('as.schema.itam')).strategy).toBe('create');
    expect(strategyOf(el('sla.first-response')).strategy).toBe('manual');
    expect(strategyOf(el('auto.auto-approve-standard')).strategy).toBe('manual');
  });
  it('plans offline in dependency order, with previews and guided steps', async () => {
    const p = await plan({ bp: base });
    expect(p.mode).toBe('offline');
    const order = p.steps.map((s) => s.designId);
    expect(order.indexOf('sp.it-service-desk')).toBeLessThan(order.indexOf('rt.request-new-hardware'));
    expect(order.indexOf('as.ot.person')).toBeLessThan(order.indexOf('as.attr.person-manager'));
    expect(p.steps.find((s) => s.designId === 'sp.it-service-desk')?.requests?.[0]).toMatchObject({ method: 'POST', path: '/rest/api/3/project' });
    // Attributes that reference a guided reference type wait for its id.
    expect(p.steps.find((s) => s.designId === 'as.attr.person-manager')).toMatchObject({ action: 'blocked', blockedBy: ['ref.reports-to'] });
    expect(p.steps.find((s) => s.designId === 'sla.first-response')?.manual?.instructions.join(' ')).toMatch(/business hours|hours|days/);
    expect(renderPlan(p)).toContain('## Guided steps');
  });
  it('scopes to a capability with its dependencies', () => {
    // The request type needs the Assets schema too (through its Assets "hardware model" field).
    expect(scopeElements(base, { elementIds: ['rt.request-new-hardware'] }).map((e) => e.id)).toEqual(expect.arrayContaining(['sp.it-service-desk', 'pg.computers', 'fld.hardware-model', 'as.schema.itam']));
    const els = scopeElements(base, { elementIds: ['q.hardware-requests'] }).map((e) => e.id);
    expect(els).toEqual(['sp.it-service-desk', 'q.hardware-requests']);
  });
});

describe('safety gates', () => {
  it('refuses to apply without sign-off, with a read-only client, on another site, or with a changed plan', async () => {
    const site = new FakeSite();
    const state = newState(base.id, site.siteUrl);
    const dry = await plan({ bp: base, state, api: site.client(true) });
    const go = (o: Partial<Parameters<typeof apply>[0]>) => apply({ bp: base, state, api: site.client(false), readApi: site.client(true), approvedPlanHash: dry.planHash, ...o });
    await expect(go({})).rejects.toThrow(/not signed off/);
    await expect(go({ bp: signed(base), api: site.client(true) })).rejects.toThrow(/write-enabled/);
    await expect(go({ bp: signed(base), state: newState(base.id, 'https://prod.atlassian.net') })).rejects.toThrow(/pinned/);
    await expect(go({ bp: signed(base), approvedPlanHash: 'stale' })).rejects.toThrow(/changed since the approved dry-run/);
    await expect(plan({ bp: base, api: site.client(false) })).rejects.toThrow(/read-only/);
    expect(site.writes).toEqual([]);
  });
});

describe('apply on a fake sandbox', () => {
  it('builds, adopts template elements, records state, never deletes', async () => {
    const site = new FakeSite();
    const bp = signed(base);
    const { res, state } = await build(site, bp);
    expect(res.summary.failed).toBe(0);
    expect(site.writes.some((w) => w.method === 'DELETE')).toBe(false);
    const st = (id: string) => state.elements[id];
    expect(st('sp.it-service-desk')).toMatchObject({ status: 'created', remote: { kind: 'project', key: expect.any(String), extra: { serviceDeskId: expect.any(String) } } });
    // Provided by the ITSM template, so adopted, not created; its form still needs a guided step.
    expect(st('rt.request-new-hardware')).toMatchObject({ status: 'adopted', manualPending: expect.arrayContaining(['request form (fields, labels, form)']) });
    expect(site.writes.filter((w) => w.path.endsWith('/requesttype') && w.method === 'POST')).toHaveLength(0);
    expect(st('fld.approvers')).toMatchObject({ status: 'adopted', remote: { id: 'customfield_10003' } });
    expect(st('as.schema.itam')?.status).toBe('created');
    expect(st('as.attr.person-name')?.status).toBe('adopted'); // "Name" is created with every object type
    expect(st('sla.first-response')?.status).toBe('manual-pending');
    expect(st('pg.computers')?.status).toBe('adopted');
    expect(st('wf.service-request-approvals')).toMatchObject({ status: 'adopted', manualPending: ['approval steps'] });
    expect(st('wt.service-request-approvals')).toMatchObject({ status: 'adopted', manualPending: [] });
    // "Hardware requests" is a new queue modelled on the template's, not the template's "Service requests" queue.
    expect(st('q.hardware-requests')?.status).toBe('manual-pending');
    expect(res.results.find((r) => r.designId === 'as.attr.person-manager')?.result).toBe('blocked');
    expect(res.manual.length).toBeGreaterThan(5);
    expect(renderApply(res)).toContain('Guided steps to do now');
  });

  it('is idempotent: a second run writes nothing new', async () => {
    const site = new FakeSite();
    const bp = signed(base);
    const { state } = await build(site, bp);
    const writes = site.writes.length;
    const again = await plan({ bp, state, api: site.client(true) });
    expect(again.summary.create).toBe(0);
    await apply({ bp, state, api: site.client(false), readApi: site.client(true), approvedPlanHash: again.planHash });
    expect(site.writes.length).toBe(writes);
  });

  it('unblocks dependents once a person confirms the guided step with the site id', async () => {
    const site = new FakeSite();
    const bp = signed(base);
    const { state } = await build(site, bp);
    expect(() => confirmManual(bp, state, { designId: 'ref.reports-to', by: 'vish' })).toThrow(/record the site id/);
    site.referenceTypes.push({ id: '77', name: 'Reports to' }, { id: '78', name: 'Located at' });
    confirmManual(bp, state, { designId: 'ref.reports-to', by: 'vish', remoteId: '77' });
    confirmManual(bp, state, { designId: 'ref.located-at', by: 'vish', remoteId: '78' });
    const next = await plan({ bp, state, api: site.client(true) });
    expect(next.steps.find((s) => s.designId === 'as.attr.person-manager')?.action).toBe('create');
    const r = await apply({ bp, state, api: site.client(false), readApi: site.client(true), approvedPlanHash: next.planHash });
    expect(r.results.find((x) => x.designId === 'as.attr.person-manager')?.result).toBe('done');
    expect(site.attributes.find((a) => a.name === 'Manager')).toMatchObject({ type: 1 });
  });

  it('adds missing select options without removing existing ones', async () => {
    const site = new FakeSite();
    const bp = signed(clone(base));
    const sel = bp.design.find((d) => d.type === 'field' && (d.spec as { options?: string[] }).options?.length) as Extract<Blueprint['design'][number], { type: 'field' }> | undefined;
    if (!sel) return; // fixture design has no select field
    const { state } = await build(site, bp);
    sel.spec.options = [...sel.spec.options!, 'Extra option'];
    const p = await plan({ bp, state, api: site.client(true) });
    expect(p.steps.find((s) => s.designId === sel.id)?.action).toBe('update');
    await apply({ bp, state, api: site.client(false), readApi: site.client(true), approvedPlanHash: p.planHash });
    const ctx = [...site.contexts.get(state.elements[sel.id]!.remote!.id)!][0]!;
    expect(ctx.options.map((o) => o.value)).toEqual(sel.spec.options);
  });

  it('verifies the build and detects drift and missing elements', async () => {
    const site = new FakeSite();
    const bp = signed(base);
    const { state } = await build(site, bp);
    const v1 = await verify(bp, state, site.client(true));
    expect(v1.summary.ok).toBeGreaterThan(5);
    expect(v1.summary.pending).toBeGreaterThan(0);
    const schema = site.schemas[0]!;
    schema.name = 'Renamed by someone';
    site.objectTypes.splice(site.objectTypes.findIndex((t) => t.name === 'Location'), 1);
    const v2 = await verify(bp, state, site.client(true));
    expect(v2.results.find((r) => r.designId === 'as.schema.itam')?.status).toBe('drift');
    expect(v2.results.find((r) => r.designId === 'as.ot.location')?.status).toBe('missing');
    expect(renderVerify(v2)).toContain('drift');
  });
});

describe('work breakdown', () => {
  it('gives one epic per capability with automated and guided stories', async () => {
    const p = await plan({ bp: base });
    const epics = workBreakdown(base, p);
    expect(epics[0]).toMatchObject({ capabilityId: 'itsm.request-hardware' });
    expect(epics[0]!.items.some((i) => i.kind === 'automated')).toBe(true);
    expect(epics[0]!.items.some((i) => i.kind === 'guided')).toBe(true);
    // Every element belongs to exactly one epic (an API-built element may also have a guided story in that epic).
    const perEpic = epics.flatMap((e) => [...new Set(e.items.flatMap((i) => i.designIds))]);
    expect(new Set(perEpic).size).toBe(perEpic.length);
  });
});

describe('target space', () => {
  const withSpace = (bp: Blueprint, spec: Record<string, unknown>): Blueprint => ({
    ...bp, design: bp.design.map((d) => (d.type === 'space' ? ({ ...d, spec: { ...d.spec, ...spec } } as typeof d) : d)),
  });
  const spaceStep = (p: Awaited<ReturnType<typeof plan>>) => p.steps.find((s) => s.type === 'space')!;

  it('picks a free key when the derived key is taken, and creates the space with it', async () => {
    const site = new FakeSite();
    site.projects.push({ id: '1', key: 'ISD', name: 'Independence School District', projectTypeKey: 'service_desk' });
    const bp = signed(base);
    const dry = await plan({ bp, api: site.client(true) });
    expect(spaceStep(dry)).toMatchObject({ action: 'create', resolved: { key: 'ISD2' } });
    expect(spaceStep(dry).reason).toMatch(/ISD is taken: using ISD2/);
    expect((spaceStep(dry).requests![0]!.body as { key: string }).key).toBe('ISD2');
    const { res } = await build(site, bp);
    expect(res.summary.failed).toBe(0);
    expect(site.projects.map((p) => p.key)).toEqual(['ISD', 'ISD2']);
  });

  it('blocks a design key that is taken, and everything in that space', async () => {
    const site = new FakeSite();
    site.projects.push({ id: '1', key: 'ITSD', name: 'Other', projectTypeKey: 'service_desk' });
    const dry = await plan({ bp: withSpace(signed(base), { key: 'ITSD' }), api: site.client(true) });
    expect(spaceStep(dry).action).toBe('blocked');
    expect(spaceStep(dry).reason).toMatch(/ITSD cannot be used/);
    expect(dry.steps.find((s) => s.designId === 'rt.request-new-hardware')!.action).toBe('blocked');
  });

  it('never silently adopts a same-named space it did not create', async () => {
    const site = new FakeSite();
    const name = base.design.find((d) => d.type === 'space')!.name;
    site.projects.push({ id: '1', key: 'OLD', name, projectTypeKey: 'service_desk' });
    const dry = await plan({ bp: signed(base), api: site.client(true) });
    expect(spaceStep(dry).action).toBe('blocked');
    expect(spaceStep(dry).reason).toMatch(/already exists \(OLD\)/);
    expect(dry.warnings.some((w) => /already exists/.test(w))).toBe(true);
  });

  it('builds into an existing space by key without creating one', async () => {
    const site = new FakeSite();
    // An existing space created from the template, with "[System]" work type names as seen on a live site.
    const seed = new FakeSite(site.siteUrl, { systemPrefix: true });
    await seed.client(false).jira('POST', '/rest/api/3/project', { key: 'ITS', name: 'IT Support', projectTypeKey: 'service_desk', projectTemplateKey: base.design.find((d) => d.type === 'space')!.spec.templateKey, leadAccountId: 'x' });
    const bp = withSpace(signed(base), { mode: 'existing', key: 'ITS' });
    const offline = await plan({ bp });
    expect(spaceStep(offline)).toMatchObject({ strategy: 'adopt', action: 'adopt' });
    const dry = await plan({ bp, api: seed.client(true) });
    expect(spaceStep(dry)).toMatchObject({ action: 'adopt', resolved: { key: 'ITS' } });
    expect(dry.steps.find((s) => s.designId === 'wt.service-request-approvals')).toMatchObject({ action: 'adopt' });
    expect(dry.steps.find((s) => s.designId === 'wt.service-request-approvals')!.changes ?? []).toEqual([]);
    expect(dry.steps.find((s) => s.designId === 'wt.service-request-approvals')!.remote?.name).toBe('[System] Service request with approvals');
    const state = newState(bp.id, seed.siteUrl);
    const res = await apply({ bp, state, api: seed.client(false), readApi: seed.client(true), approvedPlanHash: dry.planHash, by: 'test' });
    expect(res.summary.failed).toBe(0);
    expect(seed.writes.filter((w) => w.path === '/rest/api/3/project')).toHaveLength(1); // only the seed
    expect(state.elements['sp.it-service-desk']).toMatchObject({ status: 'adopted', remote: { key: 'ITS' } });
  });

  it('blocks an existing space that is not on the site, and rejects existing without a key', async () => {
    const dry = await plan({ bp: withSpace(signed(base), { mode: 'existing', key: 'NOPE' }), api: new FakeSite().client(true) });
    expect(spaceStep(dry).action).toBe('blocked');
    expect(spaceStep(dry).reason).toMatch(/NOPE was not found/);
    const { Blueprint: B } = await import('@snjsm/model');
    expect(B.safeParse(withSpace(base, { mode: 'existing', key: undefined })).success).toBe(false);
  });

  it('the plan hash changes when the resolved key changes', async () => {
    const a = new FakeSite();
    const b = new FakeSite();
    b.projects.push({ id: '1', key: 'ISD', name: 'x', projectTypeKey: 'service_desk' });
    const [pa, pb] = [await plan({ bp: base, api: a.client(true) }), await plan({ bp: base, api: b.client(true) })];
    expect(pa.planHash).not.toBe(pb.planHash);
  });
});
