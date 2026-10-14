import type { Evidence, Provenance } from '@snjsm/model';
import { cmdbFacts } from '../cmdb';
import { nameOf } from '../store';
import { provenanceOf, type ExtractContext, type Extractor } from './common';

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 150) || 'x';

function aggProv(ctx: ExtractContext, table: string, locator: string): Provenance {
  return { source: ctx.source, table, locator, capturedAt: ctx.capturedAt };
}

/** CMDB evidence is aggregated: one item per class, relationship class-pair, service, asset class. Never per CI. */
function cmdbEvidence(ctx: ExtractContext): Evidence[] {
  const s = ctx.store;
  const f = cmdbFacts(s);
  if (!f.available) return [];
  const out: Evidence[] = [];
  const base = { usage: {}, relations: [] as Evidence['relations'], attributes: {} as Record<string, unknown> };

  for (const c of f.classes) {
    if (c.count === 0 && !c.customAttributes.length && !/^(u_|x_)/.test(c.name.replace(/^cmdb_ci_/, ''))) continue; // empty OOB classes are only counted
    const sample = s.table(c.name).slice(0, 3);
    out.push({
      ...base,
      id: `sn.ci-class.${slug(c.name)}`, kind: 'ci-class', name: c.label ? `${c.label} (${c.name})` : c.name, domain: 'ITOM',
      custom: /^(cmdb_ci_)?(u_|x_)/.test(c.name) || c.name.startsWith('u_'),
      provenance: sample.length ? sample.map((r) => provenanceOf(r, ctx)) as [Provenance, ...Provenance[]] : [aggProv(ctx, c.name, `count ${c.source}`)],
      usage: { count: c.count, active: c.count > 0 },
      attributes: { ciClass: c.name, parent: c.parent, population: c.count, stale: c.stale, statuses: c.statuses, fillRates: c.fillRates, customAttributes: c.customAttributes, processUsage: c.processUsage, relationships: c.relationships, source: c.source },
      relations: c.parent && c.parent !== 'cmdb_ci' ? [{ type: 'extends', targetId: `sn.ci-class.${slug(c.parent)}` }] : [],
    });
  }
  for (const r of f.relationships.slice(0, 300)) {
    out.push({ ...base, id: `sn.ci-rel.${slug(`${r.parent}.${r.type}.${r.child}`)}`, kind: 'ci-relationship-stat', name: `${r.parent} → ${r.type} → ${r.child}`, domain: 'ITOM', provenance: [aggProv(ctx, 'cmdb_rel_ci', 'relationship class-pair matrix')], usage: { count: r.count }, attributes: { parent: r.parent, type: r.type, child: r.child, count: r.count } });
  }
  for (const t of s.table('cmdb_rel_type')) {
    out.push({ ...base, id: `sn.cmdb_rel_type.${t.sysId}`.toLowerCase(), kind: 'ci-relationship-type', name: nameOf(t), domain: 'ITOM', provenance: [provenanceOf(t, ctx)], usage: { count: f.relationshipTypes.find((x) => x.name === nameOf(t))?.used }, attributes: { parentDescriptor: t.fields['parent_descriptor'] || undefined, childDescriptor: t.fields['child_descriptor'] || undefined } });
  }
  for (const r of s.table('cmdb_identifier')) {
    const rule = f.identificationRules.find((x) => x.ciClass === (r.fields['applies_to'] || s.display(r, 'applies_to') || nameOf(r)));
    out.push({ ...base, id: `sn.cmdb_identifier.${r.sysId}`.toLowerCase(), kind: 'identification-rule', name: nameOf(r), domain: 'ITOM', provenance: [provenanceOf(r, ctx)], attributes: { ciClass: rule?.ciClass, independent: rule?.independent, attributes: rule?.attributes } });
  }
  // Services & business applications are individually meaningful (and usually few).
  const svc = [...s.table('cmdb_ci_service*'), ...s.table('cmdb_ci_business_app'), ...s.table('service_offering')].slice(0, 500);
  for (const r of svc) {
    out.push({
      ...base, id: `sn.${r.table}.${r.sysId}`.toLowerCase(), kind: r.table === 'cmdb_ci_business_app' ? 'business-application' : r.table === 'service_offering' ? 'service-offering' : 'service',
      name: nameOf(r), domain: 'ITOM', provenance: [provenanceOf(r, ctx)], usage: { active: true },
      attributes: { ciClass: r.table, classification: r.fields['service_classification'] || undefined, criticality: r.fields['busines_criticality'] || r.fields['business_criticality'] || undefined, owner: s.display(r, 'owned_by') ? 'set' : undefined, supportGroup: s.display(r, 'support_group') || undefined, parent: s.display(r, 'parent') || undefined },
    });
  }
  for (const a of f.assets) out.push({ ...base, id: `sn.asset-class.${slug(a.ciClass)}`, kind: 'asset-class', name: a.ciClass, domain: 'ITAM', provenance: [aggProv(ctx, a.ciClass, 'asset count')], usage: { count: a.count }, attributes: { assetClass: a.ciClass, population: a.count } });
  for (const m of f.models) out.push({ ...base, id: `sn.model-class.${slug(m.ciClass)}`, kind: 'hardware-model', name: `${m.ciClass} models`, domain: 'ITAM', provenance: [aggProv(ctx, m.ciClass, 'model count')], usage: { count: m.count }, attributes: { modelClass: m.ciClass, population: m.count, sample: [...s.table(m.ciClass)].slice(0, 10).map((r) => nameOf(r)) } });
  return out;
}

export const cmdbExtractors: Extractor[] = [{ name: 'cmdb', tables: [], consumes: ['cmdb_ci*', 'cmdb_rel_ci', 'cmdb_rel_type', 'cmdb_identifier', 'cmdb_identifier_entry', 'cmdb_model', 'cmdb_hardware_product_model', 'cmdb_software_product_model', 'cmdb_consumable_product_model', 'alm_*', 'service_offering', 'cmn_location', 'sys_db_object'], all: cmdbEvidence }];
