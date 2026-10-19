import type { SnRecord } from '@snjsm/collector';
import type { Capability, Confidence, Duration, Evidence, ParamDef, ParamValue } from '@snjsm/model';
import type { CapabilityDetection } from './detect';
import { fmtMinutes } from './extract/ops';
import { RecordStore, nameOf } from './store';

/**
 * Parameter resolvers: read ServiceNow evidence and propose a value for an outcome parameter
 * (a threshold, a team, a service-level goal). They never invent values: with no evidence the catalogue
 * default is used and marked low confidence so the workshop confirms it.
 */
export interface ParamResolution {
  name: string;
  value: ParamValue;
  method: 'rules' | 'catalogue-default';
  confidence: Confidence;
  evidenceIds: string[];
  rationale: string;
  /** Other values seen in the evidence (conflicts to settle in the workshop). */
  alternatives: { value: ParamValue; evidenceIds: string[]; weight: number }[];
  notes: string[];
}

export interface ResolverInput {
  capability: Capability;
  param: ParamDef;
  detection: CapabilityDetection;
  /** Evidence attached to this capability (core + neighbourhood). */
  evidence: Evidence[];
  /** Every evidence item in the snapshot. */
  all: Evidence[];
  byId: Map<string, Evidence>;
  store: RecordStore;
  hasUsage: boolean;
}

type Candidate = { value: ParamValue; evidenceId: string; weight: number; how: string };
export type Resolver = (input: ResolverInput) => Candidate[];

const attr = <T = unknown>(e: Evidence, k: string) => e.attributes[k] as T | undefined;
const key = (v: ParamValue) => JSON.stringify(v);

// ── Raw text access (scripts and conditions live on records, not on evidence) ──

export const TEXT_FIELDS = ['script', 'condition', 'filter_condition', 'advanced_condition', 'vars', 'values', 'approval_condition', 'condition_script', 'inputs', 'start_condition'];

function recordOf(store: RecordStore, e: Evidence): SnRecord | undefined {
  const p = e.provenance.find((x) => x.sysId);
  return p?.sysId ? store.get(p.sysId) : undefined;
}

/** Text chunks behind an evidence item, including child records of flows and legacy workflows. */
export function textsOf(store: RecordStore, e: Evidence): string[] {
  const r = recordOf(store, e);
  if (!r) return [];
  const recs: SnRecord[] = [r];
  if (e.kind === 'flow' || e.kind === 'subflow') {
    for (const t of ['sys_hub_action_instance_v2', 'sys_hub_action_instance', 'sys_hub_flow_logic_instance_v2', 'sys_hub_flow_logic', 'sys_hub_trigger_instance_v2', 'sys_hub_trigger_instance']) recs.push(...store.childrenOf(t, 'flow', r));
  }
  if (e.kind === 'legacy-workflow') {
    const versions = store.childrenOf('wf_workflow_version', 'workflow', r);
    recs.push(...store.childrenOf('wf_activity', 'workflow_version', r));
    for (const v of versions) recs.push(...store.childrenOf('wf_activity', 'workflow_version', v), ...store.childrenOf('wf_condition', 'workflow_version', v));
  }
  return recs.flatMap((x) => TEXT_FIELDS.map((f) => x.fields[f]).filter((v): v is string => Boolean(v && v.trim())));
}

// ── Cost / price thresholds ───────────────────────────────────────────────

const MONEY_WORD = '(?:price|cost|amount|total|value|budget|spend)';
const NUMBER = '(\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?';
const FORWARD = new RegExp(`${MONEY_WORD}\\w*(?:\\(\\))?['"\\)\\]]*\\s*(>=|>|<=|<|GREATERTHAN|LESSTHAN)\\s*(?:parseFloat\\(|parseInt\\(|Number\\()?['"]?${NUMBER}`, 'gi');
const BACKWARD = new RegExp(`['"]?${NUMBER}['"]?\\s*(<=|<|>=|>)\\s*[\\w.()'"\\[\\]]*${MONEY_WORD}`, 'gi');

/** Monetary thresholds compared in a script or encoded query: "price > 1000", "1000 < current.price". */
export function moneyThresholds(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(FORWARD)) out.push(Number(m[2]!.replace(/,/g, '')));
  for (const m of text.matchAll(BACKWARD)) out.push(Number(m[1]!.replace(/,/g, '')));
  return out.filter((n) => Number.isFinite(n) && n > 0 && n < 10_000_000);
}

const APPROVAL_KINDS = new Set(['approval-rule', 'flow', 'subflow', 'legacy-workflow', 'business-rule', 'script-include', 'catalog-item', 'record-producer', 'ui-policy', 'client-script']);

export const resolveMoneyThreshold: Resolver = ({ evidence, store }) => {
  const out: Candidate[] = [];
  for (const e of evidence) {
    if (!APPROVAL_KINDS.has(e.kind)) continue;
    const isApproval = e.kind === 'approval-rule' || (attr<number>(e, 'approvals') ?? 0) > 0 || (attr<{ patterns: string[] }>(e, 'script')?.patterns ?? []).includes('approval');
    for (const text of textsOf(store, e)) {
      for (const n of moneyThresholds(text)) out.push({ value: n, evidenceId: e.id, weight: isApproval ? 2 : 1, how: `${e.kind} "${e.name}" compares cost with ${n}` });
    }
  }
  return out;
};

// ── Fulfilment team ───────────────────────────────────────────────────────

const FULFIL_TABLES = /^(sc_req_item|sc_task|sc_request)$/;

export const resolveTeam: Resolver = ({ detection, evidence, byId, store, hasUsage }) => {
  const out: Candidate[] = [];
  const core = new Set(detection.coreEvidenceIds);
  for (const e of evidence) {
    if (core.has(e.id)) {
      const g = attr<string>(e, 'fulfilmentGroup');
      const vol = hasUsage ? e.usage?.count ?? 0 : 1;
      if (g) out.push({ value: g, evidenceId: e.id, weight: 2 + Math.log10(1 + vol), how: `catalog item "${e.name}" is fulfilled by ${g}` });
    }
    if (e.kind === 'assignment-rule' && FULFIL_TABLES.test(attr<string>(e, 'table') ?? '')) {
      const g = attr<string>(e, 'group');
      if (g) out.push({ value: g, evidenceId: e.id, weight: 1.5, how: `assignment rule "${e.name}" routes ${attr(e, 'table')} to ${g}` });
    }
    if (e.kind === 'flow' || e.kind === 'legacy-workflow' || e.kind === 'business-rule') {
      for (const r of e.relations.filter((x) => x.type === 'assigns-to')) {
        const g = byId.get(r.targetId);
        if (g?.kind === 'group') out.push({ value: g.name, evidenceId: e.id, weight: 1, how: `${e.kind} "${e.name}" assigns to ${g.name}` });
      }
    }
  }
  // Volume fallback: who actually works requested items / catalog tasks (live only).
  if (!out.length) {
    for (const agg of ['usage.sc-task-by-group', 'usage.req-item-by-group']) {
      const a = store.aggregate(agg);
      if (!a) continue;
      const total = a.rows.reduce((n, r) => n + r.count, 0);
      for (const row of a.rows.slice().sort((x, y) => y.count - x.count).slice(0, 5)) {
        const name = row.group['assignment_group__display'] ?? row.group['assignment_group'];
        const rec = name ? store.get(name) : undefined;
        const label = rec ? nameOf(rec) : name;
        const ev = evidence.find((e) => e.kind === 'group' && e.name.toLowerCase() === (label ?? '').toLowerCase());
        if (label && ev) out.push({ value: label, evidenceId: ev.id, weight: total ? (row.count / total) * 2 : 0.5, how: `${row.count} ${agg.includes('task') ? 'catalog tasks' : 'requested items'} worked by ${label}` });
      }
    }
  }
  return out;
};

// ── Service-level goals ───────────────────────────────────────────────────

export type SlaPurpose = 'response' | 'resolution';

export function purposeOfParam(p: ParamDef): SlaPurpose | undefined {
  const t = `${p.name} ${p.description}`.toLowerCase();
  if (/respon|acknowledg|first/.test(t)) return 'response';
  if (/resol|fulfil|deliver|complet/.test(t)) return 'resolution';
  return undefined;
}

const SLA_TABLES = /^(sc_req_item|sc_task|sc_request|task)$/;
const DAY_HOURS_DEFAULT = 8;

/** Working hours per day from schedule evidence (e.g. "090000–170000" → 8). */
function scheduleDayHours(schedule: Evidence | undefined): number | undefined {
  const hours = attr<string[]>(schedule ?? ({ attributes: {} } as Evidence), 'hours') ?? [];
  for (const h of hours) {
    const m = h.match(/(\d{2})(\d{2})\d{2}–(\d{2})(\d{2})\d{2}/);
    if (m) { const d = Number(m[3]) + Number(m[4]) / 60 - (Number(m[1]) + Number(m[2]) / 60); if (d > 0 && d <= 24) return d; }
  }
  return undefined;
}

const is24x7 = (name: string | undefined) => !name || /24\s*[x×]\s*7|24\/7|all day|always/i.test(name);

/**
 * ServiceNow duration → Atlassian goal. With a working-hours schedule ServiceNow counts schedule time, so the
 * duration is expressed in business hours (or business days when it is a whole number of working days).
 */
export function toDuration(minutes: number, scheduleName: string | undefined, dayHours = DAY_HOURS_DEFAULT): Duration {
  const hours = minutes / 60;
  const round = (n: number) => Math.round(n * 10) / 10;
  if (!is24x7(scheduleName)) {
    if (hours >= dayHours * 2 && Number.isInteger(round(hours / dayHours))) return { value: round(hours / dayHours), unit: 'business-days' };
    return { value: Math.max(0.1, round(hours)), unit: 'business-hours' };
  }
  if (minutes >= 2880 && minutes % 1440 === 0) return { value: minutes / 1440, unit: 'days' };
  if (minutes < 60) return { value: Math.max(1, Math.round(minutes)), unit: 'minutes' };
  return { value: round(hours), unit: 'hours' };
}

export const resolveSlaGoal: Resolver = ({ param, evidence, all, byId }) => {
  const purpose = purposeOfParam(param);
  if (!purpose) return [];
  const local = new Set(evidence.map((e) => e.id));
  const slas = all.filter((e) => e.kind === 'sla-definition' && e.usage?.active !== false && attr(e, 'purpose') === purpose && SLA_TABLES.test(attr<string>(e, 'table') ?? ''));
  const out: Candidate[] = [];
  for (const e of slas) {
    const minutes = attr<number>(e, 'durationMinutes');
    if (minutes === undefined || minutes <= 0) continue;
    const schedName = attr<string>(e, 'schedule');
    const sched = e.relations.filter((r) => r.type === 'uses').map((r) => byId.get(r.targetId)).find((x) => x?.kind === 'schedule');
    const d = toDuration(minutes, schedName, scheduleDayHours(sched));
    const vol = e.usage?.count ?? 0;
    const table = attr<string>(e, 'table');
    // Item-level SLAs (sc_req_item / sc_task) and those linked to the capability evidence weigh more; priority-specific ones less.
    const weight = (local.has(e.id) ? 2 : 1) * (table === 'sc_req_item' || table === 'sc_task' ? 1.5 : 1) * (attr(e, 'priority') ? 0.5 : 1) * (1 + Math.log10(1 + vol));
    out.push({ value: d, evidenceId: e.id, weight, how: `SLA "${e.name}" on ${table}: ${fmtMinutes(minutes)}${schedName ? ` on schedule "${schedName}"` : ' (24×7)'}` });
  }
  return out;
};

// ── Registry ──────────────────────────────────────────────────────────────

/** Resolvers by parameter name. Unknown names fall back to a resolver chosen by type and description. */
export const PARAM_RESOLVERS: Record<string, Resolver> = {
  costThreshold: resolveMoneyThreshold,
  fulfilmentTeam: resolveTeam,
  firstResponse: resolveSlaGoal,
  fulfilmentTime: resolveSlaGoal,
};

export function resolverFor(p: ParamDef): Resolver | undefined {
  if (PARAM_RESOLVERS[p.name]) return PARAM_RESOLVERS[p.name];
  const t = `${p.name} ${p.description}`.toLowerCase();
  if (p.type === 'number' && /cost|price|amount|threshold|budget/.test(t)) return resolveMoneyThreshold;
  if (p.type === 'string' && /team|group/.test(t)) return resolveTeam;
  if (p.type === 'duration' && purposeOfParam(p)) return resolveSlaGoal;
  return undefined;
}

/** Vote across candidates; agreement raises confidence, conflicts become alternatives and notes. */
export function resolveParam(input: ResolverInput): ParamResolution {
  const p = input.param;
  const fallback = (why: string): ParamResolution => ({
    name: p.name, value: p.default ?? (p.type === 'string' ? 'TBC' : p.type === 'number' ? 0 : p.type === 'boolean' ? false : p.type === 'string-list' ? [] : 'TBC'),
    method: 'catalogue-default', confidence: 'low', evidenceIds: [], rationale: why, alternatives: [], notes: [],
  });
  const resolver = resolverFor(p);
  if (!resolver) return fallback('No resolver for this parameter: catalogue default, confirm in the workshop.');
  let cands: Candidate[];
  try { cands = resolver(input); } catch (e) { return { ...fallback(`Resolver failed (${(e as Error).message}): catalogue default.`) }; }
  if (!cands.length) return fallback('No evidence found for this parameter: catalogue default, confirm in the workshop.');

  const votes = new Map<string, { value: ParamValue; weight: number; ids: Set<string>; how: string[] }>();
  for (const c of cands) {
    const k = key(c.value);
    const v = votes.get(k) ?? { value: c.value, weight: 0, ids: new Set(), how: [] };
    v.weight += c.weight;
    v.ids.add(c.evidenceId);
    if (v.how.length < 3) v.how.push(c.how);
    votes.set(k, v);
  }
  const ranked = [...votes.values()].sort((a, b) => b.weight - a.weight);
  const win = ranked[0]!;
  const total = ranked.reduce((n, v) => n + v.weight, 0);
  const share = win.weight / total;
  const confidence: Confidence = share >= 0.75 && win.ids.size >= 2 ? 'high' : share >= 0.5 ? 'medium' : 'low';
  const notes: string[] = [];
  if (ranked.length > 1) notes.push(`Evidence disagrees: ${ranked.slice(0, 4).map((v) => `${fmt(v.value)} (${v.ids.size} source${v.ids.size === 1 ? '' : 's'})`).join(', ')}. Settle in the workshop, or split the outcome if the difference is intentional.`);
  if (p.default !== undefined && key(p.default) !== key(win.value)) notes.push(`Differs from the reference default (${fmt(p.default)}).`);
  return {
    name: p.name, value: win.value, method: 'rules', confidence,
    evidenceIds: [...win.ids],
    rationale: `${win.how.join('; ')}${win.ids.size > win.how.length ? ` (+${win.ids.size - win.how.length} more)` : ''}.`,
    alternatives: ranked.slice(1, 6).map((v) => ({ value: v.value, evidenceIds: [...v.ids].slice(0, 10), weight: Math.round(v.weight * 100) / 100 })),
    notes,
  };
}

export function fmt(v: ParamValue): string {
  if (typeof v === 'object' && v !== null && !Array.isArray(v)) return `${v.value} ${v.unit.replace('-', ' ')}`;
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

/** Resolve every parameter of a capability once (parameters are shared across its outcomes). */
export function resolveCapabilityParams(base: Omit<ResolverInput, 'param'>): Map<string, ParamResolution> {
  const out = new Map<string, ParamResolution>();
  for (const o of base.capability.outcomes) for (const p of o.parameters) if (!out.has(p.name)) out.set(p.name, resolveParam({ ...base, param: p }));
  return out;
}
