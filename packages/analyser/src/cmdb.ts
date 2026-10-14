import type { SnRecord } from '@snjsm/collector';
import { RecordStore, nameOf } from './store';

/**
 * CMDB facts: metadata + aggregate counts. Live snapshots provide counts via aggregates (no CI records);
 * XML snapshots that happen to contain CI records are counted locally. Nothing here is migrated.
 */
export interface CiClassFacts {
  name: string;
  label?: string;
  parent?: string;
  count: number;
  stale?: number;
  statuses?: Record<string, number>;
  fillRates: Record<string, number>;
  customAttributes: string[];
  processUsage: number;
  relationships: number;
  source: 'aggregate' | 'records' | 'metadata';
}

export interface RelationshipFacts { parent: string; type: string; child: string; count: number }

export interface CmdbFacts {
  available: boolean;
  source: 'aggregate' | 'records' | 'none';
  totalCis: number;
  classes: CiClassFacts[];
  relationships: RelationshipFacts[];
  relationshipTypes: { name: string; used: number }[];
  identificationRules: { ciClass: string; independent?: boolean; attributes: string[] }[];
  processUsage: { process: string; ciClass: string; count: number }[];
  discoverySources: Record<string, number>;
  services: { name: string; ciClass: string; classification?: string }[];
  businessApplications: number;
  serviceOfferings: number;
  assets: { ciClass: string; count: number }[];
  models: { ciClass: string; count: number }[];
  locations: number;
}

/** Fallback hierarchy for common classes when sys_db_object is not in the snapshot. */
const KNOWN_PARENT: Record<string, string> = {
  cmdb_ci_hardware: 'cmdb_ci', cmdb_ci_computer: 'cmdb_ci_hardware', cmdb_ci_pc_hardware: 'cmdb_ci_computer', cmdb_ci_server: 'cmdb_ci_computer',
  cmdb_ci_linux_server: 'cmdb_ci_server', cmdb_ci_win_server: 'cmdb_ci_server', cmdb_ci_unix_server: 'cmdb_ci_server', cmdb_ci_esx_server: 'cmdb_ci_server', cmdb_ci_aix_server: 'cmdb_ci_server',
  cmdb_ci_netgear: 'cmdb_ci_hardware', cmdb_ci_ip_switch: 'cmdb_ci_netgear', cmdb_ci_ip_router: 'cmdb_ci_netgear', cmdb_ci_ip_firewall: 'cmdb_ci_netgear', cmdb_ci_firewall: 'cmdb_ci_netgear', cmdb_ci_lb: 'cmdb_ci_netgear',
  cmdb_ci_storage_device: 'cmdb_ci_hardware', cmdb_ci_storage: 'cmdb_ci_hardware', cmdb_ci_printer: 'cmdb_ci_hardware', cmdb_ci_comm: 'cmdb_ci_hardware', cmdb_ci_handheld_computing: 'cmdb_ci_hardware',
  cmdb_ci_vm_object: 'cmdb_ci', cmdb_ci_vm_instance: 'cmdb_ci_vm_object', cmdb_ci_vmware_instance: 'cmdb_ci_vm_instance',
  cmdb_ci_appl: 'cmdb_ci', cmdb_ci_app_server: 'cmdb_ci_appl', cmdb_ci_web_server: 'cmdb_ci_app_server', cmdb_ci_database: 'cmdb_ci', cmdb_ci_db_instance: 'cmdb_ci_appl',
  cmdb_ci_service: 'cmdb_ci', cmdb_ci_service_business: 'cmdb_ci_service', cmdb_ci_service_technical: 'cmdb_ci_service', cmdb_ci_service_auto: 'cmdb_ci_service', cmdb_ci_service_discovered: 'cmdb_ci_service_auto',
  cmdb_ci_business_app: 'cmdb_ci', cmdb_ci_cloud_service_account: 'cmdb_ci', cmdb_ci_logical_datacenter: 'cmdb_ci', cmdb_ci_cluster: 'cmdb_ci',
};

const SERVICE_CLASS = /^cmdb_ci_service/;

export function parentOf(store: RecordStore, cls: string): string | undefined {
  const obj = store.table('sys_db_object').find((r) => r.fields['name'] === cls);
  const sup = obj ? store.display(obj, 'super_class') : '';
  if (sup) {
    const supObj = store.get(obj!.fields['super_class'] ?? '');
    return supObj?.fields['name'] || sup;
  }
  return KNOWN_PARENT[cls] ?? (cls.startsWith('cmdb_ci_') ? 'cmdb_ci' : undefined);
}

/** Ancestors from the class up to cmdb_ci. */
export function lineage(store: RecordStore, cls: string): string[] {
  const out = [cls];
  for (let c = parentOf(store, cls), i = 0; c && i < 12; c = parentOf(store, c), i++) out.push(c);
  return out;
}

export function cmdbFacts(store: RecordStore): CmdbFacts {
  const popAgg = store.aggregate('cmdb.ci-by-class');
  const ciRecords = store.table('cmdb_ci*').filter((r) => r.table !== 'cmdb_rel_ci' && r.table !== 'cmdb_rel_type' && r.table !== 'cmdb_identifier' && r.table !== 'cmdb_identifier_entry' && r.table !== 'cmdb_model');
  const source: CmdbFacts['source'] = popAgg ? 'aggregate' : ciRecords.length ? 'records' : 'none';
  const dict = store.table('sys_dictionary');

  // Population
  const counts = new Map<string, number>();
  if (popAgg) for (const r of popAgg.rows) counts.set(r.group['sys_class_name'] ?? 'unknown', r.count);
  else for (const r of ciRecords) counts.set(r.table, (counts.get(r.table) ?? 0) + 1);
  // Classes defined in metadata but empty still matter (they show model sprawl).
  for (const o of store.table('sys_db_object')) {
    const n = o.fields['name'] ?? '';
    if (n.startsWith('cmdb_ci') && !counts.has(n)) counts.set(n, 0);
  }

  // Relationships
  const relationships: RelationshipFacts[] = [];
  const relAgg = store.aggregate('cmdb.rel-matrix');
  if (relAgg) {
    for (const r of relAgg.rows) relationships.push({ parent: r.group['parent.sys_class_name'] ?? '?', type: r.group['type'] ?? '?', child: r.group['child.sys_class_name'] ?? '?', count: r.count });
  } else {
    const m = new Map<string, RelationshipFacts>();
    for (const rel of store.table('cmdb_rel_ci')) {
      const p = store.ref(rel, 'parent', ['cmdb_ci*']);
      const c = store.ref(rel, 'child', ['cmdb_ci*']);
      const type = store.display(rel, 'type') || '?';
      const key = `${p?.table ?? '?'}|${type}|${c?.table ?? '?'}`;
      const cur = m.get(key) ?? { parent: p?.table ?? '?', type, child: c?.table ?? '?', count: 0 };
      cur.count++;
      m.set(key, cur);
    }
    relationships.push(...m.values());
  }
  const relTypeNames = new Set(store.table('cmdb_rel_type').map((r) => nameOf(r)));
  const relationshipTypes = [...new Set([...relTypeNames, ...relationships.map((r) => r.type)])].map((name) => ({ name, used: relationships.filter((r) => r.type === name).reduce((n, r) => n + r.count, 0) }));

  // Process usage
  const processUsage: CmdbFacts['processUsage'] = [];
  for (const id of ['cmdb.task-ci-usage', 'cmdb.affected-ci-usage']) {
    const a = store.aggregate(id);
    if (!a) continue;
    const [pf, cf] = a.groupBy as [string, string];
    for (const r of a.rows) processUsage.push({ process: r.group[pf] ?? '?', ciClass: r.group[cf] ?? '?', count: r.count });
  }

  // Fill rates
  const fill = (cls: string, recs: SnRecord[]): Record<string, number> => {
    const a = store.aggregate(`cmdb.fill.${cls}`);
    if (a) {
      const total = a.rows.find((r) => r.group['attribute'] === '__total')?.count ?? 0;
      return Object.fromEntries(a.rows.filter((r) => r.group['attribute'] !== '__total' && total > 0).map((r) => [r.group['attribute']!, round(r.count / total)]));
    }
    if (!recs.length) return {};
    const keys = new Set(recs.flatMap((r) => Object.keys(r.fields).filter((k) => !k.endsWith('__display') && !k.startsWith('sys_'))));
    return Object.fromEntries([...keys].map((k) => [k, round(recs.filter((r) => (r.fields[k] ?? '').trim() !== '').length / recs.length)]));
  };
  const staleAgg = store.aggregate('cmdb.ci-stale');
  const statusAgg = store.aggregate('cmdb.ci-by-class-status');

  const classes: CiClassFacts[] = [...counts.entries()].map(([name, count]): CiClassFacts => {
    const recs = source === 'records' ? ciRecords.filter((r) => r.table === name) : [];
    const obj = store.table('sys_db_object').find((r) => r.fields['name'] === name);
    const statuses = statusAgg ? Object.fromEntries(statusAgg.rows.filter((r) => r.group['sys_class_name'] === name).map((r) => [r.group['operational_status'] || 'empty', r.count])) : recs.length ? tally(recs.map((r) => r.fields['operational_status'] || 'empty')) : undefined;
    return {
      name, label: obj?.fields['label'] || undefined, parent: parentOf(store, name), count,
      stale: staleAgg?.rows.find((r) => r.group['sys_class_name'] === name)?.count,
      statuses: statuses && Object.keys(statuses).length ? statuses : undefined,
      fillRates: fill(name, recs),
      customAttributes: dict.filter((d) => d.fields['name'] === name && /^(u_|x_)/.test(d.fields['element'] ?? '')).map((d) => d.fields['element']!),
      processUsage: processUsage.filter((p) => p.ciClass === name).reduce((n, p) => n + p.count, 0),
      relationships: relationships.filter((r) => r.parent === name || r.child === name).reduce((n, r) => n + r.count, 0),
      source: count === 0 ? 'metadata' : source === 'aggregate' ? 'aggregate' : 'records',
    };
  }).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const ids = store.table('cmdb_identifier').map((r) => ({
    ciClass: r.fields['applies_to'] || store.display(r, 'applies_to') || nameOf(r),
    independent: r.fields['independent'] ? r.fields['independent'] === 'true' : undefined,
    attributes: store.childrenOf('cmdb_identifier_entry', 'identifier', r).flatMap((e) => (e.fields['criterion_attributes'] ?? '').split(',')).map((x) => x.trim()).filter(Boolean),
  }));

  const discoverySources: Record<string, number> = {};
  const dAgg = store.aggregate('cmdb.ci-by-discovery');
  if (dAgg) for (const r of dAgg.rows) discoverySources[r.group['discovery_source'] || 'manual / empty'] = r.count;
  else for (const r of ciRecords) discoverySources[r.fields['discovery_source'] || 'manual / empty'] = (discoverySources[r.fields['discovery_source'] || 'manual / empty'] ?? 0) + 1;

  const services = [...ciRecords.filter((r) => SERVICE_CLASS.test(r.table)).map((r) => ({ name: nameOf(r), ciClass: r.table, classification: r.fields['service_classification'] || undefined }))];
  const svcAgg = store.aggregate('cmdb.services');
  const assetsAgg = store.aggregate('assets.by-class');
  const modelsAgg = store.aggregate('assets.models');
  const tallyBy = (rows: { group: Record<string, string>; count: number }[], f: string) => Object.entries(rows.reduce<Record<string, number>>((m, r) => ((m[r.group[f] ?? '?'] = (m[r.group[f] ?? '?'] ?? 0) + r.count), m), {})).map(([ciClass, count]) => ({ ciClass, count }));
  const totalCis = [...counts.values()].reduce((n, c) => n + c, 0);
  return {
    available: source !== 'none' || store.table('cmdb_rel_type').length > 0,
    source, totalCis, classes, relationships: relationships.sort((a, b) => b.count - a.count), relationshipTypes, identificationRules: ids, processUsage, discoverySources,
    services: services.length ? services : (svcAgg?.rows ?? []).map((r) => ({ name: `${r.count} × ${r.group['sys_class_name']}`, ciClass: r.group['sys_class_name'] ?? '?', classification: r.group['service_classification'] })),
    businessApplications: counts.get('cmdb_ci_business_app') ?? 0,
    serviceOfferings: store.aggregate('cmdb.service-offerings')?.rows.reduce((n, r) => n + r.count, 0) ?? store.table('service_offering').length,
    assets: assetsAgg ? tallyBy(assetsAgg.rows, 'sys_class_name') : Object.entries(tally(store.table('alm_*').map((r) => r.table))).map(([ciClass, count]) => ({ ciClass, count })),
    models: modelsAgg ? tallyBy(modelsAgg.rows, 'sys_class_name') : Object.entries(tally([...store.table('cmdb_model'), ...store.table('cmdb_hardware_product_model'), ...store.table('cmdb_software_product_model')].map((r) => r.table))).map(([ciClass, count]) => ({ ciClass, count })),
    locations: store.aggregate('locations')?.rows.reduce((n, r) => n + r.count, 0) ?? store.table('cmn_location').length,
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;
const tally = (xs: string[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {});
