/**
 * Build list for everything ServiceNow has: a first-pass proposal of the JSM component for every
 * ServiceNow component that no capability, outcome or design element accounts for yet.
 *
 * This is deliberately a proposal, not a design: nobody has reviewed it, it is not signed off and
 * the builder never builds from it. Its job is to show the whole estate, so a person (or an agent
 * such as Rovo CLI) can decide what to bring into a capability, what to drop and what needs a
 * different answer. Readiness comes from the API coverage matrix, so it says how the workbench
 * could build that kind of JSM component, not whether this particular item is a good idea.
 *
 * Pure function of the blueprint; Forge-safe (no node: imports).
 */
import type { Blueprint, CoverageStatus, DesignElementType, Evidence, EvidenceKind } from '@snjsm/model';
import { coverageFor } from './index';

/** How the proposed JSM component could be built, from the coverage matrix or the mapping. */
export type Readiness =
  | CoverageStatus
  /** Atlassian has an answer but it is not a design element this toolkit builds (Confluence, Analytics, Rovo, imports, permissions). */
  | 'outside-builder'
  /** No JSM equivalent: drop it, change the process or build a Forge app. */
  | 'no-equivalent'
  /** Context or platform detail that needs no JSM component of its own. */
  | 'not-needed';

export const READINESS_LABEL: Record<Readiness, string> = {
  api: 'workbench can build (API)',
  partial: 'partly by API, rest guided',
  unknown: 'API not yet verified: guided for now',
  'ui-only': 'guided steps in the JSM UI',
  'outside-builder': 'outside this builder',
  'no-equivalent': 'no JSM equivalent',
  'not-needed': 'not needed in JSM',
};

interface Mapping {
  /** The JSM design element this would become; absent when the answer is outside the builder or there is none. */
  target?: DesignElementType;
  /** Required when there is no target. */
  readiness?: Exclude<Readiness, CoverageStatus>;
  /** What to build in JSM, in plain words. */
  jsm: string;
  /** The logic is code in ServiceNow and has to be redesigned rather than copied. */
  redesign?: boolean;
  note?: string;
}

/** One proposal per ServiceNow kind. Record<EvidenceKind, …> so a new kind cannot be added without an answer. */
export const SN_TO_JSM: Record<EvidenceKind, Mapping> = {
  'catalog-item': { target: 'request-type', jsm: 'Request type with a form, in a service space' },
  'record-producer': { target: 'request-type', jsm: 'Request type that creates the work item directly' },
  'catalog-variable': { target: 'form', jsm: 'Form question', note: 'Add a custom field only when reports, queues, SLAs or automation use the value.' },
  'variable-set': { target: 'form', jsm: 'Reusable form section (form template)' },
  'catalog-category': { target: 'portal-group', jsm: 'Portal group (request type group)' },
  'order-guide': { target: 'request-type', jsm: 'Request type plus automation that creates the linked work items' },
  flow: { target: 'automation', jsm: 'Automation rule' },
  subflow: { target: 'automation', jsm: 'Automation rule (or a reusable part of the rules that call it)' },
  'flow-step': { target: 'automation', jsm: 'Action in its parent flow’s automation rule', note: 'Built with the parent flow, not on its own.' },
  'legacy-workflow': { target: 'workflow', jsm: 'Jira workflow (statuses, transitions, approvals)' },
  'business-rule': { target: 'automation', jsm: 'Automation rule, or a workflow condition, validator or post function', redesign: true },
  'client-script': { target: 'form', jsm: 'Form conditions and field behaviour', redesign: true, note: 'Scripted UI logic does not port; anything forms cannot do needs a Forge app.' },
  'ui-script': { readiness: 'no-equivalent', jsm: 'None: drop it or replace with a Forge app', redesign: true },
  'ui-policy': { target: 'form', jsm: 'Form conditional sections and required questions' },
  'ui-action': { target: 'workflow', jsm: 'Workflow transition, or a manually triggered automation rule' },
  'script-include': { readiness: 'no-equivalent', jsm: 'None: rewrite the logic in the automation rules or a Forge app that use it', redesign: true },
  'scheduled-job': { target: 'automation', jsm: 'Scheduled automation rule', redesign: true },
  event: { target: 'automation', jsm: 'Automation rule trigger' },
  'transform-map': { readiness: 'outside-builder', jsm: 'Import mapping for the data migration (JSM CSV import or Assets import)' },
  'assignment-rule': { target: 'automation', jsm: 'Automation rule that assigns the team or agent' },
  'approval-rule': { target: 'workflow', jsm: 'Approval step in the workflow' },
  'sla-definition': { target: 'sla', jsm: 'SLA goal' },
  schedule: { target: 'calendar', jsm: 'SLA calendar' },
  notification: { target: 'notification', jsm: 'Customer or agent notification' },
  'inbound-email-action': { target: 'automation', jsm: 'Email channel plus an automation rule on work items created from email' },
  table: { target: 'work-type', jsm: 'Work type (or an Assets object type if it holds records, not tickets)' },
  'dictionary-field': { target: 'field', jsm: 'Custom field' },
  'choice-list': { target: 'field', jsm: 'Options on a select field' },
  acl: { readiness: 'outside-builder', jsm: 'Space permissions, request type access or work item security, set by an admin' },
  role: { readiness: 'outside-builder', jsm: 'Space role and permission scheme' },
  group: { target: 'team', jsm: 'Atlassian team (assignment group)' },
  'user-criteria': { readiness: 'outside-builder', jsm: 'Who can raise the request type: customer groups or organizations' },
  'ci-class': { target: 'assets-object-type', jsm: 'Assets object type' },
  'ci-attribute': { target: 'assets-attribute', jsm: 'Assets attribute' },
  'ci-relationship-type': { target: 'assets-reference-type', jsm: 'Assets reference type' },
  'ci-relationship-stat': { readiness: 'not-needed', jsm: 'None: relationship counts inform the reference types' },
  'identification-rule': { readiness: 'outside-builder', jsm: 'Identifier on the Assets import (or Assets Discovery)' },
  service: { readiness: 'outside-builder', jsm: 'Service in the JSM service registry' },
  'service-offering': { readiness: 'outside-builder', jsm: 'Service tier, or a related service in the JSM service registry' },
  'business-application': { readiness: 'outside-builder', jsm: 'Assets objects of an application type, loaded by import' },
  'asset-class': { target: 'assets-object-type', jsm: 'Assets object type' },
  'hardware-model': { readiness: 'outside-builder', jsm: 'Assets objects of a model type, loaded by import' },
  portal: { readiness: 'outside-builder', jsm: 'Help centre and portal settings, layout and branding' },
  'portal-widget': { readiness: 'no-equivalent', jsm: 'None: use help centre layout and pages, or a Forge app for custom UI', redesign: true },
  'knowledge-base': { readiness: 'outside-builder', jsm: 'Confluence space linked as the service space’s knowledge base' },
  'virtual-agent-topic': { readiness: 'outside-builder', jsm: 'Rovo virtual service agent topic or AI answers' },
  report: { readiness: 'outside-builder', jsm: 'JSM report, Jira dashboard or Atlassian Analytics chart' },
  dashboard: { readiness: 'outside-builder', jsm: 'Jira dashboard or Atlassian Analytics dashboard' },
  integration: { readiness: 'outside-builder', jsm: 'Marketplace app, automation web request or Forge integration' },
  'mid-server': { readiness: 'outside-builder', jsm: 'Assets Discovery or an integration gateway, where on-premises access is still needed' },
  'scoped-app': { readiness: 'no-equivalent', jsm: 'None: rebuild as a Forge app, replace with a Marketplace app or retire', redesign: true },
  plugin: { readiness: 'not-needed', jsm: 'None: a ServiceNow platform feature; JSM has its own' },
  'process-step': { readiness: 'not-needed', jsm: 'None: process context for the analysts' },
  'process-diagram': { readiness: 'not-needed', jsm: 'None: process context for the analysts' },
  'screenshot-region': { readiness: 'not-needed', jsm: 'None: context from a screenshot' },
  'document-section': { readiness: 'not-needed', jsm: 'None: context from a document' },
  other: { readiness: 'not-needed', jsm: 'None until someone classifies it' },
};

export interface BuildListItem {
  id: string; kind: EvidenceKind; name: string; table?: string; intent?: string;
  custom?: boolean; active?: boolean; usage?: { count: number; periodDays?: number }; risk?: string;
  target?: DesignElementType; jsm: string; readiness: Readiness; redesign: boolean; note?: string;
}

export interface BuildListGroup {
  /** The design element type, or the readiness bucket when there is no target. */
  id: string; label: string; target?: DesignElementType; readiness: Readiness;
  count: number; custom: number; redesign: number; byKind: Partial<Record<EvidenceKind, number>>;
}

export interface BuildList {
  blueprintId: string; customer: string;
  status: 'proposed, not reviewed';
  totals: {
    components: number;
    /** Already accounted for by a capability, outcome, gap or design element. */
    covered: number;
    /** Detected by a capability that is out of scope. */
    outOfScope: number;
    /** Left out because ServiceNow marks them inactive (unless includeInactive). */
    inactive: number;
    proposed: number;
    byReadiness: Record<Readiness, number>;
  };
  groups: BuildListGroup[];
}

export interface BuildListOptions { includeInactive?: boolean }
export interface BuildListQuery extends BuildListOptions {
  group?: string; query?: string; customOnly?: boolean; readiness?: Readiness[]; offset?: number; limit?: number;
}
export interface BuildListPage { group?: string; total: number; offset: number; items: BuildListItem[] }

const TARGET_LABEL: Record<DesignElementType, string> = {
  space: 'Service spaces', 'portal-group': 'Portal groups', 'request-type': 'Request types', form: 'Forms',
  field: 'Fields', workflow: 'Workflows', 'work-type': 'Work types', queue: 'Queues', sla: 'SLAs', calendar: 'Calendars',
  automation: 'Automation rules', notification: 'Notifications', team: 'Teams', 'assets-schema': 'Assets schemas',
  'assets-object-type': 'Assets object types', 'assets-attribute': 'Assets attributes', 'assets-status-type': 'Assets status types',
  'assets-reference-type': 'Assets reference types',
};
const BUCKET_LABEL: Record<Exclude<Readiness, CoverageStatus>, string> = {
  'outside-builder': 'Outside this builder', 'no-equivalent': 'No JSM equivalent', 'not-needed': 'Not needed in JSM',
};
const RANK: Record<CoverageStatus, number> = { api: 0, partial: 1, unknown: 2, 'ui-only': 3 };
export const READINESS_ORDER: Readiness[] = ['api', 'partial', 'unknown', 'ui-only', 'outside-builder', 'no-equivalent', 'not-needed'];

/** How the workbench creates this type of element: the weakest of its create entries in the coverage matrix. */
export function createReadiness(type: DesignElementType): CoverageStatus {
  const entries = coverageFor(type).filter((e) => e.operation === 'create');
  if (!entries.length) return 'unknown';
  return entries.reduce<CoverageStatus>((worst, e) => (RANK[e.status] > RANK[worst] ? e.status : worst), 'api');
}

/** Evidence that the reviewed parts of the blueprint already account for, and evidence of out-of-scope capabilities. */
export function accountedFor(bp: Blueprint): { covered: Set<string>; outOfScope: Set<string> } {
  const covered = new Set<string>();
  const outOfScope = new Set<string>();
  for (const o of bp.outcomes) for (const id of o.evidenceIds) covered.add(id);
  for (const el of bp.design) for (const id of el.justification?.evidenceIds ?? []) covered.add(id);
  for (const c of bp.capabilities) {
    const ids = [...(c.detection?.evidenceIds ?? []), ...(c.fit?.gaps ?? []).flatMap((g) => g.evidenceIds)];
    for (const id of ids) (c.status === 'out-of-scope' ? outOfScope : covered).add(id);
  }
  for (const id of covered) outOfScope.delete(id);
  return { covered, outOfScope };
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

function itemOf(e: Evidence): BuildListItem {
  const m = SN_TO_JSM[e.kind];
  const readiness: Readiness = m.target ? createReadiness(m.target) : m.readiness!;
  const risk = str(e.attributes['risk']);
  return {
    id: e.id, kind: e.kind, name: e.name, table: e.provenance[0]?.table, intent: e.intent,
    custom: e.custom, active: e.usage?.active,
    usage: e.usage?.count !== undefined ? { count: e.usage.count, periodDays: e.usage.periodDays } : undefined,
    risk: risk && risk !== 'none' ? risk : undefined,
    target: m.target, jsm: m.jsm, readiness, redesign: Boolean(m.redesign) || Boolean(risk && risk !== 'none'), note: m.note,
  };
}

function groupIdOf(i: BuildListItem): string { return i.target ?? i.readiness; }

function unaccounted(bp: Blueprint, o: BuildListOptions) {
  const { covered, outOfScope } = accountedFor(bp);
  const rest = bp.evidence.filter((e) => !covered.has(e.id) && !outOfScope.has(e.id));
  const inactive = rest.filter((e) => e.usage?.active === false);
  const proposed = o.includeInactive ? rest : rest.filter((e) => e.usage?.active !== false);
  return { covered: bp.evidence.filter((e) => covered.has(e.id)).length, outOfScope: bp.evidence.filter((e) => outOfScope.has(e.id) && !covered.has(e.id)).length, inactive: o.includeInactive ? 0 : inactive.length, items: proposed.map(itemOf) };
}

/** Totals and groups; items come page by page from buildListItems. */
export function buildList(bp: Blueprint, o: BuildListOptions = {}): BuildList {
  const u = unaccounted(bp, o);
  const byReadiness = Object.fromEntries(READINESS_ORDER.map((r) => [r, 0])) as Record<Readiness, number>;
  const groups = new Map<string, BuildListGroup>();
  for (const i of u.items) {
    byReadiness[i.readiness]++;
    const id = groupIdOf(i);
    const label = i.target ? TARGET_LABEL[i.target] : BUCKET_LABEL[i.readiness as keyof typeof BUCKET_LABEL];
    const g: BuildListGroup = groups.get(id) ?? { id, label, ...(i.target ? { target: i.target } : {}), readiness: i.readiness, count: 0, custom: 0, redesign: 0, byKind: {} };
    g.count++; if (i.custom) g.custom++; if (i.redesign) g.redesign++;
    g.byKind[i.kind] = (g.byKind[i.kind] ?? 0) + 1;
    groups.set(id, g);
  }
  const order = (g: BuildListGroup) => READINESS_ORDER.indexOf(g.readiness);
  return {
    blueprintId: bp.id, customer: bp.customer.name, status: 'proposed, not reviewed',
    totals: { components: bp.evidence.length, covered: u.covered, outOfScope: u.outOfScope, inactive: u.inactive, proposed: u.items.length, byReadiness },
    groups: [...groups.values()].sort((a, b) => order(a) - order(b) || b.count - a.count || a.label.localeCompare(b.label)),
  };
}

export const MAX_BUILD_LIST_PAGE = 500;

/** One page of proposed items, filtered; custom and scripted items first, then by name. */
export function buildListItems(bp: Blueprint, q: BuildListQuery = {}): BuildListPage {
  const needle = q.query?.trim().toLowerCase();
  const items = unaccounted(bp, q).items.filter((i) =>
    (!q.group || groupIdOf(i) === q.group)
    && (!q.customOnly || i.custom)
    && (!q.readiness?.length || q.readiness.includes(i.readiness))
    && (!needle || [i.name, i.intent, i.table, i.kind, i.jsm].some((s) => s?.toLowerCase().includes(needle))));
  items.sort((a, b) => Number(Boolean(b.custom)) - Number(Boolean(a.custom)) || Number(b.redesign) - Number(a.redesign) || a.name.localeCompare(b.name));
  const offset = Math.max(0, q.offset ?? 0);
  const limit = Math.min(Math.max(1, q.limit ?? 100), MAX_BUILD_LIST_PAGE);
  return { ...(q.group ? { group: q.group } : {}), total: items.length, offset, items: items.slice(offset, offset + limit) };
}

const cell = (s: string | undefined) => (s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

/** Markdown for people and agents: the summary, then up to perGroup items in each group. */
export function buildListMarkdown(bp: Blueprint, o: BuildListOptions & { perGroup?: number; group?: string; customOnly?: boolean } = {}): string {
  const list = buildList(bp, o);
  const t = list.totals;
  const per = o.perGroup ?? 25;
  const lines = [
    `# Build list for everything ServiceNow has: ${list.customer}`,
    '',
    '> Proposed, not reviewed. Nobody has checked these mappings, they are not signed off and the workbench never builds from this list.',
    '> Bring an item into a capability (outcome and design element) to build it.',
    '',
    `${t.components} ServiceNow components: ${t.covered} already covered by the blueprint, ${t.outOfScope} in out-of-scope capabilities, ${t.inactive} inactive and left out, **${t.proposed} proposed here**.`,
    '',
    '| Readiness | Components |', '|---|---|',
    ...READINESS_ORDER.filter((r) => t.byReadiness[r]).map((r) => `| ${READINESS_LABEL[r]} | ${t.byReadiness[r]} |`),
    '',
  ];
  for (const g of list.groups.filter((g) => !o.group || g.id === o.group)) {
    lines.push(`## ${g.label} (${g.count})`, '', `${READINESS_LABEL[g.readiness]}${g.custom ? ` · ${g.custom} customer-built` : ''}${g.redesign ? ` · ${g.redesign} need redesign` : ''} · ${Object.entries(g.byKind).map(([k, n]) => `${n} ${k}`).join(', ')}`, '');
    const page = buildListItems(bp, { ...o, group: g.id, limit: per });
    lines.push('| ServiceNow | Kind | Proposed in JSM | Flags |', '|---|---|---|---|');
    for (const i of page.items) {
      const flags = [i.custom && 'custom', i.redesign && 'redesign', i.risk && `${i.risk} risk`, i.active === false && 'inactive'].filter(Boolean).join(', ');
      lines.push(`| ${cell(i.name)}${i.intent ? `<br>${cell(i.intent)}` : ''} | ${i.kind} | ${cell(i.jsm)}${i.note ? `<br>${cell(i.note)}` : ''} | ${flags} |`);
    }
    if (page.total > page.items.length) lines.push('', `…and ${page.total - page.items.length} more.`);
    lines.push('');
  }
  return lines.join('\n');
}
