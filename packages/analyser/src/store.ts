import type { Aggregate, Snapshot, SnRecord } from '@snjsm/collector';

const SYS_ID = /^[0-9a-f]{32}$/;
const NAME_FIELDS = ['name', 'short_description', 'title', 'label', 'column_label', 'element', 'id', 'api_name', 'number'];

/** OOB authors. Records created by these accounts ship with the platform (or a plugin). */
const VENDOR_AUTHORS = new Set(['system', 'glide.maint', 'fresh', 'glide', 'maint', 'guest', 'snc', 'mid.server']);

/**
 * Indexed view over snapshot records. Reference fields arrive either as sys_ids (real exports / live) with a
 * display value, or as names (hand-made exports); `ref` resolves both.
 */
export class RecordStore {
  private readonly byTable = new Map<string, SnRecord[]>();
  private readonly bySysId = new Map<string, SnRecord>();
  private readonly byName = new Map<string, Map<string, SnRecord[]>>();
  private readonly children = new Map<string, Map<string, SnRecord[]>>();
  readonly aggregates = new Map<string, Aggregate>();

  constructor(readonly snapshot: Snapshot) {
    for (const r of snapshot.records) {
      let list = this.byTable.get(r.table);
      if (!list) this.byTable.set(r.table, (list = []));
      list.push(r);
      if (r.sysId) this.bySysId.set(r.sysId, r);
      let names = this.byName.get(r.table);
      if (!names) this.byName.set(r.table, (names = new Map()));
      const n = nameOf(r).toLowerCase();
      if (n) names.set(n, [...(names.get(n) ?? []), r]);
    }
    for (const a of snapshot.aggregates) this.aggregates.set(a.id, a);
  }

  /** Records in a table (exact) or, with a trailing '*', every table starting with the prefix. */
  table(t: string): SnRecord[] {
    if (!t.endsWith('*')) return this.byTable.get(t) ?? [];
    const p = t.slice(0, -1);
    return [...this.byTable.entries()].filter(([k]) => k.startsWith(p)).flatMap(([, v]) => v);
  }

  tables(): string[] {
    return [...this.byTable.keys()].sort();
  }

  get(sysId: string): SnRecord | undefined {
    return this.bySysId.get(sysId);
  }

  /** Resolve a reference field to a record, by sys_id first and then by (display) name within the target tables. */
  ref(rec: SnRecord, field: string, targets?: string[]): SnRecord | undefined {
    const v = rec.fields[field];
    if (!v) return undefined;
    if (SYS_ID.test(v)) {
      const hit = this.bySysId.get(v);
      if (hit && (!targets || targets.some((t) => matchTable(hit.table, t)))) return hit;
    }
    const name = (rec.fields[`${field}__display`] || v).toLowerCase();
    for (const t of targets ?? [...this.byName.keys()]) {
      if (t.endsWith('*')) {
        for (const [k, m] of this.byName) if (k.startsWith(t.slice(0, -1)) && m.get(name)?.length) return m.get(name)![0];
      } else {
        const hit = this.byName.get(t)?.get(name)?.[0];
        if (hit) return hit;
      }
    }
    return undefined;
  }

  /** Records in `table` whose `field` references `parent` (by sys_id or name). Indexed lazily. */
  childrenOf(table: string, field: string, parent: SnRecord): SnRecord[] {
    const key = `${table}.${field}`;
    let idx = this.children.get(key);
    if (!idx) {
      idx = new Map();
      for (const r of this.table(table)) {
        const v = r.fields[field];
        if (!v) continue;
        for (const k of new Set([v, (r.fields[`${field}__display`] ?? '').toLowerCase(), v.toLowerCase()].filter(Boolean))) idx.set(k, [...(idx.get(k) ?? []), r]);
      }
      this.children.set(key, idx);
    }
    const hits = [...(idx.get(parent.sysId) ?? []), ...(idx.get(nameOf(parent).toLowerCase()) ?? [])];
    return [...new Set(hits)];
  }

  /** Display value of a field (reference display, else raw value). */
  display(rec: SnRecord, field: string): string {
    return rec.fields[`${field}__display`] || rec.fields[field] || '';
  }

  aggregate(id: string): Aggregate | undefined {
    const a = this.aggregates.get(id);
    return a && !a.error ? a : undefined;
  }

  /** Count from an aggregate for a group value (matched against raw value or display). */
  countFor(aggregateId: string, field: string, rec: SnRecord): number | undefined {
    const a = this.aggregate(aggregateId);
    if (!a) return undefined;
    const keys = new Set([rec.sysId, nameOf(rec)].map((k) => k.toLowerCase()));
    return a.rows.filter((r) => keys.has((r.group[field] ?? '').toLowerCase())).reduce((n, r) => n + r.count, 0);
  }

  get hasUsage(): boolean {
    return [...this.aggregates.keys()].some((k) => k.startsWith('usage.'));
  }
}

const matchTable = (actual: string, target: string) => (target.endsWith('*') ? actual.startsWith(target.slice(0, -1)) : actual === target);

export function nameOf(r: SnRecord): string {
  for (const f of NAME_FIELDS) {
    const v = r.fields[f];
    if (v && v.trim()) return v.trim();
  }
  return r.sysId;
}

export const isTrue = (v: string | undefined) => v === 'true' || v === '1' || v === 'yes';
export const isActive = (r: SnRecord) => r.fields['active'] === undefined || r.fields['active'] === '' || isTrue(r.fields['active']) || r.fields['active'] === 'active';

/**
 * Custom (customer-built) vs vendor (shipped by ServiceNow).
 * true  = clearly customer: u_/x_ names, customer scope, or authored by a named user
 * false = clearly vendor: authored by a system account
 * undefined = cannot tell (common in hand-made exports with no audit fields)
 */
export function isCustom(r: SnRecord): boolean | undefined {
  const name = `${r.fields['name'] ?? ''} ${r.fields['element'] ?? ''} ${r.fields['api_name'] ?? ''}`;
  if (/(^|[\s.])(u_|x_)/.test(name)) return true;
  const scope = r.fields['sys_scope__display'] || r.fields['sys_scope'] || '';
  if (/^x_/.test(scope) || /^x_/.test(r.fields['sys_scope.scope'] ?? '')) return true;
  const by = (r.fields['sys_created_by'] ?? '').toLowerCase();
  if (by) return !VENDOR_AUTHORS.has(by);
  const pkg = (r.fields['sys_package__display'] || r.fields['sys_package'] || '').toLowerCase();
  if (pkg && pkg !== 'global') return pkg.startsWith('x_') || undefined;
  return undefined;
}

/** Stable evidence id for a record. */
export const evidenceId = (r: SnRecord) => `sn.${r.table}.${r.sysId}`.toLowerCase().replace(/[^a-z0-9._:-]/g, '-');
