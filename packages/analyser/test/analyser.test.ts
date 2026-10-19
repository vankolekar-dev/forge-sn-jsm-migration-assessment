import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFromXml, tableStats, type Snapshot, type SnRecord } from '@snjsm/collector';
import { Blueprint } from '@snjsm/model';
import {
  analyse, analyseScript, durationMinutes, fillDeep, fillText, moneyThresholds, renderReport, toDuration,
} from '@snjsm/analyser';

const id = (n: number) => n.toString(16).padStart(32, '0');
const rec = (table: string, n: number, fields: Record<string, string>): SnRecord => ({ table, sysId: id(n), fields });

/** Small synthetic estate where every request-hardware parameter has evidence. */
function hardwareSnapshot(): Snapshot {
  const records: SnRecord[] = [
    rec('sys_user_group', 1, { name: 'Desktop Support', active: 'true' }),
    rec('sys_user_group', 2, { name: 'Service Desk', active: 'true' }),
    rec('sc_category', 3, { title: 'Hardware', active: 'true' }),
    rec('wf_workflow', 10, { name: 'Hardware approval', table: 'sc_req_item' }),
    rec('wf_workflow_version', 11, { workflow: id(10), name: 'Hardware approval', published: 'true' }),
    rec('wf_activity', 12, { workflow_version: id(11), name: 'Manager approval', activity_definition: 'Approval - User', order: '100' }),
    rec('wf_activity', 13, { workflow_version: id(11), name: 'Cost check', activity_definition: 'If', script: "answer = current.variables.price > 1500 ? 'yes' : 'no';", order: '50' }),
    rec('wf_activity', 14, { workflow_version: id(11), name: 'Deliver', activity_definition: 'Catalog Task', order: '200' }),
    rec('sc_cat_item', 20, { name: 'Standard laptop', category: id(3), group: id(1), workflow: id(10), price: '1200', active: 'true', short_description: 'Request a laptop' }),
    rec('sc_cat_item', 21, { name: 'Developer laptop', category: id(3), group: id(1), workflow: id(10), price: '2400', active: 'true' }),
    rec('sc_cat_item', 22, { name: 'Monitor', category: id(3), group: id(2), workflow: id(10), price: '300', active: 'true' }),
    rec('item_option_new', 30, { cat_item: id(20), name: 'justification', question_text: 'Business justification', type: '2', mandatory: 'true' }),
    rec('item_option_new', 31, { cat_item: id(20), name: 'needed_by', question_text: 'Needed by', type: '9' }),
    rec('cmn_schedule', 40, { name: 'Mon-Fri 8-5', time_zone: 'Europe/London' }),
    rec('cmn_schedule_span', 41, { schedule: id(40), name: 'Weekdays', days_of_week: '12345', start_date_time: '20250101T080000', end_date_time: '20250101T170000', type: '' }),
    rec('contract_sla', 50, { name: 'RITM response 4h', collection: 'sc_req_item', duration: '04:00:00', schedule: id(40), active: 'true', stop_condition: 'assigned_toISNOTEMPTY' }),
    rec('contract_sla', 51, { name: 'RITM resolution 3 days', collection: 'sc_req_item', duration: '1970-01-02 03:00:00', schedule: id(40), active: 'true' }),
    rec('contract_sla', 52, { name: 'P1 resolution', collection: 'incident', duration: '04:00:00', active: 'true' }),
  ];
  return { source: { kind: 'servicenow-xml', name: 'synthetic.xml', capturedAt: '2026-01-01T00:00:00Z' }, records, aggregates: [], warnings: [], stats: tableStats(records) };
}

describe('helpers', () => {
  it('finds monetary thresholds in scripts and queries', () => {
    expect(moneyThresholds("if (current.price > 1500) answer='yes'")).toEqual([1500]);
    expect(moneyThresholds('price>=2,000^active=true')).toEqual([2000]);
    expect(moneyThresholds('if (1000 < item.cost) x()')).toEqual([1000]);
    expect(moneyThresholds('priority > 2')).toEqual([]);
  });
  it('converts ServiceNow durations into Atlassian goals', () => {
    expect(durationMinutes('1970-01-02 03:00:00')).toBe(1620);
    expect(toDuration(240, 'Mon-Fri 8-5', 9)).toEqual({ value: 4, unit: 'business-hours' });
    expect(toDuration(1620, 'Mon-Fri 8-5', 9)).toEqual({ value: 3, unit: 'business-days' });
    expect(toDuration(240, undefined)).toEqual({ value: 4, unit: 'hours' });
    expect(toDuration(4320, '24x7')).toEqual({ value: 3, unit: 'days' });
  });
  it('fills placeholders as text and as typed values', () => {
    expect(fillText('over {{costThreshold}} needs approval', { costThreshold: 1500 })).toBe('over 1500 needs approval');
    expect(fillDeep({ lessThan: '{{costThreshold}}', smart: '{{reporter.accountId}}' }, { costThreshold: 1500 })).toEqual({ lessThan: 1500, smart: '{{reporter.accountId}}' });
    expect(fillText('{{firstResponse}}', { firstResponse: { value: 4, unit: 'business-hours' } })).toBe('4 business hours');
  });
  it('recognises script patterns', () => {
    const a = analyseScript("var gr = new GlideRecord('sc_task'); gr.initialize(); gr.insert();", 'server');
    expect(a?.patterns).toContain('record-creation');
  });
});

describe('analyse (synthetic hardware estate)', () => {
  const result = analyse(hardwareSnapshot(), { customer: 'Synthetic Co', now: '2026-01-01T00:00:00Z' });
  const { blueprint, assessment } = result;
  const cap = assessment.capabilities.find((c) => c.capabilityId === 'itsm.request-hardware');
  const param = (n: string) => cap!.parameters.find((p) => p.name === n)!;

  it('produces a schema-valid blueprint with no validation errors', () => {
    expect(() => Blueprint.parse(blueprint)).not.toThrow();
    expect(assessment.validation.filter((i) => i.severity === 'error')).toEqual([]);
  });
  it('detects the hardware capability from catalog items', () => {
    expect(cap).toBeDefined();
    expect(cap!.detection.coreEvidenceIds.length).toBe(3);
    expect(blueprint.capabilities[0]!.status).toBe('detected');
  });
  it('resolves parameters from evidence, not defaults', () => {
    expect(param('costThreshold')).toMatchObject({ value: 1500, method: 'rules' });
    expect(param('fulfilmentTeam')).toMatchObject({ value: 'Desktop Support', method: 'rules' });
    expect(param('fulfilmentTeam').alternatives.map((a) => a.value)).toContain('Service Desk');
    expect(param('firstResponse')).toMatchObject({ value: { value: 4, unit: 'business-hours' }, method: 'rules' });
    expect(param('fulfilmentTime')).toMatchObject({ value: { value: 3, unit: 'business-days' }, method: 'rules' });
    // The incident P1 SLA must not leak into a service-request goal.
    expect(param('fulfilmentTime').evidenceIds).not.toContain(`sn.contract_sla.${id(52)}`);
  });
  it('fills outcomes and acceptance tests with the resolved values', () => {
    const approval = blueprint.outcomes.find((o) => o.id === 'itsm.request-hardware.o.approval')!;
    expect(approval.statement).toContain('1500');
    expect(JSON.stringify(approval.acceptance)).not.toMatch(/\{\{\w+\}\}/);
    expect(approval.evidenceIds.length).toBeGreaterThan(0);
    const routing = blueprint.outcomes.find((o) => o.category === 'routing')!;
    expect(routing.statement).toContain('Desktop Support');
  });
  it('configures the reference design (team, SLA goals, calendar, automation threshold)', () => {
    const el = (i: string) => blueprint.design.find((d) => d.id === i)!;
    expect(el('team.hardware-fulfilment').spec).toMatchObject({ name: 'Desktop Support' });
    expect(el('sla.first-response').spec).toMatchObject({ goals: [{ target: { value: 4, unit: 'business-hours' } }] });
    expect(el('sla.time-to-resolution').spec).toMatchObject({ goals: [{ target: { value: 3, unit: 'business-days' } }] });
    expect(el('cal.business-hours').spec).toMatchObject({ timeZone: 'Europe/London', workingHours: [{ start: '08:00', end: '17:00' }] });
    expect(JSON.stringify(el('auto.auto-approve-standard').spec)).toContain('"lessThan":1500');
    for (const d of blueprint.design) expect(JSON.stringify(d.spec)).not.toMatch(/\{\{(costThreshold|fulfilmentTeam|firstResponse|fulfilmentTime)\}\}/);
  });
  it('reports fulfilment tasks as a gap (no fulfilment outcome in the capability)', () => {
    const gaps = blueprint.capabilities[0]!.fit!.gaps.map((g) => g.description);
    expect(gaps.some((g) => /fulfilment tasks/.test(g))).toBe(true);
  });
  it('scores complexity and renders a report', () => {
    expect(assessment.score.score).toBeGreaterThanOrEqual(0);
    expect(assessment.score.score).toBeLessThanOrEqual(100);
    const md = renderReport(result);
    expect(md).toContain('## 5. Outcomes for sign-off');
    expect(md).toContain('Desktop Support');
  });
  it('honours human overrides', () => {
    const r = analyse(hardwareSnapshot(), { customer: 'Synthetic Co', overrides: { 'itsm.request-hardware': { costThreshold: 999 } } });
    expect(r.blueprint.outcomes.find((o) => o.category === 'approval')!.parameters['costThreshold']).toBe(999);
  });
});

describe('analyse (enterprise fixture)', () => {
  const xml = readFileSync(join(__dirname, '../../collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
  const result = analyse(snapshotFromXml([{ name: 'enterprise.xml', xml }]), { customer: 'Fixture Co' });
  it('runs end to end with a valid blueprint', () => {
    expect(result.assessment.validation.filter((i) => i.severity === 'error')).toEqual([]);
    expect(result.assessment.areas.length).toBe(15);
    expect(Object.keys(result.assessment.extraction.unextracted)).toEqual([]);
  });
  it('falls back to catalogue defaults (low confidence) when evidence is missing', () => {
    const cap = result.assessment.capabilities[0];
    expect(cap?.parameters.every((p) => p.method === 'catalogue-default' && p.confidence === 'low')).toBe(true);
    expect(result.assessment.unknowns.some((u) => u.topic === 'Usage')).toBe(true);
  });
  it('keeps unrelated workflows out of the capability evidence', () => {
    const ev = new Map(result.blueprint.evidence.map((e) => [e.id, e]));
    const names = result.assessment.capabilities[0]!.detection.evidenceIds.map((i) => ev.get(i)?.name ?? '');
    expect(names.some((n) => /Incident Management Workflow/.test(n))).toBe(false);
  });
});

describe('reference confidence', () => {
  it('reports how much of the design rests on verified reference facts, and lists extensions', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { snapshotFromXml } = await import('@snjsm/collector');
    const { analyse, referenceConfidence, renderReport } = await import('@snjsm/analyser');
    const xml = readFileSync(join(__dirname, '../../collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
    const res = analyse(snapshotFromXml([{ name: 'e.xml', xml }]), { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' });
    const rc = referenceConfidence(res.blueprint);
    expect(rc.deprecated).toBe(0);
    expect(rc.verified).toBeGreaterThan(0);
    expect(rc.verified + rc.unverified + rc.deprecated).toBe(rc.artifacts.length);
    // Extensions are not counted as reference reliance.
    const extNames = new Set(res.blueprint.design.filter((d) => d.origin === 'extension').map((d) => d.name));
    expect(rc.artifacts.flatMap((a) => a.elements).some((n) => extNames.has(n) && !res.blueprint.design.some((d) => d.name === n && d.origin !== 'extension'))).toBe(false);
    expect(rc.artifacts.find((a) => a.id === 'atl.assets.itam.object-type.hardware-models')).toMatchObject({ status: 'verified' });
    const md = renderReport(res);
    expect(md).toMatch(/Reference confidence/);
    expect(md).toMatch(/Extensions and why/);
    expect(md).toContain('Person');
  });

  it('flags a design that relies on a deprecated reference', async () => {
    const { referenceConfidence } = await import('@snjsm/analyser');
    const bp = { design: [{ id: 'x', name: 'Old location', type: 'assets-object-type', origin: 'reference', referenceId: 'atl.assets.itam.object-type.location' }] } as never;
    expect(referenceConfidence(bp)).toMatchObject({ deprecated: 1, artifacts: [{ status: 'deprecated', elements: ['Old location'] }] });
  });
});

describe('UI scripts', () => {
  it('records global UI scripts as scripted evidence (no JSM equivalent, so each is a behaviour to re-home)', () => {
    const base = hardwareSnapshot();
    const records = [...base.records, rec('sys_ui_script', 900, { name: 'x_acme.formHelpers', global: 'true', active: 'true', ui_type: '10', script: "function hideIt() { g_form.setDisplay('u_cost', false); }" })];
    const ev = analyse({ ...base, records, stats: tableStats(records) }, { customer: 'Synthetic Co', now: '2026-01-01T00:00:00Z' }).blueprint.evidence.filter((e) => e.kind === 'ui-script');
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ name: 'x_acme.formHelpers', attributes: { global: true } });
    expect(ev[0]!.provenance[0]).toMatchObject({ table: 'sys_ui_script' });
  });
});
