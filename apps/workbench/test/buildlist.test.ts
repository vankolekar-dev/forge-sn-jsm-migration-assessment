import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { snapshotFromXml } from '@snjsm/collector';
import { analyse } from '@snjsm/analyser';
import type { Blueprint } from '@snjsm/model';
import { MAX_BUILD_LIST_PAGE, accountedFor, buildList, buildListItems, buildListMarkdown } from '@snjsm/reference';

const xml = readFileSync(join(__dirname, '../../../packages/collector/test/fixtures/enterprise-update-set.xml'), 'utf8');
const bp = analyse(snapshotFromXml([{ name: 'enterprise.xml', xml }]), { customer: 'Fixture Co', now: '2026-01-01T00:00:00Z' }).blueprint;
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0);

describe('build list for everything ServiceNow has', () => {
  it('accounts for every component exactly once and labels itself as unreviewed', () => {
    const l = buildList(bp);
    const t = l.totals;
    expect(l.status).toBe('proposed, not reviewed');
    expect(t.covered).toBeGreaterThan(0);
    expect(t.covered + t.outOfScope + t.inactive + t.proposed).toBe(bp.evidence.length);
    expect(sum(l.groups.map((g) => g.count))).toBe(t.proposed);
    expect(sum(Object.values(t.byReadiness))).toBe(t.proposed);
    expect(new Set(l.groups.map((g) => g.id)).size).toBe(l.groups.length);
  });

  it('never proposes what the blueprint already covers', () => {
    const { covered } = accountedFor(bp);
    const all = buildListItems(bp, { limit: MAX_BUILD_LIST_PAGE, offset: 0 });
    const ids: string[] = [];
    for (let offset = 0; offset < all.total; offset += MAX_BUILD_LIST_PAGE) ids.push(...buildListItems(bp, { offset, limit: MAX_BUILD_LIST_PAGE }).items.map((i) => i.id));
    expect(ids.length).toBe(all.total);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => covered.has(id))).toEqual([]);
    for (const o of bp.outcomes) for (const id of o.evidenceIds) expect(ids).not.toContain(id);
  });

  it('counts evidence of out-of-scope capabilities separately instead of proposing it', () => {
    const cap = bp.capabilities[0]!;
    const own = new Set([...(cap.detection?.evidenceIds ?? []), ...(cap.fit?.gaps ?? []).flatMap((g) => g.evidenceIds)]);
    const elsewhere = new Set([...bp.outcomes.flatMap((o) => o.evidenceIds), ...bp.design.flatMap((d) => d.justification?.evidenceIds ?? [])]);
    const out: Blueprint = { ...bp, capabilities: bp.capabilities.map((c) => (c === cap ? { ...c, status: 'out-of-scope' as const } : c)) };
    const l = buildList(out);
    expect(l.totals.outOfScope).toBe([...own].filter((id) => !elsewhere.has(id)).length);
    expect(l.totals.outOfScope).toBeGreaterThan(0);
    expect(l.totals.covered + l.totals.outOfScope + l.totals.inactive + l.totals.proposed).toBe(bp.evidence.length);
  });

  it('leaves inactive components out unless asked', () => {
    const victim = buildListItems(bp, { limit: 3 }).items.map((i) => i.id);
    const withInactive: Blueprint = { ...bp, evidence: bp.evidence.map((e) => (victim.includes(e.id) ? { ...e, usage: { ...e.usage, active: false } } : e)) };
    expect(buildList(withInactive).totals.inactive).toBe(buildList(bp).totals.inactive + 3);
    expect(buildList(withInactive, { includeInactive: true }).totals.proposed).toBe(buildList(bp, { includeInactive: true }).totals.proposed);
    expect(buildListItems(withInactive).items.map((i) => i.id)).not.toContain(victim[0]);
  });

  it('proposes the mapped JSM element with coverage-based readiness', () => {
    const l = buildList(bp);
    const g = (id: string) => l.groups.find((x) => x.id === id);
    expect(g('request-type')).toMatchObject({ target: 'request-type', readiness: 'partial' });
    expect(g('sla')).toMatchObject({ target: 'sla', readiness: 'ui-only' });
    expect(g('no-equivalent')?.byKind['script-include']).toBeGreaterThan(0);
    const br = buildListItems(bp, { group: 'automation', query: 'business-rule', limit: 1 }).items[0]!;
    expect(br).toMatchObject({ kind: 'business-rule', target: 'automation', redesign: true });
    expect(br).not.toHaveProperty('attributes');
  });

  it('filters and pages', () => {
    const forms = buildListItems(bp, { group: 'form', limit: 10 });
    expect(forms.items).toHaveLength(10);
    expect(forms.items.every((i) => i.target === 'form')).toBe(true);
    const next = buildListItems(bp, { group: 'form', limit: 10, offset: 10 });
    expect(next.offset).toBe(10);
    expect(next.items[0]!.id).not.toBe(forms.items[0]!.id);
    expect(buildListItems(bp, { limit: 10_000 }).items.length).toBeLessThanOrEqual(MAX_BUILD_LIST_PAGE);
    expect(buildListItems(bp, { readiness: ['ui-only'] }).items.every((i) => i.readiness === 'ui-only')).toBe(true);
    expect(buildListItems(bp, { customOnly: true }).items.every((i) => i.custom)).toBe(true);
    expect(buildListItems(bp, { query: 'zzz-no-such-thing' }).total).toBe(0);
    const ordered = buildListItems(bp, { limit: MAX_BUILD_LIST_PAGE }).items;
    const firstPlain = ordered.findIndex((i) => !i.custom);
    if (firstPlain >= 0) expect(ordered.slice(firstPlain).some((i) => i.custom)).toBe(false);
  });

  it('renders markdown an agent can read, with the not-reviewed warning', () => {
    const md = buildListMarkdown(bp, { perGroup: 2 });
    expect(md).toContain('Proposed, not reviewed');
    expect(md).toContain('## Request types');
    expect(md).toMatch(/…and \d+ more\./);
    const only = buildListMarkdown(bp, { group: 'sla', perGroup: 1 });
    expect(only).toContain('## SLAs');
    expect(only).not.toContain('## Request types');
  });
});
