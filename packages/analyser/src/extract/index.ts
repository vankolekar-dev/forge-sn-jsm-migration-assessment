import type { Snapshot } from '@snjsm/collector';
import type { Evidence } from '@snjsm/model';
import { RecordStore } from '../store';
import { catalogExtractors } from './catalog';
import { cmdbExtractors } from './cmdb';
import { toEvidence, type ExtractContext, type Extractor } from './common';
import { dataExtractors, opsExtractors } from './ops';
import { platformExtractors } from './platform';
import { processExtractors } from './process';

export const EXTRACTORS: Extractor[] = [...catalogExtractors, ...processExtractors, ...opsExtractors, ...dataExtractors, ...platformExtractors, ...cmdbExtractors];

export interface ExtractionResult {
  evidence: Evidence[];
  /** Records per table that no extractor turned into evidence (inventory only). */
  unextracted: Record<string, number>;
  warnings: string[];
}

export function extractEvidence(snapshot: Snapshot, store = new RecordStore(snapshot)): ExtractionResult {
  const ctx: ExtractContext = {
    store,
    source: snapshot.source.kind,
    capturedAt: snapshot.source.capturedAt,
    instanceUrl: snapshot.source.instance ? `https://${snapshot.source.instance}` : undefined,
  };
  const byTable = new Map<string, Extractor[]>();
  for (const x of EXTRACTORS) for (const t of x.tables) byTable.set(t, [...(byTable.get(t) ?? []), x]);

  const evidence = new Map<string, Evidence>();
  const warnings: string[] = [];
  const unextracted: Record<string, number> = {};
  const add = (e: Evidence) => { if (!evidence.has(e.id)) evidence.set(e.id, e); };

  const consumed = EXTRACTORS.flatMap((x) => x.consumes ?? []);
  const isConsumed = (t: string) => consumed.some((c) => (c.endsWith('*') ? t.startsWith(c.slice(0, -1)) : c === t));
  for (const table of store.tables()) {
    const xs = byTable.get(table);
    if (!xs) { if (!isConsumed(table)) unextracted[table] = store.table(table).length; continue; }
    for (const r of store.table(table)) {
      for (const x of xs) {
        try {
          const drafts = x.record?.(r, ctx);
          for (const d of drafts ? (Array.isArray(drafts) ? drafts : [drafts]) : []) add(toEvidence(r, d, ctx));
        } catch (e) {
          warnings.push(`${x.name} failed on ${table}:${r.sysId}: ${(e as Error).message}`);
        }
      }
    }
  }
  for (const x of EXTRACTORS) {
    if (!x.all) continue;
    try { for (const e of x.all(ctx)) add(e); } catch (e) { warnings.push(`${x.name} failed: ${(e as Error).message}`); }
  }

  const list = [...evidence.values()];
  // Drop relations to records that did not become evidence (e.g. OOB script includes outside the export).
  for (const e of list) e.relations = e.relations.filter((r) => evidence.has(r.targetId) && r.targetId !== e.id);
  markUsedBy(list);
  markDuplicates(list);
  return { evidence: list, unextracted, warnings };
}

/** How many other evidence items use each script include / REST message / event (dependency hotspots). */
function markUsedBy(list: Evidence[]) {
  const used = new Map<string, number>();
  for (const e of list) for (const r of e.relations) if (r.type === 'uses' || r.type === 'triggers') used.set(r.targetId, (used.get(r.targetId) ?? 0) + 1);
  for (const e of list) if (used.has(e.id)) e.attributes = { ...e.attributes, usedBy: used.get(e.id) };
}

/**
 * Catalog items with near-identical questions (Jaccard >= 0.8 on variable names) are candidates to collapse into one
 * request type. Clustered with union-find; each member links to its cluster lead (no n² relations).
 */
function markDuplicates(list: Evidence[]) {
  const byId = new Map(list.map((e) => [e.id, e]));
  const vars = new Map<string, Set<string>>();
  for (const e of list) {
    if (e.kind !== 'catalog-item' && e.kind !== 'record-producer') continue;
    const names = new Set(e.relations.filter((r) => r.type === 'contains').map((r) => byId.get(r.targetId)).filter((v) => v?.kind === 'catalog-variable').map((v) => String(v!.attributes['variableName'] ?? v!.name).toLowerCase()));
    if (names.size >= 2) vars.set(e.id, names);
  }
  const parent = new Map<string, string>();
  const find = (x: string): string => { const p = parent.get(x) ?? x; if (p === x) return x; const r = find(p); parent.set(x, r); return r; };
  // Bucket by exact signature first (cheap), then compare bucket representatives pairwise.
  const buckets = new Map<string, string[]>();
  for (const [id, names] of vars) { const sig = [...names].sort().join('|'); buckets.set(sig, [...(buckets.get(sig) ?? []), id]); }
  for (const ids of buckets.values()) for (const id of ids.slice(1)) parent.set(id, ids[0]!);
  const reps = [...buckets.values()].map((ids) => ids[0]!);
  if (reps.length <= 3000) {
    for (let i = 0; i < reps.length; i++) for (let j = i + 1; j < reps.length; j++) {
      const a = vars.get(reps[i]!)!, b = vars.get(reps[j]!)!;
      const inter = [...a].filter((x) => b.has(x)).length;
      if (inter / (a.size + b.size - inter) >= 0.8) parent.set(find(reps[j]!), find(reps[i]!));
    }
  }
  const clusters = new Map<string, string[]>();
  for (const id of vars.keys()) { const root = find(id); clusters.set(root, [...(clusters.get(root) ?? []), id]); }
  let n = 0;
  for (const [lead, members] of clusters) {
    if (members.length < 2) continue;
    const group = `dup-${++n}`;
    for (const id of members) {
      const e = byId.get(id)!;
      e.attributes = { ...e.attributes, duplicateGroup: group, duplicateGroupSize: members.length };
      if (id !== lead) e.relations.push({ type: 'duplicates', targetId: lead });
    }
  }
}

export * from './common';
export { VARIABLE_TYPES, referenceKind } from './catalog';
export { stepKind } from './process';
export { slaPurpose, fmtMinutes } from './ops';
