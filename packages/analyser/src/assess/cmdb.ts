import { referenceArtifacts } from '@snjsm/reference';
import type { CiClassFacts, CmdbFacts } from '../cmdb';
import type { AreaAssessment, AssessmentFinding } from './types';
import { findingId, pct } from './types';

/**
 * CMDB rationalisation: map the ServiceNow class model onto Atlassian Assets reference schemas.
 * ServiceNow classes are evidence; the target is the Atlassian reference model. Anything not delivered by a
 * reference object type is an extension and must be justified by population, process usage or relationships.
 */
export type TargetRole =
  | 'hardware' | 'server' | 'network' | 'storage' | 'virtual' | 'cloud' | 'application' | 'database'
  | 'business-application' | 'service' | 'location' | 'person' | 'model' | 'other';

const ROLE_RULES: [RegExp, TargetRole][] = [
  [/service_offering|cmdb_ci_service/, 'service'],
  [/business_app/, 'business-application'],
  [/database|db_|_db$|sql|oracle|mongo/, 'database'],
  [/appl|app_server|web_server|application|software|tomcat|iis|websphere|jboss|weblogic/, 'application'],
  [/cloud|aws|azure|gcp|_account$/, 'cloud'],
  [/vm_|vmware|virtual|hyper_v|container|kubernetes|docker/, 'virtual'],
  [/storage|san|nas|disk/, 'storage'],
  [/netgear|switch|router|firewall|_lb|load_balancer|wap|network|ip_/, 'network'],
  [/server|esx|aix|solaris|mainframe|cluster/, 'server'],
  [/computer|pc_|laptop|desktop|handheld|mobile|tablet|printer|monitor|peripheral|comm|phone|hardware|ups|rack/, 'hardware'],
  [/location/, 'location'],
  [/model/, 'model'],
];

export function roleOf(ciClass: string): TargetRole {
  for (const [re, role] of ROLE_RULES) if (re.test(ciClass)) return role;
  return 'other';
}

/** Which reference artifact (if any) delivers a role today. Unverified artifacts are still references. */
const ROLE_REFERENCE: Partial<Record<TargetRole, string>> = {
  hardware: 'atl.assets.itam.object-type.hardware',
  location: 'atl.assets.itam.object-type.location',
  person: 'atl.assets.itam.object-type.person',
  model: 'atl.assets.itam.object-type.model',
  service: 'atl.assets.template.services',
  'business-application': 'atl.assets.template.services',
};
/** Roles with no reference object type: nearest reference parent for the extension. */
const EXTENSION_PARENT: Partial<Record<TargetRole, string>> = {
  server: 'atl.assets.itam.object-type.hardware', network: 'atl.assets.itam.object-type.hardware', storage: 'atl.assets.itam.object-type.hardware',
};
const ROLE_LABEL: Record<TargetRole, string> = {
  hardware: 'Hardware', server: 'Server', network: 'Network device', storage: 'Storage', virtual: 'Virtual machine', cloud: 'Cloud account',
  application: 'Application / software instance', database: 'Database', 'business-application': 'Business application', service: 'Service',
  location: 'Location', person: 'Person', model: 'Model', other: 'Review',
};

export type ClassDecision = 'map' | 'collapse' | 'drop' | 'review';

export interface ClassPlan {
  ciClass: string;
  population: number;
  role: TargetRole;
  decision: ClassDecision;
  target: string;
  origin: 'reference' | 'reference-configured' | 'extension' | 'none';
  referenceId?: string;
  justification: string[];
  keepAttributes: string[];
  dropAttributes: string[];
  referenceAttributes: string[];
}

const REFERENCE_ATTRS = /(^|_)(model_id|model|location|assigned_to|owned_by|managed_by|support_group|company|manufacturer|vendor|department|cost_center|parent)$/;
const COLLAPSE_BELOW = 10;
const KEEP_FILL = 0.2;

function planClass(c: CiClassFacts, known: Set<string>): ClassPlan {
  const role = roleOf(c.name);
  const refId = ROLE_REFERENCE[role];
  const used = c.processUsage > 0 || c.relationships > 0;
  const justification: string[] = [];
  if (c.count) justification.push(`${c.count} CIs`);
  if (c.processUsage) justification.push(`${c.processUsage} recent tasks reference it`);
  if (c.relationships) justification.push(`${c.relationships} relationships`);
  const attrs = Object.entries(c.fillRates).filter(([k]) => !k.startsWith('sys_') && k !== 'sys_id');
  const keep = attrs.filter(([, v]) => v >= KEEP_FILL).map(([k]) => k);
  const drop = attrs.filter(([, v]) => v < KEEP_FILL).map(([k]) => k);
  const refs = keep.filter((k) => REFERENCE_ATTRS.test(k));

  let decision: ClassDecision;
  if (c.count === 0 && !used) decision = 'drop';
  else if (role === 'other') decision = 'review';
  else if (c.count < COLLAPSE_BELOW && !used) decision = 'collapse';
  else decision = 'map';

  const origin: ClassPlan['origin'] = decision === 'drop' ? 'none' : refId ? (known.has(refId) ? 'reference-configured' : 'extension') : 'extension';
  const target = decision === 'drop' ? '—' : decision === 'collapse' ? `${ROLE_LABEL[role]} (as a "type" attribute value)` : refId ? ROLE_LABEL[role] : `${ROLE_LABEL[role]} (extension${EXTENSION_PARENT[role] ? ' under Hardware' : ''})`;
  if (decision === 'drop') justification.push('no CIs, no process usage, no relationships');
  if (decision === 'collapse') justification.push(`fewer than ${COLLAPSE_BELOW} CIs and unused: not worth its own object type`);
  return { ciClass: c.name, population: c.count, role, decision, target, origin, referenceId: refId ?? EXTENSION_PARENT[role], justification, keepAttributes: keep.filter((k) => !refs.includes(k)), dropAttributes: drop, referenceAttributes: refs };
}

/** CSDM maturity from what exists and what is connected. */
export function csdmLevel(f: CmdbFacts): { level: 'none' | 'crawl' | 'walk' | 'run' | 'fly'; signals: Record<string, number> } {
  const count = (re: RegExp) => f.classes.filter((c) => re.test(c.name)).reduce((n, c) => n + c.count, 0);
  const signals = {
    businessApplications: f.businessApplications,
    applicationServices: count(/cmdb_ci_service_auto|cmdb_ci_service_discovered|cmdb_ci_service_calculated|application_service/),
    businessServices: count(/cmdb_ci_service_business|^cmdb_ci_service$/),
    technicalServices: count(/cmdb_ci_service_technical/),
    serviceOfferings: f.serviceOfferings,
    serviceToInfraRelationships: f.relationships.filter((r) => /service/.test(r.parent) && !/service/.test(r.child)).reduce((n, r) => n + r.count, 0),
  };
  const level = signals.technicalServices && signals.serviceOfferings ? 'fly'
    : signals.businessServices && signals.serviceOfferings ? 'run'
    : signals.applicationServices && signals.serviceToInfraRelationships ? 'walk'
    : signals.businessApplications ? 'crawl' : 'none';
  return { level, signals };
}

/** Atlassian Assets reference types for common ServiceNow relationship types. */
function referenceTypeFor(type: string): string {
  const t = type.toLowerCase();
  if (/depends on/.test(t)) return 'Depends on';
  if (/runs on/.test(t)) return 'Runs on';
  if (/hosted on|virtuali[sz]ed by/.test(t)) return 'Hosted on';
  if (/contains|members|member of/.test(t)) return 'Contains';
  if (/connect|ip connection/.test(t)) return 'Connects to';
  if (/uses|consumes/.test(t)) return 'Uses';
  if (/provid/.test(t)) return 'Provides';
  return 'Link (generic reference)';
}

export function assessCmdb(f: CmdbFacts, evidenceIdOf: (ciClass: string) => string | undefined): AreaAssessment {
  const findings: AssessmentFinding[] = [];
  if (!f.available) {
    return { area: 'cmdb', title: 'CMDB & assets', summary: 'No CMDB metadata or counts in this snapshot. Connect to the live instance to assess the CMDB (metadata and counts only).', metrics: { available: false }, findings: [{ id: findingId('cmdb', 'no-data'), area: 'cmdb', severity: 'info', title: 'CMDB not assessed', detail: 'The snapshot has no CI classes, counts or relationship data.', recommendation: 'Run the live collector: it reads class metadata and server-side counts only, never CI records.', evidenceIds: [] }] };
  }
  const known = new Set(referenceArtifacts().map((a) => a.id));
  const plans = f.classes.filter((c) => c.count > 0 || c.customAttributes.length).map((c) => planClass(c, known));
  const by = (d: ClassDecision) => plans.filter((p) => p.decision === d);
  const populated = f.classes.filter((c) => c.count > 0);
  const empty = f.classes.filter((c) => c.count === 0).length;
  const csdm = csdmLevel(f);
  const relUsed = f.relationships.filter((r) => r.count > 0);
  const refTypes = [...new Set(relUsed.map((r) => referenceTypeFor(r.type)))];
  const allFill = populated.flatMap((c) => Object.values(c.fillRates));
  const avgFill = allFill.length ? Math.round((allFill.reduce((n, v) => n + v, 0) / allFill.length) * 100) : undefined;
  const stale = populated.reduce((n, c) => n + (c.stale ?? 0), 0);
  const manual = f.discoverySources['manual / empty'] ?? 0;

  // Object type targets (deduplicated): what the Assets schema would contain.
  const targets = new Map<string, { label: string; origin: ClassPlan['origin']; referenceId?: string; classes: string[]; population: number }>();
  for (const p of plans.filter((x) => x.decision === 'map' || x.decision === 'collapse')) {
    const key = ROLE_LABEL[p.role];
    const cur = targets.get(key) ?? { label: key, origin: p.origin, referenceId: p.referenceId, classes: [], population: 0 };
    cur.classes.push(p.ciClass);
    cur.population += p.population;
    targets.set(key, cur);
  }

  const buildPasses = [
    { pass: 1, what: 'Object schema(s) from the Atlassian template, then object types (parents before children)', items: [...targets.values()].map((t) => `${t.label} [${t.origin}]`) },
    { pass: 2, what: 'Attributes that are not references (kept: fill rate ≥ 20%)', items: [...new Set(plans.flatMap((p) => p.keepAttributes))].slice(0, 60) },
    { pass: 3, what: 'Reference attributes (after every target object type exists)', items: [...new Set(plans.flatMap((p) => p.referenceAttributes))] },
    { pass: 4, what: 'Reference types for relationships in use', items: refTypes },
    { pass: 5, what: 'Data import (out of scope for the instance build)', items: ['Assets import / Assets Discovery, later phase'] },
  ];

  const ev = (classes: string[]) => classes.map(evidenceIdOf).filter((x): x is string => Boolean(x));
  findings.push({
    id: findingId('cmdb', 'rationalisation'), area: 'cmdb', severity: 'medium',
    title: `${populated.length} populated CI classes rationalise to ${targets.size} Assets object types`,
    detail: `${by('map').length} classes map, ${by('collapse').length} collapse into a parent type, ${by('review').length} need review, and ${empty} empty classes are not carried over.`,
    approach: 'Start from the Atlassian Assets IT asset management and Services templates; add object types only where population, process usage or relationships justify them.',
    effort: targets.size > 12 ? 'L' : 'M', evidenceIds: ev(plans.map((p) => p.ciClass)).slice(0, 25),
  });
  const extensions = [...targets.values()].filter((t) => t.origin === 'extension');
  if (extensions.length) findings.push({ id: findingId('cmdb', 'extensions'), area: 'cmdb', severity: 'medium', title: `${extensions.length} object types are extensions to the reference model`, detail: extensions.map((t) => `${t.label} (${t.population} CIs from ${t.classes.length} class(es))`).join('; '), approach: 'Each extension needs a justification in the blueprint (population, process usage, relationships) and a named owner.', evidenceIds: ev(extensions.flatMap((t) => t.classes)).slice(0, 25) });
  if (by('review').length) findings.push({ id: findingId('cmdb', 'review'), area: 'cmdb', severity: 'low', title: `${by('review').length} classes have no obvious Atlassian target`, detail: by('review').map((p) => p.ciClass).join(', '), recommendation: 'Decide per class: map to an existing type, extend, or drop.', evidenceIds: ev(by('review').map((p) => p.ciClass)) });
  if (avgFill !== undefined && avgFill < 50) findings.push({ id: findingId('cmdb', 'fill-rate'), area: 'cmdb', severity: 'medium', title: `Average attribute fill rate is ${avgFill}%`, detail: 'Sparse attributes are not carried into the Assets schema (threshold 20%).', recommendation: 'Fix data quality at the source before any later import.', evidenceIds: [] });
  if (stale) findings.push({ id: findingId('cmdb', 'stale'), area: 'cmdb', severity: 'low', title: `${stale} CIs not updated for over a year (${pct(stale, f.totalCis)}%)`, detail: 'Stale CIs indicate retired or undiscovered items.', recommendation: 'Exclude stale CIs from any later import.', evidenceIds: [] });
  if (f.totalCis && manual / f.totalCis > 0.5) findings.push({ id: findingId('cmdb', 'manual'), area: 'cmdb', severity: 'low', title: `${pct(manual, f.totalCis)}% of CIs have no discovery source`, detail: 'Most CIs are maintained by hand or by imports.', approach: 'Plan for Assets Discovery or scheduled Assets imports so the new CMDB stays current.', evidenceIds: [] });
  findings.push({ id: findingId('cmdb', 'csdm'), area: 'cmdb', severity: csdm.level === 'none' || csdm.level === 'crawl' ? 'low' : 'info', title: `CSDM maturity: ${csdm.level}`, detail: Object.entries(csdm.signals).map(([k, v]) => `${k} ${v}`).join(', '), approach: 'Model services in the JSM Services / Assets Services schema and link them to infrastructure with reference types; incidents and changes then reference affected services.', evidenceIds: [] });
  if (f.processUsage.length === 0 && f.source === 'aggregate') findings.push({ id: findingId('cmdb', 'unused'), area: 'cmdb', severity: 'medium', title: 'No recent task references a CI', detail: 'Processes do not use the CMDB today.', recommendation: 'Keep the Assets scope minimal (services + end-user hardware) until a process needs more.', evidenceIds: [] });
  if (f.identificationRules.length) findings.push({ id: findingId('cmdb', 'identification'), area: 'cmdb', severity: 'info', title: `${f.identificationRules.length} identification rules`, detail: f.identificationRules.slice(0, 10).map((r) => `${r.ciClass}: ${r.attributes.join(' + ') || '?'}`).join('; '), approach: 'Becomes the unique-attribute / identifier configuration for Assets imports (later phase).', evidenceIds: [] });

  return {
    area: 'cmdb', title: 'CMDB & assets',
    summary: `${f.totalCis} CIs in ${populated.length} populated classes (${empty} empty). Proposed Assets model: ${targets.size} object types, ${refTypes.length} reference types. CSDM: ${csdm.level}.`,
    metrics: { source: f.source, totalCis: f.totalCis, populatedClasses: populated.length, emptyClasses: empty, relationshipPairs: relUsed.length, relationships: relUsed.reduce((n, r) => n + r.count, 0), targetObjectTypes: targets.size, extensions: extensions.length, referenceTypes: refTypes.length, ...(avgFill !== undefined ? { averageFillRate: avgFill } : {}), csdm: csdm.level, services: f.services.length, assets: f.assets.reduce((n, a) => n + a.count, 0), models: f.models.reduce((n, m) => n + m.count, 0), locations: f.locations },
    findings,
    details: { classPlans: plans, objectTypes: [...targets.values()], buildPasses, relationshipMatrix: relUsed.slice(0, 100).map((r) => ({ ...r, referenceType: referenceTypeFor(r.type) })), csdm },
  };
}
