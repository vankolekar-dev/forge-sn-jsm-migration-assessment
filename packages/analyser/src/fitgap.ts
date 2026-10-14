import type { Capability, CoverageStatus, DesignElement, Evidence, FitGap, Outcome, OutcomeCategory } from '@snjsm/model';
import { buildabilityOf } from '@snjsm/reference';
import { PATTERN_APPROACH } from './assess/areas';

type Resolution = FitGap['gaps'][number]['resolution'];

/**
 * Which outcome category covers each ServiceNow script pattern. A pattern on capability evidence with no outcome
 * of that category is a gap: behaviour that exists today but that the reference design does not deliver yet.
 */
const PATTERN_COVER: Record<string, { categories: OutcomeCategory[]; resolution: Resolution }> = {
  validation: { categories: ['intake'], resolution: 'extension' },
  abort: { categories: ['intake', 'approval'], resolution: 'extension' },
  'field-default': { categories: ['intake'], resolution: 'extension' },
  mandatory: { categories: ['intake'], resolution: 'extension' },
  visibility: { categories: ['intake'], resolution: 'extension' },
  'read-only': { categories: ['intake', 'security'], resolution: 'extension' },
  message: { categories: ['intake'], resolution: 'extension' },
  'choice-manipulation': { categories: ['intake'], resolution: 'extension' },
  approval: { categories: ['approval'], resolution: 'extension' },
  'auto-assignment': { categories: ['routing'], resolution: 'extension' },
  notification: { categories: ['communication'], resolution: 'extension' },
  integration: { categories: ['integration'], resolution: 'integration' },
  'cascade-update': { categories: ['fulfilment'], resolution: 'extension' },
  'record-creation': { categories: ['fulfilment'], resolution: 'extension' },
  'record-deletion': { categories: ['data'], resolution: 'process-change' },
  calculation: { categories: ['fulfilment', 'data'], resolution: 'extension' },
  'data-lookup': { categories: ['routing', 'data'], resolution: 'extension' },
  'access-check': { categories: ['security', 'compliance'], resolution: 'extension' },
  scheduling: { categories: ['service-level', 'fulfilment'], resolution: 'extension' },
};

/** Flow / workflow step kinds and the outcome category that covers them. */
const STEP_COVER: Record<string, { categories: OutcomeCategory[]; resolution: Resolution; what: string }> = {
  task: { categories: ['fulfilment'], resolution: 'extension', what: 'creates fulfilment tasks (multi-team fulfilment)' },
  integration: { categories: ['integration'], resolution: 'integration', what: 'calls external systems' },
  create: { categories: ['fulfilment'], resolution: 'extension', what: 'creates other records' },
  wait: { categories: ['fulfilment', 'service-level'], resolution: 'extension', what: 'waits for conditions or timers' },
  script: { categories: [], resolution: 'unresolved', what: 'runs custom script steps' },
};

const attr = <T = unknown>(e: Evidence, k: string) => e.attributes[k] as T | undefined;

export interface CapabilityGap { description: string; resolution: Resolution; evidenceIds: string[]; approach?: string; outcomeId?: string }

export function gapsFor(cap: Capability, outcomes: Outcome[], evidence: Evidence[]): CapabilityGap[] {
  const covered = new Set(outcomes.filter((o) => o.status !== 'rejected').map((o) => o.category));
  const gaps = new Map<string, CapabilityGap>();
  const add = (key: string, g: Omit<CapabilityGap, 'evidenceIds'>, id: string) => {
    const cur = gaps.get(key) ?? { ...g, evidenceIds: [] };
    if (!cur.evidenceIds.includes(id)) cur.evidenceIds.push(id);
    gaps.set(key, cur);
  };
  for (const e of evidence) {
    if (e.usage?.active === false) continue;
    for (const p of attr<{ patterns: string[] }>(e, 'script')?.patterns ?? []) {
      const c = PATTERN_COVER[p];
      if (!c || c.categories.some((x) => covered.has(x))) continue;
      add(`pattern:${p}`, { description: `Scripts implement "${p}" behaviour that no ${cap.name} outcome covers`, resolution: c.resolution, approach: PATTERN_APPROACH[p] }, e.id);
    }
    for (const k of attr<string[]>(e, 'stepKinds') ?? []) {
      const c = STEP_COVER[k];
      if (!c || c.categories.some((x) => covered.has(x))) continue;
      add(`step:${k}`, { description: `Flows/workflows ${c.what}; no outcome covers it yet`, resolution: c.resolution }, e.id);
    }
    if (e.kind === 'catalog-variable' && attr(e, 'jsmFieldKind') === 'unsupported') add('unsupported-variables', { description: 'Questions with no native JSM field type (custom / UI page / multi-row variable sets)', resolution: 'extension', approach: 'JSM Forms (tables, sections, conditions); Forge only if truly needed', outcomeId: outcomes.find((o) => o.category === 'intake')?.id }, e.id);
    if (e.kind === 'order-guide') add('order-guide', { description: 'Order guides (multi-item bundles) have no JSM equivalent', resolution: 'extension', approach: 'One request type + automation creating linked work items', outcomeId: outcomes.find((o) => o.category === 'intake')?.id }, e.id);
    if ((attr<number>(e, 'recurringPrice') ?? 0) > 0) add('recurring-price', { description: 'Recurring charges on catalog items (no JSM cost model)', resolution: 'process-change', approach: 'Track cost on the Assets model; charge-back outside JSM' }, e.id);
    if (e.kind === 'integration') add(`integration:${attr(e, 'integrationType') ?? 'other'}`, { description: `${attr(e, 'integrationType') ?? 'Other'} integration touches this capability`, resolution: 'integration' }, e.id);
  }
  return [...gaps.values()].sort((a, b) => b.evidenceIds.length - a.evidenceIds.length);
}

export function fitGap(cap: Capability, design: DesignElement[], outcomes: Outcome[], evidence: Evidence[]): FitGap {
  const counts = { reference: 0, configured: 0, extension: 0 };
  for (const el of design) {
    if (el.origin === 'reference') counts.reference++;
    else if (el.origin === 'reference-configured') counts.configured++;
    else counts.extension++;
  }
  const gaps = gapsFor(cap, outcomes, evidence);
  // Every unresolved behaviour will need at least one extension: count gaps as prospective extensions in the score.
  const prospective = gaps.filter((g) => g.resolution !== 'out-of-scope' && g.resolution !== 'process-change').length;
  const total = counts.reference + counts.configured + counts.extension + prospective;
  const score = total ? Math.round(((counts.reference + 0.75 * counts.configured) / total) * 100) : 100;
  return { score, counts, gaps: gaps.map((g) => ({ description: g.approach ? `${g.description}. Suggested: ${g.approach}` : g.description, resolution: g.resolution, evidenceIds: g.evidenceIds.slice(0, 25), ...(g.outcomeId ? { outcomeId: g.outcomeId } : {}) })) };
}

export interface Buildability {
  byStatus: Record<CoverageStatus, number>;
  manual: { elementId: string; type: string; name: string; status: CoverageStatus; aspects: string[] }[];
  /** Share of elements the engine can build end-to-end via API. */
  automatedPct: number;
}

export function buildability(design: DesignElement[]): Buildability {
  const byStatus: Record<CoverageStatus, number> = { api: 0, partial: 0, unknown: 0, 'ui-only': 0 };
  const manual: Buildability['manual'] = [];
  for (const el of design) {
    const b = buildabilityOf(el);
    byStatus[b.status]++;
    if (b.status !== 'api') manual.push({ elementId: el.id, type: el.type, name: el.name, status: b.status, aspects: b.entries.filter((e) => e.status !== 'api').map((e) => e.aspect ?? e.operation) });
  }
  return { byStatus, manual, automatedPct: design.length ? Math.round((byStatus.api / design.length) * 100) : 0 };
}
