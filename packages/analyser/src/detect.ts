import type { Capability, Domain, Evidence } from '@snjsm/model';
import { practiceOf } from './extract/common';

/** Practice taxonomy: catalogue-independent map of what the estate does. */
export interface PracticeDef { id: string; label: string; domain: Domain; tables?: RegExp; keywords?: string[]; parent?: string }

export const PRACTICES: PracticeDef[] = [
  { id: 'incident', label: 'Incident management', domain: 'ITSM', tables: /^incident/ },
  { id: 'problem', label: 'Problem management', domain: 'ITSM', tables: /^problem/ },
  { id: 'change', label: 'Change enablement', domain: 'ITSM', tables: /^(change_|std_change|chg_|cab_)/ },
  { id: 'service-request', label: 'Service request management', domain: 'ITSM', tables: /^(sc_|sysapproval)/ },
  { id: 'service-request.hardware', parent: 'service-request', label: 'Hardware requests', domain: 'ITSM', keywords: ['hardware', 'laptop', 'desktop', 'monitor', 'computer', 'mobile', 'phone', 'tablet', 'peripheral', 'accessory', 'keyboard', 'headset', 'printer', 'docking'] },
  { id: 'service-request.software', parent: 'service-request', label: 'Software requests', domain: 'ITSM', keywords: ['software', 'licence', 'license', 'install', 'subscription', 'application access'] },
  { id: 'service-request.access', parent: 'service-request', label: 'Access requests', domain: 'ITSM', keywords: ['access', 'account', 'permission', 'vpn', 'password', 'login', 'mailbox', 'distribution list', 'shared drive', 'folder', 'role'] },
  { id: 'service-request.onboarding', parent: 'service-request', label: 'Onboarding', domain: 'HR', keywords: ['onboard', 'new hire', 'new starter', 'joiner', 'new employee'] },
  { id: 'service-request.offboarding', parent: 'service-request', label: 'Offboarding', domain: 'HR', keywords: ['offboard', 'leaver', 'termination', 'exit', 'departure'] },
  { id: 'service-request.facilities', parent: 'service-request', label: 'Facilities requests', domain: 'FACILITIES', keywords: ['facilit', 'desk', 'office', 'building', 'room', 'parking', 'badge', 'cleaning', 'maintenance'] },
  { id: 'service-request.hr', parent: 'service-request', label: 'HR requests', domain: 'HR', keywords: ['payroll', 'leave', 'benefit', 'hr ', 'human resources', 'expense'] },
  { id: 'knowledge', label: 'Knowledge management', domain: 'ITSM', tables: /^kb_/ },
  { id: 'service-level', label: 'Service level management', domain: 'ITSM' },
  { id: 'configuration', label: 'Configuration management (CMDB)', domain: 'ITOM', tables: /^cmdb(?!_ci_service)/ },
  { id: 'service-catalogue', label: 'Service catalogue / CSDM services', domain: 'ITOM', tables: /^(cmdb_ci_service|service_offering)/ },
  { id: 'asset', label: 'IT asset management', domain: 'ITAM', tables: /^(alm_|cmdb_model)|product_model/ },
  { id: 'hr-case', label: 'HR case management', domain: 'HR', tables: /^(sn_hr|hr_)/ },
  { id: 'customer-case', label: 'Customer service', domain: 'CSM', tables: /^(sn_customerservice|csm_)/ },
  { id: 'facilities', label: 'Facilities / workplace', domain: 'FACILITIES', tables: /^(facilities|sn_wsd)/ },
  { id: 'security-incident', label: 'Security incident response', domain: 'SECOPS', tables: /^(sn_si|sn_sec)/ },
  { id: 'integration', label: 'Integrations', domain: 'CUSTOM' },
  { id: 'self-service', label: 'Self-service portal & virtual agent', domain: 'ITSM' },
];

export interface PracticeDetection {
  practice: string;
  label: string;
  domain: Domain;
  parent?: string;
  evidenceIds: string[];
  kinds: Record<string, number>;
  /** Requests / runs in the usage window, when known. */
  volume?: number;
  capabilityIds: string[];
  covered: boolean;
}

const hay = (e: Evidence) => [e.name, e.summary, e.intent, e.attributes['category'], e.attributes['table'], e.attributes['targetTable'], ...((e.attributes['stepKinds'] as string[] | undefined) ?? [])].filter(Boolean).join(' ').toLowerCase();
const tableOf = (e: Evidence) => String(e.attributes['table'] ?? e.attributes['targetTable'] ?? e.attributes['ciClass'] ?? e.attributes['assetClass'] ?? e.attributes['modelClass'] ?? e.provenance[0]?.table ?? '');

/** Which practice(s) one evidence item belongs to. */
export function practicesOf(e: Evidence): string[] {
  const out = new Set<string>();
  const t = tableOf(e);
  for (const p of PRACTICES) if (p.tables && t && p.tables.test(t)) out.add(p.id);
  if (e.kind === 'catalog-item' || e.kind === 'record-producer' || e.kind === 'order-guide' || e.kind === 'catalog-category') {
    const h = hay(e);
    if (e.kind !== 'record-producer' || /sc_|^$/.test(String(e.attributes['targetTable'] ?? ''))) out.add('service-request');
    for (const p of PRACTICES.filter((x) => x.keywords)) if (p.keywords!.some((k) => h.includes(k))) out.add(p.id);
    const pt = practiceOf(String(e.attributes['targetTable'] ?? ''));
    if (pt) out.add(pt);
  }
  if (e.kind === 'sla-definition' || e.kind === 'schedule') out.add('service-level');
  if (e.kind === 'integration' || e.kind === 'mid-server' || e.kind === 'transform-map') out.add('integration');
  if (e.kind === 'portal' || e.kind === 'portal-widget' || e.kind === 'virtual-agent-topic') out.add('self-service');
  if (e.kind === 'knowledge-base') out.add('knowledge');
  if (e.kind === 'ci-class' || e.kind === 'ci-relationship-stat' || e.kind === 'ci-relationship-type' || e.kind === 'identification-rule') out.add('configuration');
  if (e.kind === 'service' || e.kind === 'service-offering' || e.kind === 'business-application') out.add('service-catalogue');
  if (e.kind === 'asset-class' || e.kind === 'hardware-model') out.add('asset');
  if (e.kind === 'plugin') {
    const prod = String(e.attributes['product'] ?? '').toLowerCase();
    for (const [re, id] of [[/change/, 'change'], [/problem/, 'problem'], [/hr service/, 'hr-case'], [/customer service/, 'customer-case'], [/facilities|workplace/, 'facilities'], [/security incident/, 'security-incident'], [/knowledge/, 'knowledge'], [/discovery|cmdb|service mapping/, 'configuration'], [/asset/, 'asset']] as [RegExp, string][]) if (re.test(prod)) out.add(id);
  }
  return [...out];
}

export function detectPractices(evidence: Evidence[], capabilities: Capability[]): PracticeDetection[] {
  const byPractice = new Map<string, Evidence[]>();
  for (const e of evidence) for (const p of practicesOf(e)) byPractice.set(p, [...(byPractice.get(p) ?? []), e]);
  const out: PracticeDetection[] = [];
  for (const def of PRACTICES) {
    const evs = byPractice.get(def.id);
    if (!evs?.length) continue;
    // Plugins alone do not make a practice "present"; configuration does.
    if (evs.every((e) => e.kind === 'plugin')) continue;
    const kinds = evs.reduce<Record<string, number>>((m, e) => ((m[e.kind] = (m[e.kind] ?? 0) + 1), m), {});
    const vols = evs.filter((e) => ['catalog-item', 'record-producer', 'flow', 'legacy-workflow'].includes(e.kind)).map((e) => e.usage?.count).filter((n): n is number => n !== undefined);
    const caps = capabilities.filter((c) => c.practice === def.id || `${c.practice}.${c.id.split('.').pop()?.replace(/^request-/, '')}` === def.id || capabilityPractice(c) === def.id).map((c) => c.id);
    out.push({ practice: def.id, label: def.label, domain: def.domain, parent: def.parent, evidenceIds: evs.map((e) => e.id), kinds, volume: vols.length ? vols.reduce((n, v) => n + v, 0) : undefined, capabilityIds: caps, covered: caps.length > 0 });
  }
  return out;
}

/** Most specific practice a capability serves (e.g. itsm.request-hardware → service-request.hardware). */
export function capabilityPractice(c: Capability): string {
  const sub = c.id.split('.').pop() ?? '';
  const m = sub.match(/^request-(.+)$/);
  if (m && PRACTICES.some((p) => p.id === `${c.practice}.${m[1]}`)) return `${c.practice}.${m[1]}`;
  return c.practice;
}

// ── Capability detection ─────────────────────────────────────────────────

export interface CapabilityDetection {
  capabilityId: string;
  score: number;
  status: 'detected' | 'proposed';
  coreEvidenceIds: string[];
  evidenceIds: string[];
  signals: { description: string; weight: number; strength: number; matches: number; local: boolean }[];
  volume?: number;
  notes: string[];
}

function signalMatches(sig: Capability['signals'][number], evidence: Evidence[]): Evidence[] {
  const kws = sig.keywords.map((k) => k.toLowerCase());
  return evidence.filter((e) => {
    const kindOk = sig.evidenceKinds.includes(e.kind) || sig.tables.some((t) => e.provenance.some((p) => p.table === t) || tableOf(e) === t);
    if (!kindOk) return false;
    if (!kws.length) return true;
    const h = hay(e);
    return kws.some((k) => h.includes(k));
  });
}

/** Evidence within `hops` relations of the seed set (both directions). */
export function neighbourhood(seed: Set<string>, evidence: Evidence[], hops = 2): Set<string> {
  const adj = new Map<string, Set<string>>();
  const link = (a: string, b: string) => { if (!adj.has(a)) adj.set(a, new Set()); adj.get(a)!.add(b); };
  for (const e of evidence) for (const r of e.relations) { link(e.id, r.targetId); link(r.targetId, e.id); }
  let frontier = new Set(seed);
  const seen = new Set(seed);
  for (let i = 0; i < hops; i++) {
    const next = new Set<string>();
    for (const id of frontier) for (const n of adj.get(id) ?? []) if (!seen.has(n)) { seen.add(n); next.add(n); }
    frontier = next;
  }
  return seen;
}

export function detectCapabilities(evidence: Evidence[], capabilities: Capability[], hasUsage: boolean): CapabilityDetection[] {
  const out: CapabilityDetection[] = [];
  for (const cap of capabilities) {
    const sigs = [...cap.signals].sort((a, b) => b.weight - a.weight);
    const primary = sigs[0]!;
    const core = signalMatches(primary, evidence).filter((e) => e.usage?.active !== false);
    if (!core.length) continue;
    const near = neighbourhood(new Set(core.map((e) => e.id)), evidence, 2);
    const all = new Set(core.map((e) => e.id));
    const results = sigs.map((sig, i) => {
      if (i === 0) return { description: sig.description, weight: sig.weight, strength: Math.min(1, 0.6 + 0.1 * core.length), matches: core.length, local: true };
      const m = signalMatches(sig, evidence);
      const local = m.filter((e) => near.has(e.id));
      // Only linked matches become capability evidence; unlinked ones (e.g. incident workflows) only raise the score a little.
      for (const e of local.slice(0, 100)) all.add(e.id);
      const strength = local.length ? Math.min(1, 0.6 + 0.1 * local.length) : m.length ? 0.3 : 0;
      return { description: sig.description, weight: sig.weight, strength, matches: local.length || m.length, local: local.length > 0 };
    });
    // Everything directly attached to the core (variables, flows, groups, policies) is evidence too.
    for (const id of neighbourhood(new Set(core.map((e) => e.id)), evidence, 1)) all.add(id);
    const totalW = results.reduce((n, r) => n + r.weight, 0);
    const score = Math.round((results.reduce((n, r) => n + r.weight * r.strength, 0) / totalW) * 100) / 100;
    const volume = hasUsage ? core.reduce((n, e) => n + (e.usage?.count ?? 0), 0) : undefined;
    const notes: string[] = [];
    let status: CapabilityDetection['status'] = score >= 0.5 ? 'detected' : 'proposed';
    if (hasUsage && volume === 0) { status = 'proposed'; notes.push('Configured but no requests in the usage window.'); }
    if (score < 0.25) continue;
    out.push({ capabilityId: cap.id, score, status, coreEvidenceIds: core.map((e) => e.id), evidenceIds: [...all], signals: results, volume, notes });
  }
  return out.sort((a, b) => b.score - a.score);
}
