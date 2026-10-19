import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { INDEX_FIELDS, INDEXED_TABLES, snapshotFromXml, STREAMED_TABLES, type Aggregate, type Snapshot, type SnRecord } from '@snjsm/collector';
import { analyse, extractPage, mergeExtractions, RecordStore, streamContext, stubOf } from '@snjsm/analyser';

const id = (n: number) => n.toString(16).padStart(32, '0');
const rec = (table: string, n: number, fields: Record<string, string>): SnRecord => ({ table, sysId: id(n), fields });
const streamed = (r: SnRecord) => STREAMED_TABLES.includes(r.table);
const now = '2026-01-01T00:00:00.000Z';

/** As the workbench does it: context tables + name indexes first, then streamed pages, then analyse stubs + evidence. */
function analyseStreamed(snap: Snapshot, pageSize: number) {
  const index = snap.records.filter((r) => INDEXED_TABLES.includes(r.table)).map((r) => ({ ...r, fields: Object.fromEntries(INDEX_FIELDS.filter((f) => r.fields[f] !== undefined).map((f) => [f, r.fields[f]!])) }));
  const ctx = streamContext([...snap.records.filter((r) => !streamed(r)), ...index], snap.aggregates, { instance: snap.source.instance!, capturedAt: snap.source.capturedAt, usageDays: snap.usageDays ?? 365 });
  const pages: SnRecord[][] = [];
  for (const t of STREAMED_TABLES) {
    const rs = snap.records.filter((r) => r.table === t);
    for (let i = 0; i < rs.length; i += pageSize) pages.push(rs.slice(i, i + pageSize));
  }
  const pre = mergeExtractions(pages.map((p) => extractPage(p, ctx)));
  return analyse({ ...snap, records: snap.records.map((r) => (streamed(r) ? stubOf(r) : r)) }, { customer: 'Co', now }, pre);
}

const live = (s: Snapshot, aggregates: Aggregate[] = s.aggregates): Snapshot => ({ ...s, aggregates, source: { kind: 'servicenow-live', name: 'acme.service-now.com', instance: 'acme.service-now.com', capturedAt: now } });

function scripted(): Snapshot {
  const records = [
    rec('sys_user_group', 1, { name: 'Hardware Desk', active: 'true' }),
    rec('sc_cat_item', 2, { name: 'Laptop', group: id(1), price: '1800', active: 'true' }),
    rec('sys_script_include', 3, { name: 'CostUtils', api_name: 'global.CostUtils', script: 'var CostUtils = Class.create(); CostUtils.prototype = { over: function(c) { return c.price > 2500; } };', sys_created_by: 'admin' }),
    rec('sys_script_include', 4, { name: 'Helper', api_name: 'global.Helper', script: 'var Helper = Class.create(); Helper.prototype = { x: function() { return new CostUtils().over(current); } };', sys_created_by: 'admin' }),
    rec('sys_script', 5, { name: 'Approve expensive', collection: 'sc_req_item', when: 'before', action_insert: 'true', script: "if (new CostUtils().over(current)) { current.approval = 'requested'; gs.eventQueue('acme.costly', current); }", sys_created_by: 'admin', active: 'true' }),
    rec('sysevent_register', 6, { event_name: 'acme.costly', table: 'sc_req_item' }),
    rec('sysevent_email_action', 7, { name: 'Costly request', event_name: 'acme.costly', collection: 'sc_req_item', recipient_fields: 'requested_for', active: 'true' }),
    rec('sys_security_acl', 8, { name: 'sc_req_item.price', operation: 'write', script: 'answer = gs.hasRole("itil");', active: 'true' }),
    rec('sys_ui_policy', 9, { short_description: 'Show reason', table: 'sc_req_item', conditions: 'price>1000', active: 'true' }),
    rec('sys_ui_policy_action', 10, { ui_policy: id(9), field: 'reason', visible: 'true' }),
    rec('contract_sla', 11, { name: 'P1 resolve', collection: 'incident', duration: '1970-01-01 04:00:00', target: 'resolution', active: 'true' }),
    rec('sys_report', 12, { title: 'Requests by item', table: 'sc_req_item', type: 'bar', field: 'cat_item' }),
  ];
  const usage: Aggregate[] = [{ id: 'usage.req-item-by-cat-item', table: 'sc_req_item', groupBy: ['cat_item'], purpose: 'x', rows: [{ group: { cat_item: id(2) }, count: 42 }] }];
  return live({ source: { kind: 'servicenow-live', name: '', capturedAt: now }, records, aggregates: [], warnings: [], stats: {}, usageDays: 90 }, usage);
}

describe('streamed collection analysis', () => {
  afterEach(() => vi.restoreAllMocks());

  it('gives the same result as analysing the full records (enterprise fixture, several page sizes)', () => {
    const xml = readFileSync(join(__dirname, '../../collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
    const snap = live(snapshotFromXml([{ name: 'e.xml', xml }]));
    expect(snap.records.filter(streamed).length).toBeGreaterThan(900);
    const batch = analyse(snap, { customer: 'Co', now });
    for (const size of [1, 7, 100]) expect(analyseStreamed(snap, size)).toEqual(batch);
  });

  it('gives the same result with script include calls, events, usage counts and cost thresholds', () => {
    const snap = scripted();
    const batch = analyse(snap, { customer: 'Co', now });
    const br = batch.blueprint.evidence.find((e) => e.name === 'Approve expensive')!;
    expect(br.relations.map((r) => r.targetId)).toEqual(expect.arrayContaining([expect.stringContaining('sys_script_include'), expect.stringContaining('sysevent_register')]));
    expect(analyseStreamed(snap, 1)).toEqual(batch);
  });

  it('keeps small stubs: names, and text only where a cost threshold is', () => {
    const [inc] = scripted().records.filter((r) => r.sysId === id(3));
    expect(stubOf(inc!).fields).toEqual({ name: 'CostUtils', api_name: 'global.CostUtils', script: inc!.fields['script'] });
    const acl = scripted().records.find((r) => r.table === 'sys_security_acl')!;
    expect(stubOf(acl).fields).toEqual({ name: 'sc_req_item.price' });
  });

  it('nothing else looks streamed records up (only script includes, by name)', () => {
    const xml = readFileSync(join(__dirname, '../../collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
    const reads: string[] = [];
    const isStreamed = (t: string) => STREAMED_TABLES.some((s) => (t.endsWith('*') ? s.startsWith(t.slice(0, -1)) : s === t));
    const childrenOf = RecordStore.prototype.childrenOf;
    const ref = RecordStore.prototype.ref;
    vi.spyOn(RecordStore.prototype, 'childrenOf').mockImplementation(function (this: RecordStore, t, f, p) { if (isStreamed(t)) reads.push(`childrenOf ${t}`); return childrenOf.call(this, t, f, p); });
    vi.spyOn(RecordStore.prototype, 'ref').mockImplementation(function (this: RecordStore, r, f, targets) { for (const t of targets ?? ['*']) if (isStreamed(t)) reads.push(`ref ${t}`); return ref.call(this, r, f, targets); });
    analyse(snapshotFromXml([{ name: 'e.xml', xml }]), { customer: 'Co', now });
    analyse(scripted(), { customer: 'Co', now });
    expect(reads).toEqual([]);
  });
});
