import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFromXml } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import { HANDLERS } from '@snjsm/builder';
import { EvidenceKind } from '@snjsm/model';
import { JSM_CATEGORIES, SN_CATEGORIES, jsmGaps, snInventory, snItems } from '../src/views';

const xml = readFileSync(join(__dirname, '../../../packages/collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
const bp = analyse(snapshotFromXml([{ name: 'enterprise.xml', xml }]), { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;

const once = (cats: { kinds: readonly string[] }[], all: string[]) => {
  const seen = cats.flatMap((c) => c.kinds);
  expect([...seen].sort()).toEqual([...all].sort());
  expect(new Set(seen).size).toBe(seen.length);
};

describe('ServiceNow components view', () => {
  it('puts every evidence kind in exactly one category', () => once(SN_CATEGORIES, EvidenceKind.options));

  it('lists every analysed component once, by category, without scripts or raw attributes', () => {
    const inv = snInventory(bp);
    expect(inv.totals.components).toBe(bp.evidence.length);
    expect(inv.categories.reduce((n, c) => n + c.count, 0)).toBe(bp.evidence.length);
    const get = (id: string) => inv.categories.find((c) => c.id === id)!;
    expect(get('business-rules').count).toBe(bp.evidence.filter((e) => e.kind === 'business-rule').length);
    expect(get('catalog').byKind['catalog-item']).toBe(200);
    expect(get('slas').count).toBeGreaterThan(0);
    expect(inv.sources[0]).toMatchObject({ kind: 'servicenow-xml' });
    expect(inv.totals.scripted).toBeGreaterThan(0);
  });

  it('pages and searches one category at a time, without scripts or raw attributes', () => {
    const p1 = snItems(bp, { category: 'variables', limit: 300 });
    expect(p1).toMatchObject({ total: 800, offset: 0 });
    expect(p1.items).toHaveLength(300);
    const p3 = snItems(bp, { category: 'variables', offset: 600, limit: 300 });
    expect(p3.items).toHaveLength(200);
    expect(new Set([...p1.items, ...p3.items].map((i) => i.id)).size).toBe(500);
    expect(snItems(bp, { category: 'variables', limit: 10_000 }).items).toHaveLength(500);
    const br = snItems(bp, { category: 'business-rules' });
    expect(JSON.stringify(br)).not.toContain('"script"');
    const name = br.items[0]!.name;
    expect(snItems(bp, { category: 'business-rules', query: name.toUpperCase() }).items.map((i) => i.name)).toContain(name);
    expect(snItems(bp, { category: 'business-rules', customOnly: true }).items.every((i) => i.custom)).toBe(true);
    expect(() => snItems(bp, { category: 'nope' })).toThrow(/unknown category/);
  });
});

describe('JSM build & gaps view', () => {
  it('puts every design element type in exactly one category', () => once(JSM_CATEGORIES, Object.keys(HANDLERS)));

  it('shows every design element with its work, build method, outcomes and the ServiceNow components it replaces', () => {
    const g = jsmGaps(bp);
    expect(g.totals.elements).toBe(bp.design.length);
    expect(g.totals.standard + g.totals.configure + g.totals.custom).toBe(bp.design.length);
    expect(g.totals.automated + g.totals.partlyGuided + g.totals.guided).toBe(bp.design.length);
    const items = g.categories.flatMap((c) => c.items);
    expect(items.some((i) => i.replaces.count > 0)).toBe(true);
    for (const i of items) {
      expect(i.replaces.sample.length).toBeLessThanOrEqual(8);
      if (i.origin === 'extension') expect(i.work).toBe('Build custom');
    }
    expect(g.categories.find((c) => c.id === 'assets')!.count).toBe(bp.design.filter((d) => d.type.startsWith('assets-')).length);
    expect(g.capabilities.length).toBe(bp.capabilities.length);
    expect(g.totals.gaps).toBe(bp.capabilities.filter((c) => c.status !== 'out-of-scope').reduce((n, c) => n + (c.fit?.gaps.length ?? 0), 0));
  });

  it('flags in-scope outcomes that no design element delivers', () => {
    const extra = { ...bp.outcomes[0]!, id: 'o.orphan', statement: 'Something signed off that nothing builds yet', status: 'confirmed' as const };
    const g = jsmGaps({ ...bp, outcomes: [...bp.outcomes, extra, { ...extra, id: 'o.rejected', status: 'rejected' as const }] });
    expect(g.outcomesWithoutElement.map((o) => o.id)).toContain('o.orphan');
    expect(g.outcomesWithoutElement.map((o) => o.id)).not.toContain('o.rejected');
  });
});

describe('live collection keeps the analysis', () => {
  it('finds the same customer fields and tables from a narrowed dictionary pull as from the full XML', async () => {
    const { FakeServiceNow, ClientCredentialsProvider, ServiceNowClient, collectLive } = await import('@snjsm/collector');
    const base = snapshotFromXml([{ name: 'enterprise.xml', xml }]);
    // Realistic dictionary rows (name is the table): two customer fields and a base field the analysis does not use.
    const row = (n: number, table: string, element: string, label: string) => ({ table: 'sys_dictionary', sysId: n.toString(16).padStart(32, 'a'), fields: { name: table, element, column_label: label, internal_type: 'string', active: 'true', mandatory: 'false' }, display: {} });
    const snap = { ...base, records: [...base.records, row(1, 'incident', 'u_cost_center', 'Cost center'), row(2, 'cmdb_ci_server', 'u_rack', 'Rack'), row(3, 'cmdb_ci_server', 'cpu_count', 'CPU count')] };
    const sn = new FakeServiceNow(snap.records);
    const client = new ServiceNowClient({ instanceUrl: sn.instanceUrl, auth: new ClientCredentialsProvider(sn.instanceUrl, 'client-1', 'secret-1', sn.fetch), fetch: sn.fetch, maxRequestsPerSecond: 1000, sleep: async () => {} });
    const collected = await collectLive(client, { usageDays: 30 });
    expect(collected.records.some((r) => r.table === 'sys_dictionary' && r.fields['element'] === 'cpu_count')).toBe(false);
    const live = analyse(collected, { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;
    const full = analyse(snap, { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;
    const names = (b: typeof bp, kind: string) => b.evidence.filter((e) => e.kind === kind).map((e) => e.name).sort();
    expect(names(full, 'dictionary-field')).toEqual(['cmdb_ci_server.u_rack', 'incident.u_cost_center']);
    expect(names(live, 'dictionary-field')).toEqual(names(full, 'dictionary-field'));
    expect(names(live, 'table')).toEqual(names(full, 'table'));
  });
});
