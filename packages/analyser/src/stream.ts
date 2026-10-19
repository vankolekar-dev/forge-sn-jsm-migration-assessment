import { INDEX_FIELDS, tableStats, type Aggregate, type Snapshot, type SnRecord } from '@snjsm/collector';
import type { ExtractContext } from './extract/common';
import { moneyThresholds, TEXT_FIELDS } from './params';
import { RecordStore } from './store';

/**
 * Streamed collection: the script-heavy tables (collector STREAMED_TABLES) are turned into evidence page by page and
 * only a stub of each record is kept for the final analysis. A stub holds what the rest of the analysis reads from
 * those records: names (reference lookups) and the text that parameter resolution scans for cost thresholds.
 */
export function stubOf(r: SnRecord): SnRecord {
  const fields: Record<string, string> = {};
  for (const f of INDEX_FIELDS) if (r.fields[f] !== undefined) fields[f] = r.fields[f]!;
  for (const f of TEXT_FIELDS) { const v = r.fields[f]; if (v && v.trim() && moneyThresholds(v).length) fields[f] = v; }
  return { table: r.table, sysId: r.sysId, fields };
}

export interface StreamSource { instance: string; capturedAt: string; usageDays: number }

/** Extraction context for streamed pages: the context tables and name indexes collected so far, and the counts. */
export function streamContext(records: SnRecord[], aggregates: Aggregate[], src: StreamSource): ExtractContext {
  const host = src.instance.replace(/^https:\/\//, '');
  const snapshot: Snapshot = { source: { kind: 'servicenow-live', name: host, instance: host, capturedAt: src.capturedAt }, records, aggregates, warnings: [], stats: tableStats(records), usageDays: src.usageDays };
  return { store: new RecordStore(snapshot), source: 'servicenow-live', capturedAt: src.capturedAt, instanceUrl: `https://${host}` };
}
