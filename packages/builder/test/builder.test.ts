import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFromXml } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import type { Blueprint } from '@snjsm/model';
import { getReferenceArtifact } from '@snjsm/reference';
import {
  FakeSite, apply, confirmManual, hashOf, healAspect, newState, plan, readState, renderApply, renderPlan, renderVerify, scopeElements,
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
    // "Request hardware" is a configured request type (the template's has no approvals), so it is created.
    expect(strategyOf(el('rt.request-new-hardware')).strategy).toBe('create+manual');
    expect(strategyOf(el('wf.service-request-approvals'))).toMatchObject({ strategy: 'adopt', aspects: ['approval steps'] });
    expect(strategyOf(el('fld.approvers')).strategy).toBe('adopt');
    expect(strategyOf(el('sp.it-service-desk')).strategy).toBe('create');
    expect(strategyOf(el('fld.hardware-model')).strategy).toBe('create+manual');
    // Schemas from a template are created in the UI (no public API), then bound by id.
    expect(strategyOf(el('as.schema.itam')).strategy).toBe('manual');
    expect(strategyOf(el('as.ot.hardware-model')).strategy).toBe('adopt');
    expect(strategyOf(el('as.attr.model-unit-cost')).strategy).toBe('adopt');
    expect(strategyOf(el('as.ot.person')).strategy).toBe('create');
    expect(strategyOf(el('as.attr.model-standard')).strategy).toBe('create');
    expect(strategyOf(el('sla.first-response')).strategy).toBe('manual');
    expect(strategyOf(el('auto.auto-approve-standard')).strategy).toBe('manual');
  });
  it('plans offline in dependency order, with previews and guided steps', async () => {
    const p = await plan({ bp: base });
    expect(p.mode).toBe('offline');
    const order = p.steps.map((s) => s.designId);
    const step = (id: string) => p.steps.find((s) => s.designId === id);
    expect(order.indexOf('sp.it-service-desk')).toBeLessThan(order.indexOf('rt.request-new-hardware'));
    expect(order.indexOf('as.ot.person')).toBeLessThan(order.indexOf('as.attr.person-manager'));
    expect(step('sp.it-service-desk')?.requests?.[0]).toMatchObject({ method: 'POST', path: '/rest/api/3/project' });
    // Everything in Assets waits for the guided "create the schema from the template" step.
    expect(step('as.schema.itam')?.action).toBe('manual');
    expect(step('as.schema.itam')?.manual?.instructions.join(' ')).toMatch(/template/i);
    expect(step('as.ot.hardware-model')).toMatchObject({ action: 'blocked', blockedBy: ['as.schema.itam'] });
    expect(step('as.ot.person')).toMatchObject({ action: 'blocked', blockedBy: ['as.schema.itam'] });
    // Attributes that reference a guided reference type wait for its id too.
    expect(step('as.attr.person-manager')?.blockedBy).toEqual(expect.arrayContaining(['ref.reports-to']));
    expect(step('sla.first-response')?.manual?.instructions.join(' ')).toMatch(/business hours|hours|days/);
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

/** The guided step a person does in the UI: create the ITAM schema from its template, then confirm it with the id. */
function createTemplateSchema(site: FakeSite, bp: Blueprint, state: ReturnType<typeof newState>) {
  const el = bp.design.find((d) => d.id === 'as.schema.itam') as Extract<Blueprint['design'][number], { type: 'assets-schema' }>;
  const ref = bp.design.find((d) => d.id === 'as.ot.hardware-model')!.referenceId!;
  const template = getReferenceArtifact(ref)!.partOf!;
  const schema = site.createSchemaFromTemplate(template, el.spec.name, el.spec.key!);
  confirmManual(bp, state, { designId: el.id, by: 'vish', remoteId: schema.id, remoteKey: schema.objectSchemaKey });
  return schema;
}

describe('apply on a fake sandbox', () => {
  it('builds, adopts template elements, records state, never deletes', async () => {
    const site = new FakeSite();
    const bp = signed(base);
    const { res, state } = await build(site, bp);
    expect(res.summary.failed).toBe(0);
    expect(site.writes.some((w) => w.method === 'DELETE')).toBe(false);
    const st = (id: string) => state.elements[id];
    expect(st('sp.it-service-desk')).toMatchObject({ status: 'created', remote: { kind: 'project', key: expect.any(String), extra: { serviceDeskId: expect.any(String) } } });
    // A configured request type: created by API; its form and portal group still need guided steps.
    expect(st('rt.request-new-hardware')).toMatchObject({ status: 'created', manualPending: expect.arrayContaining(['request form (fields, labels, form)']) });
    expect(site.writes.filter((w) => w.path.endsWith('/requesttype') && w.method === 'POST')).toHaveLength(1);
    expect(st('fld.approvers')).toMatchObject({ status: 'adopted', remote: { id: 'customfield_10003' } });
    expect(st('sla.first-response')?.status).toBe('manual-pending');
    expect(st('pg.computers')?.status).toBe('adopted');
    expect(st('wf.service-request-approvals')).toMatchObject({ status: 'adopted', manualPending: ['approval steps'] });
    expect(st('wt.service-request-approvals')).toMatchObject({ status: 'adopted', manualPending: [] });
    // "Hardware requests" is a new queue modelled on the template's, not the template's "Service requests" queue.
    expect(st('q.hardware-requests')?.status).toBe('manual-pending');
    // Assets waits for the guided template-schema step; nothing is created by API in Assets yet.
    expect(st('as.schema.itam')?.status).toBe('manual-pending');
    expect(site.writes.some((w) => w.path.startsWith('/objectschema/create'))).toBe(false);
    expect(res.results.find((r) => r.designId === 'as.ot.hardware-model')?.result).toBe('blocked');
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

  it('after the template schema is confirmed, adopts template object types and attributes and creates only the extensions', async () => {
    const site = new FakeSite();
    const bp = signed(base);
    const { state } = await build(site, bp);
    createTemplateSchema(site, bp, state);
    const typesBefore = site.objectTypes.length;
    const { res } = await build(site, bp, state);
    expect(res.summary.failed).toBe(0);
    const st = (id: string) => state.elements[id];
    expect(st('as.schema.itam')).toMatchObject({ status: 'manual-done', remote: { kind: 'assets-schema' } });
    // Template-provided: bound to what the template created, never re-created.
    for (const id of ['as.ot.hardware-model', 'as.attr.model-name', 'as.attr.model-unit-cost', 'as.attr.model-status']) expect(st(id)?.status, id).toBe('adopted');
    expect(st('as.ot.hardware-model')?.remote?.id).toBe(site.objectTypes.find((t) => t.name === 'Hardware Models')!.id);
    // Justified extensions: created by API.
    expect(st('as.ot.person')?.status).toBe('created');
    expect(st('as.attr.model-standard')?.status).toBe('created');
    expect(st('as.attr.person-user')?.status).toBe('created');
    // An object type created through the API has only Key, Created and Updated (live site), so Name is created.
    expect(st('as.attr.person-name')?.status).toBe('created');
    expect(site.attributes.filter((a) => a.objectTypeId === st('as.ot.person')!.remote!.id && a.name === 'Name')).toHaveLength(1);
    expect(site.objectTypes.length).toBe(typesBefore + 1); // only Person
    expect(site.writes.filter((w) => /objecttypeattribute/.test(w.path) && (w.body as { name?: string })?.name === 'Unit Price')).toHaveLength(0);
    // The fields that point at the schema can now be built; the reference-type attribute still waits.
    expect(st('fld.hardware-model')?.status).toBe('created');
    expect(res.results.find((r) => r.designId === 'as.attr.person-manager')?.result).toBe('blocked');
  });

  it('unblocks dependents once a person confirms the guided step with the site id', async () => {
    const site = new FakeSite();
    const bp = signed(base);
    const { state } = await build(site, bp);
    expect(() => confirmManual(bp, state, { designId: 'as.schema.itam', by: 'vish' })).toThrow(/record the site id/);
    createTemplateSchema(site, bp, state);
    expect(() => confirmManual(bp, state, { designId: 'ref.reports-to', by: 'vish' })).toThrow(/record the site id/);
    site.referenceTypes.push({ id: '77', name: 'Reports to' });
    confirmManual(bp, state, { designId: 'ref.reports-to', by: 'vish', remoteId: '77' });
    const next = await plan({ bp, state, api: site.client(true) });
    expect(next.steps.find((s) => s.designId === 'as.attr.person-manager')?.action).toBe('create');
    const r = await apply({ bp, state, api: site.client(false), readApi: site.client(true), approvedPlanHash: next.planHash });
    expect(r.results.find((x) => x.designId === 'as.attr.person-manager')?.result).toBe('done');
    expect(site.attributes.find((a) => a.name === 'Manager')).toMatchObject({ type: 1 });
  });

  it('lets a person correct a recorded site id (renamed or re-created in the UI) and builds with the new one', async () => {
    const site = new FakeSite();
    const bp = signed(base);
    const { state } = await build(site, bp);
    createTemplateSchema(site, bp, state);
    // Recorded before a rename in the UI; afterwards the site has a new id.
    confirmManual(bp, state, { designId: 'ref.reports-to', by: 'vish', remoteId: 'old-id' });
    site.referenceTypes.push({ id: 'new-id', name: 'Reports to' });
    const fixed = confirmManual(bp, state, { designId: 'ref.reports-to', by: 'vish', remoteId: 'new-id', note: 'renamed' });
    expect(fixed).toMatchObject({ status: 'manual-done', remote: { id: 'new-id' }, note: 'renamed; replaces assets-reference-type old-id' });
    expect(state.runs.at(-1)?.summary).toContain('site id old-id → new-id');
    // The same id again keeps the recorded remote and adds no "replaces" note.
    expect(confirmManual(bp, state, { designId: 'ref.reports-to', by: 'vish', remoteId: 'new-id' })).toMatchObject({ remote: { id: 'new-id' } });
    expect(state.elements['ref.reports-to']?.note).toBe('renamed; replaces assets-reference-type old-id');
    expect(state.runs.at(-1)?.summary).not.toContain('→');
    const next = await plan({ bp, state, api: site.client(true) });
    const manager = next.steps.find((s) => s.designId === 'as.attr.person-manager')!;
    expect(manager.action).toBe('create');
    expect(JSON.stringify(manager.requests)).toContain('new-id');
    const r = await apply({ bp, state, api: site.client(false), readApi: site.client(true), approvedPlanHash: next.planHash });
    expect(r.results.find((x) => x.designId === 'as.attr.person-manager')?.result).toBe('done');
  });

  it('records a confirmed element that differs from the design as the difference, not as its guided step again', async () => {
    const site = new FakeSite();
    const bp = signed(base);
    const { dry, state } = await build(site, bp);
    // The person reused a schema made from the template, but with a different key than the design.
    const el = bp.design.find((d) => d.id === 'as.schema.itam') as Extract<Blueprint['design'][number], { type: 'assets-schema' }>;
    const createTitle = dry.steps.find((s) => s.designId === el.id)!.manual!.title;
    expect(createTitle).toMatch(/^Create Assets schema/);
    const template = getReferenceArtifact(bp.design.find((d) => d.id === 'as.ot.hardware-model')!.referenceId!)!.partOf!;
    const schema = site.createSchemaFromTemplate(template, el.spec.name, `ZZ${el.spec.key}`);
    confirmManual(bp, state, { designId: el.id, by: 'vish', remoteId: schema.id, remoteKey: schema.objectSchemaKey });
    // As an older apply left it: the guided step's title recorded as pending work.
    state.elements[el.id]!.manualPending = [createTitle];
    const p = await plan({ bp, state, api: site.client(true) });
    const step = p.steps.find((s) => s.designId === el.id)!;
    const setKey = `set key to ${JSON.stringify(el.spec.key)}`;
    expect(step).toMatchObject({ action: 'manual', manualAspects: [setKey] });
    // The guided step says "update it to match", never "create it" again.
    expect(step.manual).toMatchObject({
      title: `Update assets schema "${el.name}" (ZZ${el.spec.key}) to match the design`,
      record: 'confirm', values: { key: el.spec.key }, checks: [`key is ${JSON.stringify(el.spec.key)}`],
    });
    expect(step.manual!.instructions[0]).toBe(`Change key from "ZZ${el.spec.key}" to ${JSON.stringify(el.spec.key)}.`);
    expect(JSON.stringify(step.manual)).not.toContain('Create Assets schema');
    expect(step.manual!.where).toBe(`The settings of assets schema ZZ${el.spec.key} on the site (not the create screen)`);
    expect(renderPlan(p)).toContain(step.manual!.title);
    await apply({ bp, state, api: site.client(false), readApi: site.client(true), approvedPlanHash: p.planHash });
    expect(state.elements[el.id]).toMatchObject({ status: 'manual-done', manualPending: [setKey] });
    const v = await verify(bp, state, site.client(true));
    expect(v.results.find((x) => x.designId === el.id)?.detail).toContain('set key to');
  });

  it('heals pending work that older applies recorded with the step title in front, however often repeated', async () => {
    expect(healAspect('Workflow "W": Workflow "W": approval steps', 'Workflow "W"')).toBe('approval steps');
    expect(healAspect('Workflow "W"', 'Workflow "W"')).toBe('');
    expect(healAspect('approval steps', 'Workflow "W"')).toBe('approval steps');
    expect(healAspect('Workflow "Other": x', 'Workflow "W"')).toBe('Workflow "Other": x');

    const site = new FakeSite();
    const bp = signed(base);
    const { state } = await build(site, bp);
    const id = 'wf.service-request-approvals';
    expect(state.elements[id]!.manualPending).toEqual(['approval steps']);
    const title = (await plan({ bp, state, api: site.client(true) })).steps.find((s) => s.designId === id)!.manual!.title;
    const prefix = title.slice(0, title.indexOf(': '));
    state.elements[id]!.manualPending = [`${prefix}: ${prefix}: ${prefix}: approval steps`];
    const p = await plan({ bp, state, api: site.client(true) });
    const step = p.steps.find((s) => s.designId === id)!;
    expect(step.manualAspects).toEqual(['approval steps']);
    expect(step.manual!.title).toBe(title);
    await apply({ bp, state, api: site.client(false), readApi: site.client(true), approvedPlanHash: p.planHash });
    expect(state.elements[id]!.manualPending).toEqual(['approval steps']);
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
    createTemplateSchema(site, bp, state);
    await build(site, bp, state);
    const v1 = await verify(bp, state, site.client(true));
    expect(v1.summary.ok).toBeGreaterThan(5);
    expect(v1.summary.pending).toBeGreaterThan(0);
    expect(v1.results.find((r) => r.designId === 'as.ot.hardware-model')?.status).toBe('ok');
    site.schemas[0]!.name = 'Renamed by someone';
    site.objectTypes.splice(site.objectTypes.findIndex((t) => t.name === 'Person'), 1);
    const v2 = await verify(bp, state, site.client(true));
    expect(v2.results.find((r) => r.designId === 'as.schema.itam')?.status).toBe('drift');
    expect(v2.results.find((r) => r.designId === 'as.ot.person')?.status).toBe('missing');
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

describe('uncertain writes', () => {
  // The first field the build creates through the API.
  const fieldEl = async () => {
    const p = await plan({ bp: base });
    const id = p.steps.find((s) => s.type === 'field' && s.action === 'create')!.designId;
    return base.design.find((d) => d.id === id)! as Extract<Blueprint['design'][number], { type: 'field' }>;
  };

  it('records the item when the create was applied but the response was lost, without re-sending it', async () => {
    const site = new FakeSite();
    site.faults.push({ method: 'POST', path: /^\/rest\/api\/3\/field$/, applied: true });
    const { res, state } = await build(site, signed(base));
    expect(site.faults).toHaveLength(0);
    const el = await fieldEl();
    expect(state.elements[el.id]).toMatchObject({ status: 'created' });
    expect(res.results.find((r) => r.designId === el.id)!.result).not.toBe('failed');
    expect(site.writes.filter((w) => w.method === 'POST' && w.path === '/rest/api/3/field' && (w.body as { name: string }).name === el.spec.name)).toHaveLength(1);
  });

  it('fails clearly when it was not applied, and the next run creates it once', async () => {
    const site = new FakeSite();
    site.faults.push({ method: 'POST', path: /^\/rest\/api\/3\/field$/, applied: false });
    const first = await build(site, signed(base));
    const failed = first.res.results.filter((r) => r.result === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]!.detail).toMatch(/probably not created/);
    const id = failed[0]!.designId;
    const again = await plan({ bp: signed(base), state: first.state, api: site.client(true) });
    const res2 = await apply({ bp: signed(base), state: first.state, api: site.client(false), readApi: site.client(true), approvedPlanHash: again.planHash, by: 'test' });
    expect(res2.summary.failed).toBe(0);
    expect(first.state.elements[id]!.status).toBe('created');
  });
});

describe('template awareness', () => {
  const el = (id: string) => base.design.find((d) => d.id === id)!;
  it('knows which Assets elements an Assets schema template provides', async () => {
    const { isTemplateProvided, isTemplateSchema, templateOf } = await import('@snjsm/builder');
    expect(isTemplateSchema(el('as.schema.itam'))).toBe(true);
    expect(templateOf(el('as.ot.hardware-model'))).toBe('assets-schema-template');
    expect(isTemplateProvided(el('as.ot.hardware-model'))).toBe(true);
    // Listed on the template's Hardware Models object type → provided.
    expect(isTemplateProvided(el('as.attr.model-unit-cost'))).toBe(true);
    expect(isTemplateProvided(el('as.attr.model-status'))).toBe(true);
    // Extensions are never template-provided.
    expect(isTemplateProvided(el('as.attr.model-standard'))).toBe(false);
    expect(isTemplateProvided(el('as.ot.person'))).toBe(false);
    expect(templateOf(el('rt.request-new-hardware'))).toBe('project-template');
  });

  it('binds the workflow by exact name, preferring the space copy over shared and look-alike workflows', async () => {
    const seed = new FakeSite(undefined, { systemPrefix: true });
    const templateKey = (el('sp.it-service-desk').spec as { templateKey: string }).templateKey;
    await seed.client(false).jira('POST', '/rest/api/3/project', { key: 'ITS', name: 'IT Support', projectTypeKey: 'service_desk', projectTemplateKey: templateKey, leadAccountId: 'x' });
    const template = seed.workflows.find((w) => /fulfilment with approvals/i.test(w.name))!;
    const plain = (template.name as string).replace(/\s+workflow$/i, '');
    // Look-alikes listed first, so a "contains" match would pick the wrong one.
    seed.workflows.unshift(
      { id: { entityId: 'w-lookalike' }, name: `${plain} (old copy)` },
      { id: { entityId: 'w-other-space' }, name: `HR: ${plain} workflow for Jira Service Management` },
      { id: { entityId: 'w-shared' }, name: `${plain} workflow` },
    );
    template.name = `ITS: ${plain} workflow for Jira Service Management`;
    const bp = { ...signed(base), design: base.design.map((d) => (d.type === 'space' ? ({ ...d, spec: { ...d.spec, mode: 'existing', key: 'ITS' } } as typeof d) : d)) };
    const state = newState(bp.id, seed.siteUrl);
    const dry = await plan({ bp, state, api: seed.client(true) });
    await apply({ bp, state, api: seed.client(false), readApi: seed.client(true), approvedPlanHash: dry.planHash });
    expect(state.elements['wf.service-request-approvals']?.remote?.id).toBe(template.id.entityId);

    // Without a space copy, the unprefixed exact match wins over the look-alike and the other space's copy.
    template.name = 'Something else';
    const state2 = newState(bp.id, seed.siteUrl);
    const dry2 = await plan({ bp, state: state2, api: seed.client(true) });
    await apply({ bp, state: state2, api: seed.client(false), readApi: seed.client(true), approvedPlanHash: dry2.planHash });
    expect(state2.elements['wf.service-request-approvals']?.remote?.id).toBe('w-shared');
  });
});

describe('lagging field list (seen on a live site)', () => {
  it('finds just-created fields through /field/search, so verify passes and a re-run never duplicates them', async () => {
    const site = new FakeSite(undefined, { staleFieldList: true });
    const bp = signed(base);
    const { state } = await build(site, bp);
    const created = Object.entries(state.elements).filter(([id, e]) => e.status === 'created' && id.startsWith('fld.')).map(([id]) => id);
    expect(created.length).toBeGreaterThan(0);
    // The full list really is stale in this fake.
    const list = (await site.client(true).jira('GET', '/rest/api/3/field')) as { id: string }[];
    created.forEach((id) => expect(list.some((f) => f.id === state.elements[id]!.remote!.id)).toBe(false));

    const v = await verify(bp, state, site.client(true));
    created.forEach((id) => expect(v.results.find((r) => r.designId === id)?.status, id).toBe('ok'));

    // Lost state (or a fresh state file): discovery by name must still find them, not create duplicates.
    const fresh = newState(bp.id, site.siteUrl);
    const again = await plan({ bp, state: fresh, api: site.client(true) });
    created.forEach((id) => expect(again.steps.find((s) => s.designId === id)?.action, id).toBe('adopt'));
    const fieldsBefore = site.fields.length;
    await apply({ bp, state: fresh, api: site.client(false), readApi: site.client(true), approvedPlanHash: again.planHash });
    expect(site.fields.length).toBe(fieldsBefore);
  });
});

describe('known API limits', () => {
  it('blocks a create the API would reject (Assets object type description > 70) and its dependents, in every plan mode', async () => {
    const bp = clone(base);
    const person = bp.design.find((d) => d.id === 'as.ot.person') as Extract<Blueprint['design'][number], { type: 'assets-object-type' }>;
    person.spec.description = 'x'.repeat(71);
    const site = new FakeSite();
    const state = newState(bp.id, site.siteUrl);
    await build(site, signed(clone(base)), state); // builds everything else, guided schema still pending
    createTemplateSchema(site, bp, state);
    const p = await plan({ bp, state, api: site.client(true) });
    const step = p.steps.find((s) => s.designId === 'as.ot.person')!;
    expect(step).toMatchObject({ action: 'blocked' });
    expect(step.reason).toMatch(/71 characters.*at most 70/);
    expect(p.steps.find((s) => s.designId === 'as.attr.person-user')?.action).toBe('blocked');
    expect(p.warnings.join(' ')).toMatch(/as\.ot\.person/);
    // Offline too.
    const off = await plan({ bp });
    expect(off.steps.find((s) => s.designId === 'as.ot.person')?.reason).toMatch(/at most 70/);
  });

  it('every catalogue design passes the known API limits', async () => {
    const { listCapabilities } = await import('@snjsm/reference');
    const { handlerFor } = await import('@snjsm/builder');
    for (const cap of listCapabilities()) for (const el of cap.design.elements) expect(handlerFor(el.type)?.validate?.(el as never), el.id).toBeUndefined();
  });
});
