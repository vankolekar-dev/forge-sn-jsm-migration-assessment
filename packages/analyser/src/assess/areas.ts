import type { Evidence } from '@snjsm/model';
import type { ScriptAnalysis } from '../script';
import type { RecordStore } from '../store';
import { fmtMinutes } from '../extract/ops';
import { practiceOf } from '../extract/common';
import type { AreaAssessment, AssessmentFinding, AreaId, Severity } from './types';
import { findingId, pct, sample } from './types';

type Ev = Evidence;
const ids = (xs: Ev[]) => xs.map((e) => e.id);
const attr = <T = unknown>(e: Ev, k: string) => e.attributes[k] as T | undefined;
const scriptOf = (e: Ev) => attr<ScriptAnalysis>(e, 'script');
const active = (e: Ev) => e.usage?.active !== false;
const tally = (xs: (string | undefined)[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x ?? '—'] = (m[x ?? '—'] ?? 0) + 1), m), {});
const top = (m: Record<string, number>, n = 8) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} (${v})`).join(', ');

function f(area: AreaId, slug: string, severity: Severity, title: string, detail: string, evidence: Ev[] | string[], extra: Partial<AssessmentFinding> = {}): AssessmentFinding {
  return { id: findingId(area, slug), area, severity, title, detail, evidenceIds: sample(typeof evidence[0] === 'string' ? (evidence as string[]) : ids(evidence as Ev[])), ...extra };
}

export interface AreaInput { evidence: Ev[]; store: RecordStore; hasUsage: boolean }

// ── Inventory ────────────────────────────────────────────────────────────

export function assessInventory({ evidence, store }: AreaInput): AreaAssessment {
  const kinds = tally(evidence.map((e) => e.kind));
  const custom = evidence.filter((e) => e.custom === true).length;
  const vendor = evidence.filter((e) => e.custom === false).length;
  const inactive = evidence.filter((e) => !active(e));
  const domains = tally(evidence.map((e) => e.domain));
  const s = store.snapshot;
  return {
    area: 'inventory', title: 'Inventory',
    summary: `${s.records.length} records from ${Object.keys(s.stats).length} tables became ${evidence.length} evidence items. ${custom} customer-built, ${vendor} vendor, ${evidence.length - custom - vendor} unknown origin.`,
    metrics: { records: s.records.length, tables: Object.keys(s.stats).length, evidence: evidence.length, custom, vendor, unknownOrigin: evidence.length - custom - vendor, inactive: inactive.length, ...Object.fromEntries(Object.entries(domains).map(([d, n]) => [`domain:${d}`, n])) },
    findings: [
      ...(inactive.length ? [f('inventory', 'inactive', 'info', `${inactive.length} inactive artifacts`, 'Inactive configuration is not migrated; it is listed for completeness.', inactive, { recommendation: 'Exclude from scope.' })] : []),
      ...(evidence.length - custom - vendor > evidence.length / 2 ? [f('inventory', 'origin-unknown', 'low', 'Origin (custom vs vendor) unknown for most artifacts', 'The export has no audit fields (sys_created_by / sys_scope). Customisation figures are estimates.', [], { recommendation: 'Use the live collector or include audit fields in exports.' })] : []),
    ],
    details: { kinds, tables: s.stats },
  };
}

// ── Catalog ──────────────────────────────────────────────────────────────

export function assessCatalog({ evidence, store, hasUsage }: AreaInput): AreaAssessment {
  const period = store.snapshot.usageDays ? `${store.snapshot.usageDays} days` : 'usage window';
  const items = evidence.filter((e) => e.kind === 'catalog-item' && active(e));
  const producers = evidence.filter((e) => e.kind === 'record-producer' && active(e));
  const guides = evidence.filter((e) => e.kind === 'order-guide' && active(e));
  const vars = evidence.filter((e) => e.kind === 'catalog-variable');
  const all = [...items, ...producers, ...guides];
  const used = hasUsage ? all.filter((e) => (e.usage?.count ?? 0) > 0) : all;
  const unused = hasUsage ? all.filter((e) => (e.usage?.count ?? 0) === 0) : [];
  const groups = new Map<string, Ev[]>();
  for (const e of all) { const g = attr<string>(e, 'duplicateGroup'); if (g) groups.set(g, [...(groups.get(g) ?? []), e]); }
  const categories = tally(all.map((e) => attr<string>(e, 'category')));
  const unsupported = vars.filter((v) => attr(v, 'jsmFieldKind') === 'unsupported');
  const assetsVars = vars.filter((v) => String(attr(v, 'jsmFieldKind') ?? '').startsWith('assets-object'));
  const priced = all.filter((e) => (attr<number>(e, 'price') ?? 0) > 0);
  // Estimate of request types after redesign: duplicates collapse, unused retire, categories with many similar items collapse.
  const estimate = Math.max(1, used.length - [...groups.values()].reduce((n, g) => n + g.filter((x) => used.includes(x)).length - 1, 0));
  const findings: AssessmentFinding[] = [];
  if (groups.size) findings.push(f('catalog', 'duplicates', 'medium', `${[...groups.values()].reduce((n, g) => n + g.length, 0)} catalog items fall into ${groups.size} near-identical group(s)`, [...groups.values()].slice(0, 5).map((g) => `${g.length} × e.g. "${g[0]!.name}"`).join('; '), [...groups.values()].flat(), { approach: 'One JSM request type per group, with a field (often an Assets object picker) for the variant.', effort: 'M' }));
  if (unused.length) findings.push(f('catalog', 'unused', 'low', `${unused.length} items had no requests in the last ${period}`, 'Unused items are retire candidates.', unused, { recommendation: 'Confirm with the service owner, then exclude from scope.' }));
  if (guides.length) findings.push(f('catalog', 'order-guides', 'medium', `${guides.length} order guides`, 'JSM has no order guide (multi-item bundle).', guides, { approach: 'One request type with a form; automation creates the linked fulfilment work items per selection.', effort: 'M' }));
  if (unsupported.length) findings.push(f('catalog', 'unsupported-variables', 'medium', `${unsupported.length} variables have no direct JSM field`, top(tally(unsupported.map((v) => attr<string>(v, 'type'))), 5), unsupported, { approach: 'Redesign: JSM Forms (sections, tables, conditional logic) or split into simpler questions; custom UI only via Forge if truly needed.' }));
  if (assetsVars.length) findings.push(f('catalog', 'assets-variables', 'info', `${assetsVars.length} variables pick CMDB / asset records`, 'These become Assets object fields on request types (requires the Assets schema first).', assetsVars, { approach: 'Assets object custom field with an AQL filter.' }));
  if (priced.length) findings.push(f('catalog', 'pricing', 'low', `${priced.length} items carry a price`, 'JSM has no catalogue pricing or cart.', priced, { approach: 'Store cost on the Assets model object; approval rules compare it with a threshold.' }));
  if (producers.length) findings.push(f('catalog', 'record-producers', 'info', `${producers.length} record producers`, `Target tables: ${top(tally(producers.map((p) => attr<string>(p, 'targetTable'))))}`, producers, { approach: 'Request types on the matching work type (e.g. Incident).' }));
  return {
    area: 'catalog', title: 'Service catalog',
    summary: `${items.length} active items, ${producers.length} record producers, ${guides.length} order guides, ${vars.length} questions. Estimated ${estimate} JSM request types after collapsing duplicates${hasUsage ? ' and retiring unused items' : ''}.`,
    metrics: { items: items.length, recordProducers: producers.length, orderGuides: guides.length, variables: vars.length, duplicateGroups: groups.size, unused: unused.length, estimatedRequestTypes: estimate, categories: Object.keys(categories).length, assetsVariables: assetsVars.length, unsupportedVariables: unsupported.length },
    findings,
    details: { categories, variableTypes: tally(vars.map((v) => attr<string>(v, 'jsmFieldKind'))) },
  };
}

// ── Process logic ────────────────────────────────────────────────────────

export function assessProcess({ evidence }: AreaInput): AreaAssessment {
  const flows = evidence.filter((e) => (e.kind === 'flow' || e.kind === 'subflow') && active(e));
  const wfs = evidence.filter((e) => e.kind === 'legacy-workflow' && active(e));
  const all = [...flows, ...wfs];
  const kinds = tally(all.flatMap((e) => attr<string[]>(e, 'stepKinds') ?? []));
  const byPractice = tally(all.map((e) => practiceOf(attr<string>(e, 'table')) ?? 'unknown'));
  const withApprovals = all.filter((e) => (attr<number>(e, 'approvals') ?? 0) > 0);
  const withIntegrations = all.filter((e) => (attr<string[]>(e, 'integrations') ?? []).length || (attr<string[]>(e, 'stepKinds') ?? []).includes('integration'));
  const custom = flows.filter((e) => (attr<string[]>(e, 'customActions') ?? []).length);
  const findings: AssessmentFinding[] = [];
  if (wfs.length) findings.push(f('process', 'legacy-workflows', 'medium', `${wfs.length} legacy workflows still active`, `Tables: ${top(tally(wfs.map((w) => attr<string>(w, 'table'))))}`, wfs, { approach: 'Redesign as JSM workflows (statuses + approvals) plus automation rules; do not replicate activity-by-activity.', effort: wfs.length > 10 ? 'L' : 'M' }));
  if (withApprovals.length) findings.push(f('process', 'approvals', 'info', `${withApprovals.length} processes request approvals`, 'Approvals become workflow approval steps with approvers set by automation (manager, Assets owner, group).', withApprovals, { approach: 'JSM approval step on a status + "Approvers" field populated by automation.' }));
  if (withIntegrations.length) findings.push(f('process', 'integration-steps', 'high', `${withIntegrations.length} processes call external systems`, withIntegrations.slice(0, 5).map((e) => e.name).join(', '), withIntegrations, { approach: 'Automation "Send web request", Atlassian integrations, or a Forge app; credentials move to the integration layer.', effort: 'L' }));
  if (custom.length) findings.push(f('process', 'custom-actions', 'medium', `${custom.length} flows use custom actions`, top(tally(custom.flatMap((e) => attr<string[]>(e, 'customActions') ?? []))), custom, { approach: 'Map each action to an automation action or a Forge automation action.' }));
  return {
    area: 'process', title: 'Process logic (flows & workflows)',
    summary: `${flows.length} flows/subflows and ${wfs.length} legacy workflows. Step mix: ${top(kinds)}.`,
    metrics: { flows: flows.length, legacyWorkflows: wfs.length, withApprovals: withApprovals.length, withIntegrations: withIntegrations.length, ...Object.fromEntries(Object.entries(byPractice).map(([k, v]) => [`practice:${k}`, v])) },
    findings, details: { stepKinds: kinds },
  };
}

// ── Customisation (scripts) ──────────────────────────────────────────────

const SCRIPTED = new Set(['business-rule', 'client-script', 'ui-script', 'script-include', 'ui-action', 'ui-policy', 'scheduled-job', 'acl', 'portal-widget', 'inbound-email-action', 'record-producer', 'transform-map']);

/** What each script pattern becomes in Atlassian (redesign). */
export const PATTERN_APPROACH: Record<string, string> = {
  validation: 'Forms validation / workflow validators',
  abort: 'Workflow validators or conditions',
  'field-default': 'Request type field defaults or automation "Edit work item"',
  calculation: 'Automation smart values / math expressions',
  'auto-assignment': 'Automation + Teams, queues',
  approval: 'Workflow approval steps + automation for approvers',
  notification: 'JSM customer notifications or automation "Send email"',
  integration: 'Automation "Send web request", Atlassian integrations or Forge',
  'cascade-update': 'Automation with related work items / branches',
  'record-creation': 'Automation "Create work item" (linked)',
  'record-deletion': 'Usually retire; otherwise automation with care',
  visibility: 'Forms conditional sections',
  mandatory: 'Request type required fields / Forms required questions',
  'read-only': 'Field configuration / screens (agent view)',
  message: 'Request type help text / Forms descriptions',
  'access-check': 'Permission scheme, request type restrictions, issue security',
  'choice-manipulation': 'Cascading select or Forms conditional choices',
  'logging-only': 'Retire',
  scheduling: 'Automation scheduled triggers / SLA calendars',
  'data-lookup': 'Automation lookup tables',
};

export function assessCustomisation({ evidence }: AreaInput): AreaAssessment {
  const scripts = evidence.filter((e) => SCRIPTED.has(e.kind) && scriptOf(e) && active(e));
  const lines = scripts.reduce((n, e) => n + (scriptOf(e)!.lines ?? 0), 0);
  const risk = tally(scripts.map((e) => attr<string>(e, 'risk')));
  const patterns = tally(scripts.flatMap((e) => scriptOf(e)!.patterns));
  const anti = tally(scripts.flatMap((e) => scriptOf(e)!.antiPatterns));
  const high = scripts.filter((e) => attr(e, 'risk') === 'high');
  const sysIds = scripts.filter((e) => scriptOf(e)!.hardcodedSysIds > 0);
  const creds = scripts.filter((e) => scriptOf(e)!.antiPatterns.includes('hardcoded-credentials'));
  const retire = scripts.filter((e) => scriptOf(e)!.patterns.length === 0 || (scriptOf(e)!.patterns.length === 1 && scriptOf(e)!.patterns[0] === 'logging-only'));
  const hotspots = evidence.filter((e) => (attr<number>(e, 'usedBy') ?? 0) > 2).sort((a, b) => (attr<number>(b, 'usedBy') ?? 0) - (attr<number>(a, 'usedBy') ?? 0));
  const findings: AssessmentFinding[] = [
    f('customisation', 'patterns', 'info', `${scripts.length} active scripts (${lines} lines): what they do`, Object.entries(patterns).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n} → ${PATTERN_APPROACH[p] ?? 'review'}`).join('; '), scripts, { approach: 'Rebuild the behaviour with native configuration and automation; scripts are not ported.' }),
  ];
  if (high.length) findings.push(f('customisation', 'high-risk', 'high', `${high.length} high-complexity scripts`, high.slice(0, 8).map((e) => e.name).join(', '), high, { recommendation: 'Workshop each one with the owner: confirm the outcome, then choose configuration, automation or Forge.', effort: 'L' }));
  if (creds.length) findings.push(f('customisation', 'credentials', 'blocker', `${creds.length} scripts appear to contain credentials`, creds.map((e) => e.name).join(', '), creds, { recommendation: 'Rotate these secrets now; never carry them into automation rules.' }));
  if (sysIds.length) findings.push(f('customisation', 'sys-ids', 'medium', `${sysIds.length} scripts hard-code sys_ids`, 'Hard-coded record ids encode hidden business rules (specific groups, users, items).', sysIds, { recommendation: 'Resolve each id to the record it means and restate the rule as an outcome.' }));
  if (Object.keys(anti).length) findings.push(f('customisation', 'anti-patterns', 'low', 'Script anti-patterns', top(anti, 10), scripts.filter((e) => scriptOf(e)!.antiPatterns.length), { recommendation: 'Evidence of technical debt; none of it is carried over.' }));
  if (retire.length) findings.push(f('customisation', 'retire', 'low', `${retire.length} scripts with no detectable business behaviour`, 'Logging-only or empty logic.', retire, { recommendation: 'Retire.' }));
  if (hotspots.length) findings.push(f('customisation', 'hotspots', 'medium', `${hotspots.length} shared dependencies (script includes / integrations used by many scripts)`, hotspots.slice(0, 8).map((e) => `${e.name} (${attr(e, 'usedBy')})`).join(', '), hotspots));
  return {
    area: 'customisation', title: 'Customisation (scripts)',
    summary: `${scripts.length} active scripts, ${lines} lines. Risk: ${top(risk)}. Each is evidence of a business behaviour to redesign, not code to port.`,
    metrics: { scripts: scripts.length, lines, highRisk: high.length, mediumRisk: risk['medium'] ?? 0, hardcodedSysIds: sysIds.length, credentials: creds.length, retireCandidates: retire.length, ...Object.fromEntries(Object.entries(tally(scripts.map((e) => e.kind))).map(([k, v]) => [`kind:${k}`, v])) },
    findings, details: { patterns, antiPatterns: anti, risk },
  };
}

// ── Routing & teams ──────────────────────────────────────────────────────

export function assessRouting({ evidence, hasUsage }: AreaInput): AreaAssessment {
  const rules = evidence.filter((e) => e.kind === 'assignment-rule' && active(e));
  const groups = evidence.filter((e) => e.kind === 'group');
  const fulfilment = [...new Set(evidence.filter((e) => e.kind === 'catalog-item').map((e) => attr<string>(e, 'fulfilmentGroup')).filter(Boolean))];
  const assignScripts = evidence.filter((e) => scriptOf(e)?.patterns.includes('auto-assignment'));
  const working = hasUsage ? groups.filter((g) => (g.usage?.count ?? 0) > 0) : groups;
  const idle = hasUsage ? groups.filter((g) => (g.usage?.count ?? 0) === 0) : [];
  const findings: AssessmentFinding[] = [];
  if (groups.length) findings.push(f('routing', 'teams', 'info', `${working.length} groups do work${hasUsage ? '' : ' (usage unknown)'}`, 'Working groups become Atlassian Teams used for routing and queues; group membership is not migrated.', working, { approach: 'Atlassian Teams + "Team" field + queues per team.' }));
  if (idle.length) findings.push(f('routing', 'idle-groups', 'low', `${idle.length} groups had no assigned work`, 'Retire candidates.', idle));
  if (rules.length + assignScripts.length) findings.push(f('routing', 'rules', 'medium', `${rules.length} assignment rules and ${assignScripts.length} scripts assign work`, rules.slice(0, 5).map((r) => r.intent).join('; '), [...rules, ...assignScripts], { approach: 'One automation rule per routing outcome ("route to the owning team"), driven by request type / category / Assets owner.' }));
  return {
    area: 'routing', title: 'Routing & teams',
    summary: `${groups.length} groups (${working.length} active), ${rules.length} assignment rules, ${fulfilment.length} named fulfilment groups on catalog items.`,
    metrics: { groups: groups.length, workingGroups: working.length, idleGroups: idle.length, assignmentRules: rules.length, assignmentScripts: assignScripts.length, fulfilmentGroups: fulfilment.length },
    findings, details: { fulfilmentGroups: fulfilment },
  };
}

// ── Service levels ───────────────────────────────────────────────────────

export function assessServiceLevels({ evidence }: AreaInput): AreaAssessment {
  const slas = evidence.filter((e) => e.kind === 'sla-definition' && active(e));
  const schedules = evidence.filter((e) => e.kind === 'schedule');
  const byTable = new Map<string, Ev[]>();
  for (const s of slas) { const t = attr<string>(s, 'table') ?? 'unknown'; byTable.set(t, [...(byTable.get(t) ?? []), s]); }
  const metrics = new Set(slas.map((s) => `${attr(s, 'table') ?? '?'}:${attr(s, 'purpose')}`)).size;
  const olas = slas.filter((s) => /ola|underpinning/i.test(String(attr(s, 'type') ?? '')));
  const breaching = slas.filter((s) => (attr<number>(s, 'breachRate') ?? 0) > 0.2);
  const unparsed = slas.filter((s) => attr(s, 'durationMinutes') === undefined && attr(s, 'durationType') === undefined);
  const findings: AssessmentFinding[] = [
    f('service-levels', 'goals', 'info', `${slas.length} SLA definitions become about ${metrics} JSM SLA metrics with per-priority goals`, [...byTable.entries()].map(([t, xs]) => `${t}: ${xs.map((x) => `${x.name}${attr(x, 'durationMinutes') ? ` (${fmtMinutes(attr<number>(x, 'durationMinutes')!)})` : ''}`).slice(0, 4).join(', ')}`).join(' | '), slas, { approach: 'JSM SLA metrics (Time to first response, Time to resolution …) with goals per JQL (priority / request type) and calendars.' }),
  ];
  if (schedules.length) findings.push(f('service-levels', 'calendars', 'info', `${schedules.length} schedules become JSM calendars`, schedules.map((s) => s.name).slice(0, 10).join(', '), schedules));
  if (olas.length) findings.push(f('service-levels', 'olas', 'low', `${olas.length} OLAs / underpinning contracts`, 'JSM SLAs apply per work item; OLAs between teams need a separate metric or a work item per team.', olas, { approach: 'Additional SLA metric scoped by Team, or linked work items with their own SLA.' }));
  if (breaching.length) findings.push(f('service-levels', 'breaching', 'medium', `${breaching.length} SLAs breach more than 20% of the time`, breaching.map((s) => `${s.name} ${Math.round((attr<number>(s, 'breachRate') ?? 0) * 100)}%`).join(', '), breaching, { recommendation: 'Agree realistic targets in the outcome sign-off instead of copying today\'s numbers.' }));
  if (unparsed.length) findings.push(f('service-levels', 'relative', 'low', `${unparsed.length} SLAs use relative or scripted durations`, 'No direct equivalent; restate the target as a fixed goal per condition.', unparsed));
  return {
    area: 'service-levels', title: 'Service levels',
    summary: `${slas.length} SLA definitions on ${byTable.size} tables, ${schedules.length} schedules.`,
    metrics: { slas: slas.length, tables: byTable.size, proposedMetrics: metrics, schedules: schedules.length, olas: olas.length, breaching: breaching.length },
    findings,
  };
}

// ── Communication ────────────────────────────────────────────────────────

export function assessCommunication({ evidence }: AreaInput): AreaAssessment {
  const notes = evidence.filter((e) => e.kind === 'notification' && active(e));
  const customer = notes.filter((n) => attr(n, 'audience') === 'customer');
  const agent = notes.filter((n) => attr(n, 'audience') !== 'customer');
  const eventDriven = notes.filter((n) => attr(n, 'trigger') === 'event');
  const inbound = evidence.filter((e) => e.kind === 'inbound-email-action' && active(e));
  const channels = evidence.filter((e) => e.kind === 'integration' && attr(e, 'integrationType') === 'email');
  const findings: AssessmentFinding[] = [
    f('communication', 'customer', 'info', `${customer.length} customer notifications`, 'Most map to JSM\'s built-in customer notifications (request created, comment added, resolved, approval required).', customer, { approach: 'JSM customer notifications (templates per project); extra cases via automation "Send email".' }),
    f('communication', 'agent', 'info', `${agent.length} agent / group notifications`, `Tables: ${top(tally(agent.map((n) => attr<string>(n, 'table'))))}`, agent, { approach: 'Notification scheme for agents; automation for targeted alerts (e.g. Slack / Teams / email).' }),
  ];
  if (eventDriven.length) findings.push(f('communication', 'events', 'low', `${eventDriven.length} notifications are raised by script events`, 'The triggering condition lives in scripts; restate it as an automation trigger.', eventDriven));
  if (inbound.length || channels.length) findings.push(f('communication', 'email-in', 'info', `${inbound.length} inbound email actions, ${channels.length} mail accounts`, 'Email-to-request and reply handling.', [...inbound, ...channels], { approach: 'JSM email channel per service space; replies become comments automatically.' }));
  return { area: 'communication', title: 'Communication', summary: `${notes.length} notifications (${customer.length} to customers), ${inbound.length} inbound email actions.`, metrics: { notifications: notes.length, customer: customer.length, agent: agent.length, eventDriven: eventDriven.length, inboundEmail: inbound.length, mailAccounts: channels.length }, findings };
}

// ── Data model ───────────────────────────────────────────────────────────

export function assessDataModel({ evidence, store }: AreaInput): AreaAssessment {
  const tables = evidence.filter((e) => e.kind === 'table');
  const fields = evidence.filter((e) => e.kind === 'dictionary-field');
  const byTable = tally(fields.map((x) => attr<string>(x, 'table')));
  const choices = store.table('sys_choice');
  const choiceLists = tally(choices.map((c) => `${c.fields['name']}.${c.fields['element']}`));
  const big = Object.entries(choiceLists).filter(([, n]) => n > 30);
  const findings: AssessmentFinding[] = [];
  if (tables.length) findings.push(f('data-model', 'custom-tables', 'medium', `${tables.length} custom tables`, tables.slice(0, 10).map((t) => t.name).join(', '), tables, { approach: 'Per table: a work type (if it is a process), an Assets object type (if it is reference data), or out of scope.' }));
  if (fields.length) findings.push(f('data-model', 'custom-fields', fields.length > 100 ? 'medium' : 'low', `${fields.length} custom fields on platform tables`, top(byTable), fields, { approach: 'Only fields that an agreed outcome needs become Jira custom fields (shared across request types); the rest are dropped.' }));
  if (big.length) findings.push(f('data-model', 'large-choices', 'low', `${big.length} choice lists with more than 30 values`, big.slice(0, 5).map(([k, n]) => `${k} (${n})`).join(', '), [], { approach: 'Assets objects instead of long select lists.' }));
  return { area: 'data-model', title: 'Data model', summary: `${tables.length} custom tables, ${fields.length} custom fields, ${Object.keys(choiceLists).length} choice lists.`, metrics: { customTables: tables.length, customFields: fields.length, choiceLists: Object.keys(choiceLists).length }, findings, details: { fieldsByTable: byTable } };
}

// ── Security ─────────────────────────────────────────────────────────────

export function assessSecurity({ evidence }: AreaInput): AreaAssessment {
  const acls = evidence.filter((e) => e.kind === 'acl' && active(e));
  const field = acls.filter((a) => attr(a, 'fieldLevel'));
  const scripted = acls.filter((a) => attr(a, 'scripted') || attr(a, 'condition'));
  const roles = evidence.filter((e) => e.kind === 'role');
  const criteria = evidence.filter((e) => e.kind === 'user-criteria');
  const findings: AssessmentFinding[] = [];
  if (field.length) findings.push(f('security', 'field-level', 'high', `${field.length} field-level ACLs`, 'Jira has no field-level read/write security.', field, { approach: 'Restate the outcome: separate restricted data into its own space, use issue security levels, or keep sensitive data in Assets with object-level permissions.', effort: 'M' }));
  if (scripted.length) findings.push(f('security', 'conditional', 'medium', `${scripted.length} conditional or scripted ACLs`, top(tally(scripted.map((a) => attr<string>(a, 'table')))), scripted, { approach: 'Issue security levels set by automation, request participants and organisations, or project permission schemes.' }));
  if (roles.length) findings.push(f('security', 'roles', 'low', `${roles.length} custom roles`, roles.slice(0, 10).map((r) => r.name).join(', '), roles, { approach: 'Project roles + groups; Atlassian Guard for admin and access policies.' }));
  if (criteria.length) findings.push(f('security', 'user-criteria', 'info', `${criteria.length} user criteria restrict who can request`, 'Becomes request-type access restrictions and customer/portal access settings.', criteria, { approach: 'Restrict request types to groups / organisations; separate help centres if audiences differ.' }));
  return { area: 'security', title: 'Access & security', summary: `${acls.length} active ACLs (${field.length} field-level, ${scripted.length} conditional), ${roles.length} custom roles, ${criteria.length} user criteria.`, metrics: { acls: acls.length, fieldLevel: field.length, conditional: scripted.length, customRoles: roles.length, userCriteria: criteria.length, ...Object.fromEntries(Object.entries(tally(acls.map((a) => attr<string>(a, 'operation')))).map(([k, v]) => [`op:${k}`, v])) }, findings };
}

// ── Integrations ─────────────────────────────────────────────────────────

export function assessIntegrations({ evidence }: AreaInput): AreaAssessment {
  const ints = evidence.filter((e) => e.kind === 'integration' && active(e));
  const mids = evidence.filter((e) => e.kind === 'mid-server');
  const maps = evidence.filter((e) => e.kind === 'transform-map' && active(e));
  const type = (t: string) => ints.filter((i) => attr(i, 'integrationType') === t);
  const outbound = [...type('rest-outbound'), ...type('soap-outbound')];
  const inbound = type('rest-inbound');
  const hosts = [...new Set(outbound.map((i) => attr<string>(i, 'host')).filter(Boolean))];
  const scriptsCalling = evidence.filter((e) => scriptOf(e)?.patterns.includes('integration'));
  const findings: AssessmentFinding[] = [];
  if (outbound.length) findings.push(f('integrations', 'outbound', 'high', `${outbound.length} outbound integrations to ${hosts.length} systems`, hosts.slice(0, 10).join(', '), outbound, { approach: 'Per system: Atlassian/Marketplace integration first, then automation "Send web request", then Forge. Rebuild against the outcome, not the payload.', effort: 'L' }));
  if (inbound.length) findings.push(f('integrations', 'inbound', 'high', `${inbound.length} inbound APIs that other systems call`, 'Callers must be re-pointed to Jira / JSM REST APIs or webhooks.', inbound, { approach: 'Jira/JSM REST APIs, incoming webhooks (automation), or a Forge web trigger.', effort: 'L' }));
  if (mids.length) findings.push(f('integrations', 'mid', 'medium', `${mids.length} MID servers`, 'Atlassian Cloud has no MID server.', mids, { approach: 'Assets Discovery for discovery; integrations reach on-premises systems through a cloud-reachable gateway or iPaaS.' }));
  if (maps.length || type('import').length) findings.push(f('integrations', 'imports', 'info', `${maps.length} transform maps, ${type('import').length} import sources`, 'Data loads into ServiceNow.', [...maps, ...type('import')], { approach: 'Assets imports (CSV/JSON/connectors) for reference data; out of scope for the instance build.' }));
  if (scriptsCalling.length) findings.push(f('integrations', 'script-calls', 'medium', `${scriptsCalling.length} scripts call external systems directly`, scriptsCalling.slice(0, 6).map((e) => e.name).join(', '), scriptsCalling));
  return { area: 'integrations', title: 'Integrations', summary: `${outbound.length} outbound, ${inbound.length} inbound, ${type('oauth').length} OAuth registrations, ${mids.length} MID servers, ${maps.length} transform maps.`, metrics: { outbound: outbound.length, inbound: inbound.length, systems: hosts.length, oauth: type('oauth').length, midServers: mids.length, transformMaps: maps.length, emailAccounts: type('email').length, scriptsCalling: scriptsCalling.length }, findings, details: { hosts } };
}

// ── Experience, knowledge, reporting, platform ───────────────────────────

export function assessExperience({ evidence }: AreaInput): AreaAssessment {
  const portals = evidence.filter((e) => e.kind === 'portal');
  const widgets = evidence.filter((e) => e.kind === 'portal-widget');
  const topics = evidence.filter((e) => e.kind === 'virtual-agent-topic' && active(e));
  const findings: AssessmentFinding[] = [];
  if (portals.length) findings.push(f('experience', 'portal', 'info', `${portals.length} portal(s)`, 'The JSM help centre and service-space portals replace the Service Portal.', portals, { approach: 'Help centre with branding, topics and portal groups; one portal per service space.' }));
  if (widgets.length) findings.push(f('experience', 'widgets', 'medium', `${widgets.length} custom portal widgets`, widgets.slice(0, 8).map((w) => w.name).join(', '), widgets, { approach: 'Most become standard help-centre content; anything essential via Forge portal modules. Do not rebuild pixel-for-pixel.' }));
  if (topics.length) findings.push(f('experience', 'virtual-agent', 'medium', `${topics.length} Virtual Agent topics`, topics.slice(0, 10).map((t) => t.name).join(', '), topics, { approach: 'JSM virtual service agent (Rovo): answers from the knowledge base plus intent flows for actions.' }));
  return { area: 'experience', title: 'Employee experience', summary: `${portals.length} portals, ${widgets.length} custom widgets, ${topics.length} virtual agent topics.`, metrics: { portals: portals.length, customWidgets: widgets.length, virtualAgentTopics: topics.length }, findings };
}

export function assessKnowledge({ evidence }: AreaInput): AreaAssessment {
  const kbs = evidence.filter((e) => e.kind === 'knowledge-base');
  const articles = kbs.reduce((n, k) => n + (attr<number>(k, 'articles') ?? 0), 0);
  const published = kbs.reduce((n, k) => n + (attr<number>(k, 'published') ?? 0), 0);
  return { area: 'knowledge', title: 'Knowledge', summary: `${kbs.length} knowledge bases, ${articles} articles (${published} published).`, metrics: { knowledgeBases: kbs.length, articles, published }, findings: kbs.length ? [f('knowledge', 'kb', 'info', `${articles} articles in ${kbs.length} knowledge base(s)`, 'Content migration is out of scope for the instance build; the structure is designed now.', kbs, { approach: 'Confluence space(s) linked as the JSM knowledge base; one space per audience.' })] : [] };
}

export function assessReporting({ evidence }: AreaInput): AreaAssessment {
  const reports = evidence.filter((e) => e.kind === 'report');
  const dashboards = evidence.filter((e) => e.kind === 'dashboard');
  const kpis = reports.filter((r) => attr(r, 'type') === 'pa-indicator');
  return { area: 'reporting', title: 'Reporting', summary: `${reports.length - kpis.length} reports, ${kpis.length} KPIs, ${dashboards.length} dashboards.`, metrics: { reports: reports.length - kpis.length, kpis: kpis.length, dashboards: dashboards.length }, findings: reports.length + dashboards.length ? [f('reporting', 'reports', 'info', `${reports.length + dashboards.length} reports, KPIs and dashboards`, kpis.slice(0, 8).map((k) => k.name).join(', '), [...kpis, ...dashboards, ...reports], { approach: 'JSM reports and queues for operations; Jira dashboards; Atlassian Analytics for KPIs and trends (Premium / Enterprise).' })] : [] };
}

export function assessPlatform({ evidence }: AreaInput): AreaAssessment {
  const apps = evidence.filter((e) => e.kind === 'scoped-app');
  const plugins = evidence.filter((e) => e.kind === 'plugin');
  const products = tally(plugins.map((p) => attr<string>(p, 'product')));
  const domains = [...new Set(plugins.map((p) => p.domain).filter(Boolean))];
  const findings: AssessmentFinding[] = [];
  if (apps.filter((a) => a.custom).length) findings.push(f('platform', 'custom-apps', 'high', `${apps.filter((a) => a.custom).length} custom scoped applications`, apps.filter((a) => a.custom).map((a) => a.name).join(', '), apps.filter((a) => a.custom), { approach: 'Assess each as its own capability: native JSM/Jira, Marketplace app, or Forge app.', effort: 'XL' }));
  if (plugins.length) findings.push(f('platform', 'products', 'info', `Products in use: ${Object.keys(products).join(', ')}`, `Domains: ${domains.join(', ')}`, plugins, { approach: 'Each product maps to an Atlassian capability area (e.g. HR → JSM HR service space, Discovery → Assets Discovery, Event Management → JSM Operations).' }));
  return { area: 'platform', title: 'Platform & products', summary: `${apps.length} scoped apps, ${plugins.length} notable plugins.`, metrics: { scopedApps: apps.length, customApps: apps.filter((a) => a.custom).length, plugins: plugins.length }, findings, details: { products } };
}

export const AREA_ASSESSORS = [assessInventory, assessCatalog, assessProcess, assessCustomisation, assessRouting, assessServiceLevels, assessCommunication, assessDataModel, assessSecurity, assessIntegrations, assessExperience, assessKnowledge, assessReporting, assessPlatform];

export { pct };
