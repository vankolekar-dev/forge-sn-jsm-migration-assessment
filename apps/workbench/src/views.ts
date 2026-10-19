import { handlerFor } from '@snjsm/builder';
import type { Blueprint, DesignElement, DesignElementType, Evidence, EvidenceKind, Origin } from '@snjsm/model';
import { getCapability } from '@snjsm/reference';

/**
 * Read-only views of a blueprint: what was found in ServiceNow, and what JSM needs to be built. Pure functions of the
 * blueprint (no site reads), so they work the same for uploaded and collected blueprints.
 */

interface Category<K extends string> { id: string; label: string; kinds: readonly K[] }

/** Every evidence kind belongs to exactly one category (enforced by a test). */
export const SN_CATEGORIES: Category<EvidenceKind>[] = [
  { id: 'cmdb', label: 'CMDB classes & schema', kinds: ['ci-class', 'ci-attribute', 'ci-relationship-type', 'ci-relationship-stat', 'identification-rule', 'asset-class', 'hardware-model'] },
  { id: 'services', label: 'Services & applications', kinds: ['service', 'service-offering', 'business-application'] },
  { id: 'teams', label: 'Groups, roles & user criteria', kinds: ['group', 'role', 'user-criteria'] },
  { id: 'flows', label: 'Flows & workflows', kinds: ['flow', 'subflow', 'flow-step', 'legacy-workflow'] },
  { id: 'business-rules', label: 'Business rules', kinds: ['business-rule'] },
  { id: 'client-scripts', label: 'Client scripts, UI policies & UI actions', kinds: ['client-script', 'ui-policy', 'ui-action'] },
  { id: 'ui-scripts', label: 'UI scripts', kinds: ['ui-script'] },
  { id: 'server-scripts', label: 'Script includes, jobs, events & transforms', kinds: ['script-include', 'scheduled-job', 'event', 'transform-map'] },
  { id: 'slas', label: 'SLAs & schedules', kinds: ['sla-definition', 'schedule'] },
  { id: 'routing', label: 'Assignment & approval rules', kinds: ['assignment-rule', 'approval-rule'] },
  { id: 'fields', label: 'Custom fields, tables & choices', kinds: ['dictionary-field', 'table', 'choice-list'] },
  { id: 'catalog', label: 'Catalog items & record producers', kinds: ['catalog-item', 'record-producer', 'order-guide', 'catalog-category'] },
  { id: 'variables', label: 'Catalog variables', kinds: ['catalog-variable', 'variable-set'] },
  { id: 'notifications', label: 'Notifications & inbound email', kinds: ['notification', 'inbound-email-action'] },
  { id: 'security', label: 'Access controls (ACLs)', kinds: ['acl'] },
  { id: 'portal', label: 'Portal, knowledge & virtual agent', kinds: ['portal', 'portal-widget', 'knowledge-base', 'virtual-agent-topic'] },
  { id: 'reports', label: 'Reports & dashboards', kinds: ['report', 'dashboard'] },
  { id: 'integrations', label: 'Integrations, MID servers, apps & plugins', kinds: ['integration', 'mid-server', 'scoped-app', 'plugin'] },
  { id: 'documents', label: 'Process documents & other', kinds: ['process-step', 'process-diagram', 'screenshot-region', 'document-section', 'other'] },
];

/** Every design element type belongs to exactly one category (enforced by a test). */
export const JSM_CATEGORIES: Category<DesignElementType>[] = [
  { id: 'spaces', label: 'Service spaces & portal groups', kinds: ['space', 'portal-group'] },
  { id: 'request-types', label: 'Request types', kinds: ['request-type'] },
  { id: 'forms', label: 'Forms', kinds: ['form'] },
  { id: 'fields', label: 'Custom fields', kinds: ['field'] },
  { id: 'workflows', label: 'Workflows & work types', kinds: ['workflow', 'work-type'] },
  { id: 'queues', label: 'Queues', kinds: ['queue'] },
  { id: 'slas', label: 'SLAs & calendars', kinds: ['sla', 'calendar'] },
  { id: 'automations', label: 'Automations', kinds: ['automation'] },
  { id: 'notifications', label: 'Notifications', kinds: ['notification'] },
  { id: 'teams', label: 'Teams', kinds: ['team'] },
  { id: 'assets', label: 'Assets schemas, object types & attributes', kinds: ['assets-schema', 'assets-object-type', 'assets-attribute', 'assets-status-type', 'assets-reference-type'] },
];

export interface SnItem {
  id: string; kind: EvidenceKind; name: string; domain?: string; table?: string;
  /** What it does, as analysed. */
  intent?: string; custom?: boolean; active?: boolean;
  usage?: { count: number; periodDays?: number }; fillRate?: number; risk?: string;
}

export interface SnInventory {
  blueprintId: string; customer: string;
  sources: { kind: string; name: string; instance?: string; release?: string; addedAt: string }[];
  totals: { components: number; custom: number; inactive: number; scripted: number };
  categories: { id: string; label: string; count: number; custom: number; inactive: number; byKind: Record<string, number> }[];
}

export interface SnItemsPage { category: string; total: number; offset: number; items: SnItem[] }

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function snItem(e: Evidence): SnItem {
  const risk = str(e.attributes['risk']);
  return {
    id: e.id, kind: e.kind, name: e.name, domain: e.domain, table: e.provenance[0]?.table,
    intent: e.intent ?? e.summary, custom: e.custom, active: e.usage?.active,
    usage: e.usage?.count !== undefined ? { count: e.usage.count, periodDays: e.usage.periodDays } : undefined,
    fillRate: e.usage?.fillRate, risk: risk && risk !== 'none' ? risk : undefined,
  };
}

const itemsOf = (bp: Blueprint, c: Category<EvidenceKind>) =>
  bp.evidence.filter((e) => c.kinds.includes(e.kind)).map(snItem).sort((a, b) => a.name.localeCompare(b.name));

/** Category summaries only; items are fetched per category (large instances have tens of thousands). */
export function snInventory(bp: Blueprint): SnInventory {
  const categories = SN_CATEGORIES.map((c) => {
    const items = itemsOf(bp, c);
    const byKind: Record<string, number> = {};
    for (const i of items) byKind[i.kind] = (byKind[i.kind] ?? 0) + 1;
    return { summary: { id: c.id, label: c.label, count: items.length, custom: items.filter((i) => i.custom).length, inactive: items.filter((i) => i.active === false).length, byKind }, items };
  });
  const all = categories.flatMap((c) => c.items);
  return {
    blueprintId: bp.id, customer: bp.customer.name,
    sources: bp.sources.map((s) => ({ kind: s.kind, name: s.name, instance: s.instance, release: s.release, addedAt: s.addedAt })),
    totals: { components: all.length, custom: all.filter((i) => i.custom).length, inactive: all.filter((i) => i.active === false).length, scripted: all.filter((i) => i.risk).length },
    categories: categories.map((c) => c.summary),
  };
}

/** One page of a category's items, optionally filtered by name, intent, table or kind; customer-built first if asked. */
export function snItems(bp: Blueprint, opts: { category: string; query?: string; customOnly?: boolean; offset?: number; limit?: number }): SnItemsPage {
  const c = SN_CATEGORIES.find((x) => x.id === opts.category);
  if (!c) throw new Error(`unknown category ${opts.category}`);
  const q = opts.query?.trim().toLowerCase();
  const match = (i: SnItem) => !q || [i.name, i.intent, i.table, i.kind, i.domain].some((v) => v?.toLowerCase().includes(q));
  const all = itemsOf(bp, c).filter((i) => match(i) && (!opts.customOnly || i.custom));
  const offset = Math.max(0, opts.offset ?? 0);
  return { category: c.id, total: all.length, offset, items: all.slice(offset, offset + Math.min(opts.limit ?? 200, 500)) };
}

/** What has to happen to get an element into JSM, from the blueprint alone. */
export const WORK: Record<Origin, { label: string; detail: string }> = {
  reference: { label: 'Standard', detail: 'Use as Atlassian ships it' },
  'reference-configured': { label: 'Configure', detail: 'Standard element with customer settings' },
  extension: { label: 'Build custom', detail: 'Not in the Atlassian standard; needs a justification' },
};

export type BuildMethod = 'automated' | 'automated + guided' | 'guided';

export interface JsmItem {
  id: string; type: DesignElementType; name: string; origin: Origin; work: string;
  /** How the builder delivers it: API create, API create plus guided steps for what the API cannot do, or guided only. */
  method: BuildMethod; guidedAspects: string[];
  justification?: string; notes?: string;
  outcomes: { id: string; statement: string; status: string }[];
  dependsOn: { id: string; name: string }[];
  /** ServiceNow components this element replaces, via its outcomes and justification. */
  replaces: { count: number; sample: { id: string; kind: string; name: string }[] };
}

export interface Gap { capability: string; description: string; resolution: string; outcome?: string; evidence: string[] }

export interface JsmGaps {
  blueprintId: string; customer: string;
  totals: { elements: number; standard: number; configure: number; custom: number; automated: number; partlyGuided: number; guided: number; gaps: number; outcomesWithoutElement: number };
  categories: { id: string; label: string; count: number; byOrigin: Record<Origin, number>; byMethod: Record<BuildMethod, number>; items: JsmItem[] }[];
  capabilities: { id: string; name: string; status: string; score?: number; counts?: { reference: number; configured: number; extension: number } }[];
  gaps: Gap[];
  /** In-scope outcomes no design element delivers: something the customer signs off that nothing builds. */
  outcomesWithoutElement: { id: string; statement: string; status: string }[];
}

const SAMPLE = 8;

function methodOf(el: DesignElement): { method: BuildMethod; guidedAspects: string[] } {
  const h = handlerFor(el.type);
  if (!h.canCreate(el)) return { method: 'guided', guidedAspects: [] };
  const guidedAspects = h.manualAspects?.(el) ?? [];
  return { method: guidedAspects.length ? 'automated + guided' : 'automated', guidedAspects };
}

export function jsmGaps(bp: Blueprint): JsmGaps {
  const outcomes = new Map(bp.outcomes.map((o) => [o.id, o]));
  const evidence = new Map(bp.evidence.map((e) => [e.id, e]));
  const design = new Map(bp.design.map((d) => [d.id, d]));
  const live = (status: string) => status !== 'rejected' && status !== 'deferred';

  const item = (el: DesignElement): JsmItem => {
    const outs = el.deliversOutcomeIds.map((id) => outcomes.get(id)).filter((o): o is NonNullable<typeof o> => Boolean(o));
    const evIds = [...new Set([...outs.flatMap((o) => o.evidenceIds), ...(el.justification?.evidenceIds ?? [])])].filter((id) => evidence.has(id));
    return {
      id: el.id, type: el.type, name: el.name, origin: el.origin, work: WORK[el.origin].label, ...methodOf(el),
      justification: el.justification?.reason, notes: el.notes,
      outcomes: outs.map((o) => ({ id: o.id, statement: o.statement, status: o.status })),
      dependsOn: el.dependsOn.map((id) => ({ id, name: design.get(id)?.name ?? id })),
      replaces: { count: evIds.length, sample: evIds.slice(0, SAMPLE).map((id) => { const e = evidence.get(id)!; return { id, kind: e.kind, name: e.name }; }) },
    };
  };

  const categories = JSM_CATEGORIES.map((c) => {
    const items = bp.design.filter((d) => c.kinds.includes(d.type)).map(item);
    const byOrigin = { reference: 0, 'reference-configured': 0, extension: 0 } as Record<Origin, number>;
    const byMethod = { automated: 0, 'automated + guided': 0, guided: 0 } as Record<BuildMethod, number>;
    for (const i of items) { byOrigin[i.origin]++; byMethod[i.method]++; }
    return { id: c.id, label: c.label, count: items.length, byOrigin, byMethod, items };
  });

  const capName = (id: string) => getCapability(id)?.name ?? id;
  const gaps: Gap[] = bp.capabilities.filter((c) => c.status !== 'out-of-scope').flatMap((c) => (c.fit?.gaps ?? []).map((g) => ({
    capability: capName(c.capabilityId), description: g.description, resolution: g.resolution,
    outcome: g.outcomeId ? outcomes.get(g.outcomeId)?.statement : undefined,
    evidence: g.evidenceIds.map((id) => evidence.get(id)?.name).filter((n): n is string => Boolean(n)),
  })));
  const delivered = new Set(bp.design.flatMap((d) => d.deliversOutcomeIds));
  const outcomesWithoutElement = bp.outcomes.filter((o) => live(o.status) && !delivered.has(o.id)).map((o) => ({ id: o.id, statement: o.statement, status: o.status }));

  const all = categories.flatMap((c) => c.items);
  return {
    blueprintId: bp.id, customer: bp.customer.name,
    totals: {
      elements: all.length,
      standard: all.filter((i) => i.origin === 'reference').length,
      configure: all.filter((i) => i.origin === 'reference-configured').length,
      custom: all.filter((i) => i.origin === 'extension').length,
      automated: all.filter((i) => i.method === 'automated').length,
      partlyGuided: all.filter((i) => i.method === 'automated + guided').length,
      guided: all.filter((i) => i.method === 'guided').length,
      gaps: gaps.length, outcomesWithoutElement: outcomesWithoutElement.length,
    },
    categories,
    capabilities: bp.capabilities.map((c) => ({ id: c.capabilityId, name: capName(c.capabilityId), status: c.status, score: c.fit?.score, counts: c.fit?.counts })),
    gaps, outcomesWithoutElement,
  };
}
