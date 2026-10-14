import type { SnRecord } from './types';
import type { GroupCount } from './servicenow/client';
import { parseXml } from './xml/parser';

/**
 * Server-side aggregate (no records transferred): counts grouped by fields.
 * Used for usage (requests per catalog item), CMDB population, relationship matrices and fill rates.
 */
export interface Aggregate {
  id: string;
  purpose: string;
  table: string;
  groupBy: string[];
  query?: string;
  rows: GroupCount[];
  error?: string;
}

export interface SnapshotSource {
  kind: 'servicenow-xml' | 'servicenow-live';
  name: string;
  instance?: string;
  release?: string;
  capturedAt: string;
  files?: string[];
}

/** Everything the analyser reads. XML exports and the live instance both produce one. */
export interface Snapshot {
  source: SnapshotSource;
  records: SnRecord[];
  aggregates: Aggregate[];
  warnings: string[];
  /** Records by table. */
  stats: Record<string, number>;
  /** Days covered by usage aggregates (live only). */
  usageDays?: number;
}

export function tableStats(records: SnRecord[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of records) out[r.table] = (out[r.table] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** Parse one or more XML exports / update sets into a single snapshot (records de-duplicated by table + sys_id). */
export function snapshotFromXml(files: { name: string; xml: string }[], capturedAt = new Date().toISOString()): Snapshot {
  const seen = new Set<string>();
  const records: SnRecord[] = [];
  const warnings: string[] = [];
  const names: string[] = [];
  for (const f of files) {
    const r = parseXml(f.xml, f.name);
    names.push(...r.updateSetNames);
    warnings.push(...r.warnings.map((w) => (w.startsWith(f.name) ? w : `${f.name}: ${w}`)));
    for (const rec of r.records) {
      const k = `${rec.table}:${rec.sysId}`;
      if (seen.has(k)) continue;
      seen.add(k);
      records.push(rec);
    }
  }
  return {
    source: { kind: 'servicenow-xml', name: names[0] ?? files.map((f) => f.name).join(', '), capturedAt, files: files.map((f) => f.name) },
    records,
    aggregates: [],
    warnings,
    stats: tableStats(records),
  };
}

/** Combine snapshots (e.g. a live pull plus extra XML exports). Later snapshots win on duplicate records. */
export function mergeSnapshots(snaps: Snapshot[]): Snapshot {
  if (snaps.length === 1) return snaps[0]!;
  const byKey = new Map<string, SnRecord>();
  for (const s of snaps) for (const r of s.records) byKey.set(`${r.table}:${r.sysId}`, r);
  const records = [...byKey.values()];
  const live = snaps.find((s) => s.source.kind === 'servicenow-live');
  return {
    source: { ...(live ?? snaps[0]!).source, name: snaps.map((s) => s.source.name).join(' + '), files: snaps.flatMap((s) => s.source.files ?? []) },
    records,
    aggregates: snaps.flatMap((s) => s.aggregates),
    warnings: snaps.flatMap((s) => s.warnings),
    stats: tableStats(records),
    usageDays: live?.usageDays,
  };
}
