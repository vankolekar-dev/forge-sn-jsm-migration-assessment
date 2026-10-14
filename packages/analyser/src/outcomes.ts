import type { Capability, Confidence, DesignElement, Evidence, Outcome, OutcomeCategory, OutcomeTemplate, ParamValue, Provenance } from '@snjsm/model';
import type { CapabilityDetection } from './detect';
import { fmt, purposeOfParam, resolveCapabilityParams, type ParamResolution, type ResolverInput } from './params';
import type { RecordStore } from './store';

const PLACEHOLDER = /\{\{(\w+)\}\}/g;
const WHOLE = /^\{\{(\w+)\}\}$/;

/** Replace {{param}} in text with the display form of the value. Unknown placeholders are left as they are. */
export function fillText(text: string, values: Record<string, ParamValue>): string {
  return text.replace(PLACEHOLDER, (m, name: string) => (name in values ? fmt(values[name]!) : m));
}

/** Deep substitution. A string that is exactly "{{x}}" becomes the typed value (number, duration...). */
export function fillDeep<T>(v: T, values: Record<string, ParamValue>): T {
  if (typeof v === 'string') {
    const w = v.match(WHOLE);
    if (w && w[1]! in values) return values[w[1]!] as unknown as T;
    return fillText(v, values) as unknown as T;
  }
  if (Array.isArray(v)) return v.map((x) => fillDeep(x, values)) as unknown as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillDeep(x, values)])) as T;
  return v;
}

// ── Evidence per outcome category ─────────────────────────────────────────

const attr = <T = unknown>(e: Evidence, k: string) => e.attributes[k] as T | undefined;
const patterns = (e: Evidence) => attr<{ patterns: string[] }>(e, 'script')?.patterns ?? [];
const stepKinds = (e: Evidence) => attr<string[]>(e, 'stepKinds') ?? [];

/** Which capability evidence explains an outcome of each category. */
export const CATEGORY_EVIDENCE: Record<OutcomeCategory, (e: Evidence, core: Set<string>) => boolean> = {
  intake: (e, core) => core.has(e.id) || ['catalog-variable', 'variable-set', 'catalog-category', 'order-guide', 'ui-policy', 'client-script'].includes(e.kind),
  'self-service': (e) => ['portal', 'portal-widget', 'virtual-agent-topic', 'knowledge-base', 'user-criteria'].includes(e.kind),
  routing: (e) => ['assignment-rule', 'group'].includes(e.kind) || patterns(e).includes('auto-assignment') || stepKinds(e).includes('assign'),
  approval: (e) => e.kind === 'approval-rule' || (attr<number>(e, 'approvals') ?? 0) > 0 || patterns(e).includes('approval') || stepKinds(e).includes('approval'),
  fulfilment: (e) => ['flow', 'subflow', 'legacy-workflow'].includes(e.kind) && (stepKinds(e).includes('task') || stepKinds(e).includes('create')),
  'service-level': (e) => e.kind === 'sla-definition' || e.kind === 'schedule',
  communication: (e) => e.kind === 'notification' || e.kind === 'inbound-email-action' || patterns(e).includes('notification') || stepKinds(e).includes('notification'),
  visibility: (e) => e.kind === 'report' || e.kind === 'dashboard',
  compliance: (e) => e.kind === 'acl' || e.kind === 'role' || patterns(e).includes('access-check'),
  data: (e) => ['dictionary-field', 'choice-list', 'table', 'hardware-model', 'asset-class', 'ci-class'].includes(e.kind),
  integration: (e) => e.kind === 'integration' || e.kind === 'mid-server' || patterns(e).includes('integration'),
  security: (e) => e.kind === 'acl' || e.kind === 'role' || e.kind === 'user-criteria',
};

const MAX_OUTCOME_EVIDENCE = 50;
const RANK: Record<Confidence, number> = { high: 2, medium: 1, low: 0 };
const minConf = (cs: Confidence[]): Confidence => (cs.length ? cs.reduce((a, b) => (RANK[b] < RANK[a] ? b : a)) : 'medium');

export interface DerivedCapability {
  outcomes: Outcome[];
  design: DesignElement[];
  params: Map<string, ParamResolution>;
}

export interface DeriveInput {
  capability: Capability;
  detection: CapabilityDetection;
  all: Evidence[];
  byId: Map<string, Evidence>;
  store: RecordStore;
  hasUsage: boolean;
  /** Human overrides (from the workbench) win over resolvers. */
  overrides?: Record<string, ParamValue>;
}

function provenanceFor(ids: string[], byId: Map<string, Evidence>): Provenance[] {
  return ids.slice(0, 5).map((id) => byId.get(id)?.provenance[0]).filter((p): p is Provenance => Boolean(p)).map(({ excerpt: _e, ...p }) => p);
}

function deriveOutcome(t: OutcomeTemplate, cap: Capability, params: Map<string, ParamResolution>, evidence: Evidence[], core: Set<string>, byId: Map<string, Evidence>): Outcome {
  const values: Record<string, ParamValue> = {};
  for (const p of t.parameters) values[p.name] = params.get(p.name)!.value;
  const res = t.parameters.map((p) => params.get(p.name)!);
  const categoryEv = evidence.filter((e) => CATEGORY_EVIDENCE[t.category](e, core)).map((e) => e.id);
  const evidenceIds = [...new Set([...res.flatMap((r) => r.evidenceIds), ...categoryEv])].slice(0, MAX_OUTCOME_EVIDENCE);
  const fromRules = res.some((r) => r.method === 'rules');
  const allDefault = res.length > 0 && res.every((r) => r.method === 'catalogue-default');
  const method: NonNullable<Outcome['derivation']>['method'] = fromRules ? 'rules' : !res.length && categoryEv.length ? 'rules' : 'catalogue-default';
  const confidence: Confidence = res.length ? minConf(res.map((r) => r.confidence)) : categoryEv.length ? 'medium' : 'low';
  const rationale = [
    ...res.map((r) => `${r.name} = ${fmt(r.value)} [${r.method}, ${r.confidence}]: ${r.rationale}`),
    !res.length ? (categoryEv.length ? `${categoryEv.length} ServiceNow artifacts show this outcome exists today.` : 'Reference outcome with no direct ServiceNow evidence: confirm it is wanted (it may be new value).') : '',
  ].filter(Boolean).join(' ');
  const notes = res.flatMap((r) => r.notes.map((n) => `${r.name}: ${n}`));
  return {
    id: t.id,
    capabilityId: cap.id,
    templateId: t.id,
    category: t.category,
    statement: fillText(t.statement, values),
    parameters: values,
    acceptance: t.acceptance.map((ac) => fillDeep(ac, values)),
    evidenceIds,
    derivation: { method, confidence, rationale, provenance: provenanceFor(evidenceIds, byId) },
    status: 'proposed',
    priority: categoryEv.length || fromRules || allDefault ? 'must' : 'should',
    ...(notes.length ? { notes: notes.join(' ') } : {}),
  };
}

// ── Design instantiation ──────────────────────────────────────────────────

const slaPurposeOf = (el: DesignElement): 'response' | 'resolution' | undefined => {
  const n = el.name.toLowerCase();
  return /respon|first/.test(n) ? 'response' : /resol|fulfil/.test(n) ? 'resolution' : undefined;
};

/** Configure the reference calendar from the ServiceNow schedule the winning SLA used. */
function calendarFrom(schedule: Evidence | undefined): Partial<Extract<DesignElement, { type: 'calendar' }>['spec']> | undefined {
  if (!schedule) return undefined;
  const days = attr<string[]>(schedule, 'workingDays');
  const hours = attr<string[]>(schedule, 'hours') ?? [];
  const m = hours[0]?.match(/(\d{2})(\d{2})\d{2}–(\d{2})(\d{2})\d{2}/);
  const tz = attr<string>(schedule, 'timeZone');
  if (!days?.length && !m && !tz) return undefined;
  const out: Partial<Extract<DesignElement, { type: 'calendar' }>['spec']> = {};
  if (tz) out.timeZone = tz;
  if (days?.length || m) {
    out.workingHours = [{
      days: (days?.length ? days : ['MON', 'TUE', 'WED', 'THU', 'FRI']).filter((d): d is 'MON' => ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].includes(d)),
      start: m ? `${m[1]}:${m[2]}` : '09:00', end: m ? `${m[3]}:${m[4]}` : '17:00',
    }];
  }
  return out;
}

export function instantiateDesign(cap: Capability, outcomes: Outcome[], params: Map<string, ParamResolution>, byId: Map<string, Evidence>): DesignElement[] {
  const values: Record<string, ParamValue> = Object.fromEntries([...params].map(([k, r]) => [k, r.value]));
  const delivers = new Map<string, string[]>();
  for (const t of cap.outcomes) {
    if (!outcomes.some((o) => o.templateId === t.id)) continue;
    for (const d of t.deliveredBy) delivers.set(d, [...(delivers.get(d) ?? []), t.id]);
  }
  const durationParams = cap.outcomes.flatMap((t) => t.parameters.filter((p) => p.type === 'duration').map((p) => ({ p, template: t })));
  const calendarConfig = new Map<string, ReturnType<typeof calendarFrom>>();

  const elements = cap.design.elements.map((orig) => {
    const el = structuredClone(orig);
    const notes: string[] = [];
    const before = JSON.stringify(el.spec);
    el.spec = fillDeep(el.spec, values) as typeof el.spec;
    if (JSON.stringify(el.spec) !== before) notes.push('customer parameters applied');

    if (el.type === 'sla') {
      const purpose = slaPurposeOf(el);
      const match = durationParams.find(({ p, template }) => template.deliveredBy.includes(el.id) && purposeOfParam(p) === purpose);
      const r = match ? params.get(match.p.name) : undefined;
      if (r) {
        el.spec.goals = el.spec.goals.map((g) => ({ ...g, target: r.value as Extract<ParamValue, { unit: string }> }));
        notes.push(`goal ${fmt(r.value)} from ${r.method === 'rules' ? 'ServiceNow SLA evidence' : 'catalogue default'}`);
        const schedule = r.evidenceIds.map((id) => byId.get(id)).flatMap((e) => e?.relations.filter((x) => x.type === 'uses').map((x) => byId.get(x.targetId)) ?? []).find((x) => x?.kind === 'schedule');
        const cal = calendarFrom(schedule);
        if (cal) for (const g of el.spec.goals) if (g.calendarId && !calendarConfig.has(g.calendarId)) calendarConfig.set(g.calendarId, cal);
        const units = (r.value as { unit?: string }).unit ?? '';
        if (!units.startsWith('business')) notes.push('ServiceNow measures this 24×7: confirm whether business hours are wanted');
      }
    }
    if (notes.length && el.origin === 'reference') el.origin = 'reference-configured';
    el.deliversOutcomeIds = [...new Set([...(el.deliversOutcomeIds ?? []), ...(delivers.get(el.id) ?? [])])];
    if (notes.length) el.notes = [el.notes, ...notes].filter(Boolean).join('; ');
    return el;
  });

  for (const el of elements) {
    const cal = el.type === 'calendar' ? calendarConfig.get(el.id) : undefined;
    if (el.type === 'calendar' && cal) {
      el.spec = { ...el.spec, ...cal };
      el.origin = el.origin === 'reference' ? 'reference-configured' : el.origin;
      el.notes = [el.notes, 'working hours and time zone from the ServiceNow schedule'].filter(Boolean).join('; ');
    }
  }
  return elements;
}

/** Outcomes and configured design for one capability. */
export function deriveCapability(input: DeriveInput): DerivedCapability {
  const { capability: cap, detection, all, byId, store, hasUsage } = input;
  const evidence = detection.evidenceIds.map((id) => byId.get(id)).filter((e): e is Evidence => Boolean(e));
  const base: Omit<ResolverInput, 'param'> = { capability: cap, detection, evidence, all, byId, store, hasUsage };
  const params = resolveCapabilityParams(base);
  for (const [name, value] of Object.entries(input.overrides ?? {})) {
    const cur = params.get(name);
    if (cur) params.set(name, { ...cur, value, method: 'rules', confidence: 'high', rationale: `Set by a person (was ${fmt(cur.value)}). ${cur.rationale}`, notes: [] });
  }
  const core = new Set(detection.coreEvidenceIds);
  const outcomes = cap.outcomes.map((t) => deriveOutcome(t, cap, params, evidence, core, byId));
  const design = instantiateDesign(cap, outcomes, params, byId);
  return { outcomes, design, params };
}
