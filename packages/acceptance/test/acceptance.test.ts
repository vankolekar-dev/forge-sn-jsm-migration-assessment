import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFromXml } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import { type Blueprint, type DesignElement, type Duration } from '@snjsm/model';
import { getCapability, getReferenceArtifact } from '@snjsm/reference';
import { FakeSite, apply, confirmManual, newState, pendingManual, plan, writeState, type BuildState } from '@snjsm/builder';
import {
  type Clock, TEST_TAG, cleanupTestData, criterionVerdict, outcomeVerdict, planAcceptance, renderAcceptancePlan,
  renderAcceptanceResult, runAcceptance,
} from '@snjsm/acceptance';
import { BuildService, cleanupPhrase, testPhrase } from '@snjsm/mcp-server';

const xml = readFileSync(join(__dirname, '../../collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
const base = analyse(snapshotFromXml([{ name: 'enterprise.xml', xml }]), { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;
const MANAGER = 'acc-manager';
const REQUESTER = 'acc-requester';

const fakeClock = (): Clock & { t: number } => ({ t: Date.parse('2026-10-18T10:00:00Z'), now() { return this.t; }, async sleep(ms) { this.t += ms; } });
const param = (bp: Blueprint, name: string) => bp.outcomes.map((o) => o.parameters[name]).find((v) => v !== undefined);

async function dryRunApply(site: FakeSite, bp: Blueprint, state: BuildState) {
  const dry = await plan({ bp, state, api: site.client(true) });
  await apply({ bp, state, api: site.client(false), readApi: site.client(true), approvedPlanHash: dry.planHash, allowUnsigned: true, by: 'test' });
}

/** Build everything on a fake sandbox, doing every guided step as a person would. */
async function buildAll(site: FakeSite, bp: Blueprint) {
  const state = newState(bp.id, site.siteUrl);
  await dryRunApply(site, bp, state);
  const schemaEl = bp.design.find((d) => d.type === 'assets-schema') as Extract<DesignElement, { type: 'assets-schema' }>;
  const template = getReferenceArtifact(bp.design.find((d) => d.id === 'as.ot.hardware-model')!.referenceId!)!.partOf!;
  const schema = site.createSchemaFromTemplate(template, schemaEl.spec.name, schemaEl.spec.key!);
  confirmManual(bp, state, { designId: schemaEl.id, by: 'vish', remoteId: schema.id, remoteKey: schema.objectSchemaKey });
  site.referenceTypes.push({ id: '77', name: 'Reports to' });
  confirmManual(bp, state, { designId: 'ref.reports-to', by: 'vish', remoteId: '77' });
  for (let round = 0; round < 4; round++) {
    await dryRunApply(site, bp, state);
    const steps = await pendingManual(bp, state);
    if (!steps.length) break;
    for (const s of steps) confirmManual(bp, state, { designId: s.designId, by: 'vish', ...(state.elements[s.designId]?.remote ? {} : { remoteId: `m-${s.designId}` }) });
  }
  return state;
}

/** Emulate the sandbox's workflow, SLAs and automation rules for the request-hardware capability. */
function emulate(site: FakeSite, bp: Blueprint, state: BuildState, o: { team?: string; skipApprovers?: boolean } = {}) {
  const rid = (id: string) => state.elements[id]!.remote!.id;
  const threshold = param(bp, 'costThreshold') as number;
  const team = o.team ?? (param(bp, 'fulfilmentTeam') as string);
  for (const wf of bp.design.filter((e): e is Extract<DesignElement, { type: 'workflow' }> => e.type === 'workflow')) {
    const name = new Map(wf.spec.statuses.map((s) => [s.id, s.name]));
    const approvals = new Set(wf.spec.approvals.flatMap((a) => [a.approveTransitionId, a.declineTransitionId]));
    for (const t of wf.spec.transitions) if (!approvals.has(t.id)) site.transitions.push({ name: t.name, from: t.from.map((f) => name.get(f)!), to: name.get(t.to)! });
  }
  const ms = (d: Duration) => d.value * (d.unit === 'business-days' ? 8 * 3_600_000 : d.unit === 'minutes' ? 60_000 : 3_600_000);
  for (const s of bp.design.filter((e): e is Extract<DesignElement, { type: 'sla' }> => e.type === 'sla')) {
    const goal = s.spec.goals[0]!.target as Duration;
    site.slas.push({ name: s.spec.name, goalMillis: ms(goal), ...(/resolution/i.test(s.spec.name) ? { runningIn: ['Waiting for support', 'In Progress'] } : {}) });
  }
  const objectOf = (issue: Record<string, any>) => site.objects.find((x) => x.id === issue.fields[rid('fld.hardware-model')]?.[0]?.objectId);
  const attr = (obj: Record<string, any>, designId: string) => obj.attributes.find((a: any) => String(a.objectTypeAttributeId) === rid(designId))?.objectAttributeValues?.[0]?.value;
  const toSupport = (i: Record<string, any>) => { site.setStatus(i, 'Waiting for support'); i.fields['customfield_10001'] = { id: 'team-1', name: team }; };
  site.automation = (event, issue) => {
    if (event === 'created') {
      const m = objectOf(issue);
      const standard = m && attr(m, 'as.attr.model-standard') === 'true';
      const cost = m ? Number(attr(m, 'as.attr.model-unit-cost')) : Infinity;
      if (standard && cost < threshold) return toSupport(issue);
      site.setStatus(issue, 'Waiting for approval');
      if (!o.skipApprovers) { issue.fields[rid('fld.approvers')] = [{ accountId: MANAGER }]; site.requestApproval(issue, [MANAGER]); }
    }
    if (event === 'approval' && issue.fields.status.name === 'Waiting for support') toSupport(issue);
  };
}

async function world(o: { team?: string; skipApprovers?: boolean } = {}) {
  const site = new FakeSite();
  const bp = base;
  const state = await buildAll(site, bp);
  emulate(site, bp, state, o);
  return { site, bp, state };
}
const config = { personas: { requester: { accountId: REQUESTER } } };

describe('catalogue scenarios', () => {
  it('every automated criterion is a self-contained scenario with test data', () => {
    const cap = getCapability('itsm.request-hardware')!;
    expect(cap.fixtures.map((f) => f.id)).toEqual(expect.arrayContaining(['model-standard', 'model-over-threshold', 'person-requester', 'person-manager']));
    for (const o of cap.outcomes) for (const ac of o.acceptance) if (ac.verification === 'automated') expect(ac.check?.[0]?.kind, ac.id).toBe('create-request');
  });
});

describe('acceptance plan (offline)', () => {
  it('blocks criteria whose design elements still wait for guided steps, with the reason', async () => {
    const site = new FakeSite();
    const state = newState(base.id, site.siteUrl);
    await dryRunApply(site, base, state);
    const p = planAcceptance({ bp: base, state, site: site.siteUrl, config });
    expect(p.summary.ready).toBe(0);
    const intake = p.criteria.find((c) => c.acId.endsWith('intake.ac1'))!;
    expect(intake.status).toBe('blocked');
    expect(intake.reasons.join(' ')).toMatch(/guided step/);
    expect(p.fixtures.find((f) => f.id === 'person-requester')?.status).toBe('unavailable');
    expect(renderAcceptancePlan(p)).toContain('blocked');
  });

  it('is ready once everything is built; approver actions need the manager persona', async () => {
    const { bp, state, site } = await world();
    const without = planAcceptance({ bp, state, site: site.siteUrl, config });
    const decline = without.criteria.find((c) => c.acId.endsWith('approval.ac3'))!;
    expect(decline.status).toBe('blocked');
    expect(decline.reasons.join(' ')).toMatch(/no credentials for persona requester-manager/);
    const withMgr = planAcceptance({ bp, state, site: site.siteUrl, config, actors: ['requester-manager'] });
    expect(withMgr.criteria.filter((c) => c.steps.length).every((c) => c.status === 'ready')).toBe(true);
    expect(withMgr.fixtures.every((f) => f.status === 'create')).toBe(true);
    expect(withMgr.runHash).not.toBe(without.runHash);
    expect(planAcceptance({ bp, state, site: site.siteUrl, config, actors: ['requester-manager'] }).runHash).toBe(withMgr.runHash);
  });

  it('blocks automated criteria from a blueprint made with an older catalogue, with one clear reason', async () => {
    const { bp, state, site } = await world();
    const old = structuredClone(bp);
    for (const c of old.capabilities) c.catalogueVersion = '0.0.1';
    const p = planAcceptance({ bp: old, state, site: site.siteUrl, config, actors: ['requester-manager'] });
    const automated = p.criteria.filter((c) => c.steps.length);
    expect(automated.length).toBeGreaterThan(0);
    for (const c of automated) {
      expect(c.status).toBe('blocked');
      expect(c.reasons).toEqual([expect.stringMatching(/v0\.0\.1, but the catalogue is now v.*re-run the analysis/)]);
    }
    expect(p.criteria.filter((c) => !c.steps.length).every((c) => c.status === 'manual')).toBe(true);
  });

  it('flags design drift and excluded outcomes', async () => {
    const { bp, state, site } = await world();
    const changed = structuredClone(bp);
    const rt = changed.design.find((d) => d.id === 'rt.request-new-hardware')!;
    (rt.spec as { description?: string }).description = 'changed after the build';
    changed.outcomes.find((o) => o.id.endsWith('.o.routing'))!.status = 'deferred';
    const p = planAcceptance({ bp: changed, state, site: site.siteUrl, config, actors: ['requester-manager'] });
    expect(p.criteria.find((c) => c.acId.endsWith('intake.ac1'))!.reasons.join(' ')).toMatch(/changed in the design/);
    expect(p.criteria.find((c) => c.acId.endsWith('routing.ac1'))!.status).toBe('excluded');
  });
});

describe('acceptance run on a fake sandbox', () => {
  it('proves the outcomes end to end, acting as the manager, and removes its test data', async () => {
    const { bp, state, site } = await world();
    const p = planAcceptance({ bp, state, site: site.siteUrl, config, actors: ['requester-manager'] });
    const res = await runAcceptance({ plan: p, bp, state, api: site.client(false), personas: { 'requester-manager': site.client(false, MANAGER) }, config, runId: '20261018100000', clock: fakeClock() });
    const all = res.outcomes.flatMap((o) => o.criteria);
    const bad = all.filter((c) => c.verdict === 'fail' || c.verdict === 'error');
    expect(bad, JSON.stringify(bad, null, 1)).toEqual([]);
    const v = (suffix: string) => all.find((c) => c.acId.endsWith(suffix))!.verdict;
    expect(v('intake.ac1')).toBe('pass');
    expect(v('approval.ac2')).toBe('pass');
    expect(v('routing.ac1')).toBe('pass');
    expect(v('service-level.ac1')).toBe('pass');
    expect(v('approval.ac3')).toBe('partial'); // the decline notification is a manual check
    expect(res.manualChecks.some((m) => m.acId.endsWith('approval.ac3') && /declined/.test(m.check))).toBe(true);
    // Requests were raised on behalf of the requester; the approval decisions were made as the manager.
    const creates = site.writes.filter((w) => w.path === '/rest/servicedeskapi/request');
    expect(creates.every((w) => (w.body as { raiseOnBehalfOf?: string }).raiseOnBehalfOf === REQUESTER)).toBe(true);
    expect(site.writes.filter((w) => /\/approval\//.test(w.path)).every((w) => w.as === MANAGER)).toBe(true);
    expect(creates.every((w) => String((w.body as any).requestFieldValues.summary).startsWith(`[${TEST_TAG} 20261018100000]`))).toBe(true);
    // Test data was created, then cleaned up: nothing left on the site.
    expect(res.ledger.requests.length).toBe(creates.length);
    expect(res.ledger.objects.length).toBe(4);
    expect(res.ledger.cleanup?.leftovers).toEqual([]);
    expect(site.issues).toHaveLength(0);
    expect(site.objects).toHaveLength(0);
    const md = renderAcceptanceResult(res);
    expect(md).toContain('Manual checks');
    expect(md).toContain('Cleanup: removed');
  });

  it('reports a failing outcome with the evidence, and does not run later steps', async () => {
    const { bp, state, site } = await world({ team: 'Service desk', skipApprovers: true });
    const p = planAcceptance({ bp, state, site: site.siteUrl, config, actors: ['requester-manager'] });
    const res = await runAcceptance({ plan: p, bp, state, api: site.client(false), personas: { 'requester-manager': site.client(false, MANAGER) }, config, runId: '20261018100001', clock: fakeClock(), defaultWithinSeconds: 6 });
    const routing = res.outcomes.find((o) => o.outcomeId.endsWith('.o.routing'))!;
    expect(routing.verdict).toBe('fail');
    const step = routing.criteria[0]!.steps.find((s) => s.result === 'fail')!;
    expect(step.detail).toMatch(/Service desk/);
    expect(step.detail).toMatch(/waited 60s/);
    const ac3 = res.outcomes.flatMap((o) => o.criteria).find((c) => c.acId.endsWith('approval.ac3'))!;
    expect(ac3.verdict).toBe('fail');
    expect(ac3.steps.at(-1)!.result).toBe('not-run');
  });

  it('keeps test data when asked; cleanup removes only items that still carry the tag', async () => {
    const { bp, state, site } = await world();
    const p = planAcceptance({ bp, state, site: site.siteUrl, config, actors: ['requester-manager'], outcomeIds: ['itsm.request-hardware.o.intake'] });
    const res = await runAcceptance({ plan: p, bp, state, api: site.client(false), personas: { 'requester-manager': site.client(false, MANAGER) }, config, runId: '20261018100002', keep: true, clock: fakeClock() });
    expect(res.ledger.cleanup).toBeUndefined();
    expect(site.issues).toHaveLength(1);
    // Someone re-uses the request for real work: cleanup must leave it alone.
    site.issues[0]!.fields.summary = 'Real laptop request';
    const c = await cleanupTestData(site.client(false), res.ledger);
    expect(c!.leftovers.map((l) => l.ref)).toEqual([res.ledger.requests[0]!.key]);
    expect(site.issues).toHaveLength(1);
    expect(site.objects).toHaveLength(0);
  });

  it('verdict rules: parity needs every criterion to pass', () => {
    expect(criterionVerdict([{ index: 1, kind: 'x', result: 'pass', detail: '' }, { index: 2, kind: 'n', result: 'manual', detail: '' }])).toBe('partial');
    expect(outcomeVerdict(['pass', 'pass'])).toBe('pass');
    expect(outcomeVerdict(['pass', 'blocked'])).toBe('partial');
    expect(outcomeVerdict(['pass', 'fail', 'error'])).toBe('fail');
    expect(outcomeVerdict(['blocked', 'manual'])).toBe('blocked');
    expect(outcomeVerdict(['manual'])).toBe('manual');
  });
});

describe('service gates', () => {
  async function setup(o: { writeSites?: string[] } = {}) {
    const { bp, state, site } = await world();
    const workdir = mkdtempSync(join(tmpdir(), 'snjsm-acc-'));
    mkdirSync(join(workdir, 'fx'));
    mkdirSync(join(workdir, 'state'));
    mkdirSync(join(workdir, 'acceptance'));
    writeFileSync(join(workdir, 'fx/blueprint.json'), JSON.stringify(bp));
    writeState(join(workdir, 'state', `${bp.id}@${new URL(site.siteUrl).hostname}.json`), state);
    writeFileSync(join(workdir, 'acceptance', `${new URL(site.siteUrl).hostname}.json`), JSON.stringify(config));
    const svc = new BuildService({
      workdir, writeSites: o.writeSites ?? [site.siteUrl], allowUnsigned: true, by: 'tester', defaultSite: site.siteUrl,
      clientFor: (_s, ro) => site.client(ro),
      personaClientFor: (_s, p) => (p === 'requester-manager' ? site.client(false, MANAGER) : undefined),
      acceptance: { clock: fakeClock() },
    });
    // The sandbox build above writes to the fake site; gate checks must assert that refused calls add nothing.
    const built = site.writes.length;
    const newWrites = () => site.writes.slice(built);
    return { svc, site, workdir, blueprint: 'fx/blueprint.json', newWrites };
  }

  it('plans offline, then runs only with the allowlist and the exact phrase', async () => {
    const off = await setup({ writeSites: [] });
    const p0 = off.svc.acceptancePlan({ blueprint: off.blueprint });
    expect(p0.run).toMatch(/disabled/);
    await expect(off.svc.acceptanceRun({ blueprint: off.blueprint, runHash: p0.runHash, confirm: testPhrase(p0.runHash, off.site.siteUrl) })).rejects.toThrow(/SNJSM_WRITE_SITES/);
    expect(off.newWrites()).toHaveLength(0);

    const { svc, site, workdir, blueprint, newWrites } = await setup();
    const p = svc.acceptancePlan({ blueprint });
    expect(p.run).toContain(testPhrase(p.runHash, site.siteUrl));
    expect(existsSync(join(workdir, p.files.json))).toBe(true);
    await expect(svc.acceptanceRun({ blueprint, runHash: p.runHash, confirm: 'yes' })).rejects.toThrow(/exactly/);
    await expect(svc.acceptanceRun({ blueprint, runHash: 'deadbeefdeadbeef', confirm: testPhrase('deadbeefdeadbeef', site.siteUrl) })).rejects.toThrow(/no test plan/);
    expect(newWrites()).toHaveLength(0);

    const r = await svc.acceptanceRun({ blueprint, runHash: p.runHash, confirm: testPhrase(p.runHash, site.siteUrl), keep: true });
    expect(r.failed).toEqual([]);
    expect(r.testData).toContain(cleanupPhrase(r.runId, site.siteUrl));
    expect(site.issues.length).toBeGreaterThan(0);
    const st = JSON.parse(readFileSync(join(workdir, 'state', `${base.id}@${new URL(site.siteUrl).hostname}.json`), 'utf8'));
    expect(st.runs.at(-1)).toMatchObject({ op: 'acceptance', planHash: p.runHash });

    await expect(svc.acceptanceCleanup({ blueprint, runId: r.runId, confirm: 'CLEANUP' })).rejects.toThrow(/exactly/);
    const c = await svc.acceptanceCleanup({ blueprint, runId: r.runId, confirm: cleanupPhrase(r.runId, site.siteUrl) });
    expect(c.leftovers).toEqual([]);
    expect(site.issues).toHaveLength(0);
    expect(site.objects).toHaveLength(0);
  });

  it('refuses a run when the plan changed since review', async () => {
    const { svc, site, workdir, blueprint, newWrites } = await setup();
    const p = svc.acceptancePlan({ blueprint });
    writeFileSync(join(workdir, 'acceptance', `${new URL(site.siteUrl).hostname}.json`), JSON.stringify({ personas: { requester: { accountId: 'someone-else' } } }));
    await expect(svc.acceptanceRun({ blueprint, runHash: p.runHash, confirm: testPhrase(p.runHash, site.siteUrl) })).rejects.toThrow(/changed since it was reviewed/);
    expect(newWrites()).toHaveLength(0);
  });
});
