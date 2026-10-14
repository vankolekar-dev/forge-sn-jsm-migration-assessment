import type { SnRecord } from '@snjsm/collector';
import type { Domain, Evidence, EvidenceKind, EvidenceRelation, Provenance } from '@snjsm/model';
import { RecordStore, evidenceId, isActive, isCustom, nameOf } from '../store';

export interface ExtractContext {
  store: RecordStore;
  source: Provenance['source'];
  capturedAt: string;
  /** https://<instance> for live snapshots: provenance links back to the record. */
  instanceUrl?: string;
}

export type Relation = { type: EvidenceRelation['type']; target: SnRecord | string | undefined };

export interface EvidenceDraft {
  kind: EvidenceKind;
  name?: string;
  domain?: Domain;
  summary?: string;
  intent?: string;
  intentConfidence?: Evidence['intentConfidence'];
  usage?: Evidence['usage'];
  attributes?: Record<string, unknown>;
  relations?: Relation[];
  custom?: boolean;
  /** Override the record-derived id (aggregated evidence). */
  id?: string;
  /** Extra provenance (aggregated evidence lists its sample records). */
  provenance?: Provenance[];
}

/** An extractor turns records from its tables into evidence. Returning undefined skips the record. */
export interface Extractor {
  name: string;
  tables: string[];
  /** Tables this extractor reads as detail of other evidence (counted as consumed, not "unextracted"). */
  consumes?: string[];
  /** Called once per record. */
  record?(r: SnRecord, ctx: ExtractContext): EvidenceDraft | EvidenceDraft[] | undefined;
  /** Called once per snapshot (aggregated evidence). */
  all?(ctx: ExtractContext): Evidence[];
}

export function provenanceOf(r: SnRecord, ctx: ExtractContext, excerpt?: string): Provenance {
  return {
    source: ctx.source,
    table: r.table,
    sysId: r.sysId,
    capturedAt: ctx.capturedAt,
    ...(ctx.instanceUrl ? { url: `${ctx.instanceUrl}/${r.table}.do?sys_id=${r.sysId}` } : {}),
    ...(excerpt ? { excerpt: excerpt.slice(0, 2000) } : {}),
  };
}

export function relationIds(rels: Relation[] | undefined): EvidenceRelation[] {
  const out: EvidenceRelation[] = [];
  const seen = new Set<string>();
  for (const r of rels ?? []) {
    if (!r.target) continue;
    const targetId = typeof r.target === 'string' ? r.target : evidenceId(r.target);
    const k = `${r.type}:${targetId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ type: r.type, targetId });
  }
  return out;
}

export function toEvidence(r: SnRecord, d: EvidenceDraft, ctx: ExtractContext): Evidence {
  const table = r.fields['collection'] || r.fields['table'] || r.fields['name'];
  return {
    id: d.id ?? evidenceId(r),
    kind: d.kind,
    name: (d.name ?? nameOf(r)).slice(0, 300) || r.sysId,
    domain: d.domain ?? domainOf(table),
    summary: d.summary ?? (r.fields['short_description'] || r.fields['description'] || undefined)?.slice(0, 1000),
    intent: d.intent,
    intentConfidence: d.intentConfidence ?? (d.intent ? 'medium' : undefined),
    provenance: [provenanceOf(r, ctx), ...(d.provenance ?? [])],
    usage: { active: isActive(r), ...(d.usage ?? {}) },
    attributes: clean(d.attributes ?? {}),
    relations: relationIds(d.relations),
    custom: d.custom ?? isCustom(r),
  };
}

/** Drop empty values so evidence stays readable. */
export function clean(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)));
}

// ── Taxonomy ──────────────────────────────────────────────────────────────

const DOMAIN_PREFIXES: [RegExp, Domain][] = [
  [/^(incident|problem|change_|sc_|sysapproval|kb_|task_sla|contract_sla|std_change|cab_|chg_|interaction|sn_ind)/, 'ITSM'],
  [/^(sn_hr|hr_|sn_hr_)/, 'HR'],
  [/^(sn_customerservice|csm_|customer_)/, 'CSM'],
  [/^(facilities|sn_wsd|fm_)/, 'FACILITIES'],
  [/^(sn_si|sn_vul|sn_sec)/, 'SECOPS'],
  [/^(sn_grc|sn_risk|sn_compliance|sn_audit)/, 'GRC'],
  [/^(alm_|cmdb_model|cmdb_hardware_product_model|cmdb_software_product_model|samp_|sam_)/, 'ITAM'],
  [/^(cmdb|em_|discovery|sn_itom|ecc_)/, 'ITOM'],
  [/^(pm_|rm_|dmn_|sn_apm|sn_ppm|tsp_)/, 'ITBM'],
  [/^(u_|x_)/, 'CUSTOM'],
];

export function domainOf(table: string | undefined): Domain | undefined {
  if (!table) return undefined;
  for (const [re, d] of DOMAIN_PREFIXES) if (re.test(table)) return d;
  return undefined;
}

/** ITSM practice (or domain practice) a process table belongs to. */
export function practiceOf(table: string | undefined): string | undefined {
  if (!table) return undefined;
  if (/^incident/.test(table)) return 'incident';
  if (/^problem/.test(table)) return 'problem';
  if (/^(change_|std_change|chg_|cab_)/.test(table)) return 'change';
  if (/^(sc_|sysapproval)/.test(table)) return 'service-request';
  if (/^kb_/.test(table)) return 'knowledge';
  if (/^(cmdb_ci_service|service_offering)/.test(table)) return 'service-catalogue';
  if (/^cmdb/.test(table)) return 'configuration';
  if (/^alm_|^cmdb_model|product_model/.test(table)) return 'asset';
  if (/^(sn_hr|hr_)/.test(table)) return 'hr-case';
  if (/^(sn_customerservice|csm_)/.test(table)) return 'customer-case';
  if (/^(facilities|sn_wsd)/.test(table)) return 'facilities';
  if (/^(sn_si|sn_sec)/.test(table)) return 'security-incident';
  if (/^(sn_vul)/.test(table)) return 'vulnerability';
  if (/^(sn_grc|sn_risk|sn_compliance)/.test(table)) return 'risk-compliance';
  if (/^(interaction)/.test(table)) return 'interaction';
  if (/^(task|task_sla)$/.test(table)) return 'all-tasks';
  return undefined;
}

export const csv = (v: string | undefined) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
export const num = (v: string | undefined) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? undefined : Number(v));

/** ServiceNow duration ("1970-01-02 08:00:00", "2 08:00:00", "08:00:00", seconds) → minutes. */
export function durationMinutes(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const s = v.trim();
  let m = s.match(/^1970-01-(\d{2})\s+(\d{1,2}):(\d{2}):(\d{2})$/);
  if (m) return (Number(m[1]) - 1) * 1440 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 60;
  m = s.match(/^(?:(\d+)\s+)?(\d{1,3}):(\d{2})(?::(\d{2}))?$/);
  if (m) return Number(m[1] ?? 0) * 1440 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4] ?? 0) / 60;
  if (/^\d+$/.test(s)) return Number(s) / 60;
  m = s.match(/^(\d+(?:\.\d+)?)\s*(minute|min|hour|hr|day|business day|business hour)s?$/i);
  if (m) {
    const n = Number(m[1]);
    const u = m[2]!.toLowerCase();
    return u.startsWith('min') ? n : u.includes('hour') || u === 'hr' ? n * 60 : n * 1440;
  }
  return undefined;
}

/** Fields referenced in an encoded query ("priority=1^state!=6^ORcategory=network"). */
export function queryFields(q: string | undefined): { field: string; op: string; value: string }[] {
  if (!q) return [];
  return q
    .split(/\^OR|\^NQ|\^/)
    .map((t) => t.trim())
    .filter((t) => t && t !== 'EQ' && !t.startsWith('ORDERBY'))
    .map((t) => {
      const m = t.match(/^([a-zA-Z0-9_.]+?)(!=|>=|<=|=|>|<|LIKE|NOT LIKE|STARTSWITH|ENDSWITH|ISEMPTY|ISNOTEMPTY|IN|NOT IN|CHANGES|CHANGESFROM|CHANGESTO|VALCHANGES|ANYTHING|SAMEAS|BETWEEN|DYNAMIC|RELATIVE\w+)(.*)$/);
      return m ? { field: m[1]!, op: m[2]!, value: m[3] ?? '' } : { field: t, op: '?', value: '' };
    });
}

export { evidenceId, isActive, isCustom, nameOf };
