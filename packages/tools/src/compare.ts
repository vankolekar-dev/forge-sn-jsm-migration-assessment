import type { ReferenceArtifact } from '@snjsm/reference';
import type { Capture } from './capture';

/**
 * Compare what a template really created (a Capture) with the reference library.
 * Pure: no I/O. Matching is by kind + case-insensitive name, scoped to the templates that were captured.
 */
export type FindingResult = 'matched' | 'mismatched' | 'missing' | 'extra' | 'not-captured';

export interface Finding {
  result: FindingResult;
  kind: ReferenceArtifact['kind'];
  name: string;
  artifactId?: string;
  /** Human-readable differences (mismatched) or reasons (missing / not-captured). */
  details: string[];
  /** Facts captured from the site that the --update step may write back into the artifact. */
  captured?: Record<string, unknown>;
}

export interface CompareOptions {
  /** JSM project template the captured project was created from, e.g. atl.jsm.template.itsm. */
  jsmTemplate?: string;
  /** Assets schema template the captured schema was created from, e.g. atl.assets.template.itam. */
  assetsTemplate?: string;
}

export interface CompareReport {
  site: string;
  capturedAt: string;
  scope: CompareOptions;
  findings: Finding[];
  summary: Record<FindingResult, number>;
}

type Status = { name: string; category: string };

// Template work types can be named "[System] <name>" on a site; compare on the plain name.
const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/^\[system\]\s*/, '');
const byName = <T extends { name: string }>(items: T[] | undefined, name: string) => items?.find((i) => norm(i.name) === norm(name));

/** Ordered-insensitive status comparison: names and categories. */
export function diffStatuses(expected: Status[], actual: Status[]): string[] {
  const out: string[] = [];
  for (const e of expected) {
    const a = byName(actual, e.name);
    if (!a) out.push(`status "${e.name}" missing`);
    else if (a.category !== e.category) out.push(`status "${e.name}" category ${a.category}, expected ${e.category}`);
  }
  for (const a of actual) if (!byName(expected, a.name)) out.push(`extra status "${a.name}" (${a.category})`);
  return out;
}

/** Artifacts belonging to a template (direct partOf), keyed by kind. */
function partsOf(artifacts: ReferenceArtifact[], templateId: string | undefined, kind: ReferenceArtifact['kind']) {
  return templateId ? artifacts.filter((a) => a.partOf === templateId && a.kind === kind) : [];
}

export function compareCapture(cap: Capture, artifacts: ReferenceArtifact[], opts: CompareOptions): CompareReport {
  const findings: Finding[] = [];
  const byId = new Map(artifacts.map((a) => [a.id, a]));
  const push = (f: Finding) => findings.push(f);
  const p = cap.project;
  const sd = cap.serviceDesk;

  // ── JSM project template ────────────────────────────────────────────────
  if (opts.jsmTemplate) {
    const tpl = byId.get(opts.jsmTemplate);
    if (!tpl) throw new Error(`unknown JSM template artifact ${opts.jsmTemplate}`);
    if (!p) {
      push({ result: 'not-captured', kind: tpl.kind, name: tpl.name, artifactId: tpl.id, details: ['no project was captured'] });
    } else {
      const want = tpl.attributes.projectTypeKey as string | undefined;
      const details = want && want !== p.projectTypeKey ? [`projectTypeKey ${p.projectTypeKey}, expected ${want}`] : [];
      details.push('templateKey cannot be read back via REST; confirm the template used when the project was created');
      push({
        result: want && want !== p.projectTypeKey ? 'mismatched' : 'matched', kind: tpl.kind, name: tpl.name, artifactId: tpl.id, details,
        captured: { projectKey: p.key, projectTypeKey: p.projectTypeKey, style: p.style, workTypes: p.workTypes.map((t) => t.name), workflowScheme: p.workflowScheme },
      });
    }

    // Work types
    const wts = partsOf(artifacts, opts.jsmTemplate, 'work-type');
    for (const a of wts) {
      if (!p) { push({ result: 'not-captured', kind: a.kind, name: a.name, artifactId: a.id, details: ['no project captured'] }); continue; }
      const got = byName(p.workTypes, a.name);
      push(got
        ? { result: 'matched', kind: a.kind, name: a.name, artifactId: a.id, details: [], captured: { id: got.id, subtask: got.subtask, workflow: p.workflowScheme?.mappings[got.name] ?? p.workflowScheme?.defaultWorkflow } }
        : { result: 'missing', kind: a.kind, name: a.name, artifactId: a.id, details: [`work type not in project ${p.key}`] });
    }
    for (const t of p?.workTypes ?? []) {
      if (!wts.some((a) => norm(a.name) === norm(t.name))) push({ result: 'extra', kind: 'work-type', name: t.name, details: ['created by the template but not in the reference library'], captured: { id: t.id, subtask: t.subtask } });
    }

    // Workflows: statuses come from the work type(s) that use them.
    for (const wf of partsOf(artifacts, opts.jsmTemplate, 'workflow')) {
      const users = wts.filter((w) => w.attributes.workflow === wf.id).map((w) => byName(p?.workTypes, w.name)).filter((t): t is NonNullable<typeof t> => Boolean(t));
      const captured = users.map((u) => p!.statusesByWorkType[u.name]).find((s) => s?.length);
      if (!captured) {
        push({ result: p ? 'missing' : 'not-captured', kind: wf.kind, name: wf.name, artifactId: wf.id, details: [users.length ? 'no statuses captured for its work types' : 'no captured work type maps to this workflow'] });
        continue;
      }
      const diff = diffStatuses((wf.attributes.statuses as Status[] | undefined) ?? [], captured);
      const scheme = p!.workflowScheme?.mappings[users[0]!.name] ?? p!.workflowScheme?.defaultWorkflow;
      push({ result: diff.length ? 'mismatched' : 'matched', kind: wf.kind, name: wf.name, artifactId: wf.id, details: diff, captured: { statuses: captured, siteWorkflowName: scheme, usedBy: users.map((u) => u.name) } });
    }

    // Portal groups
    const groups = partsOf(artifacts, opts.jsmTemplate, 'portal-group');
    for (const a of groups) {
      if (!sd) { push({ result: 'not-captured', kind: a.kind, name: a.name, artifactId: a.id, details: ['no service desk captured'] }); continue; }
      const got = byName(sd.groups, a.name);
      push(got ? { result: 'matched', kind: a.kind, name: a.name, artifactId: a.id, details: [] } : { result: 'missing', kind: a.kind, name: a.name, artifactId: a.id, details: ['portal group not on the service desk'] });
    }
    for (const g of sd?.groups ?? []) if (!groups.some((a) => norm(a.name) === norm(g.name))) push({ result: 'extra', kind: 'portal-group', name: g.name, details: ['created by the template but not in the reference library'] });

    // Request types: name, work type and portal group.
    const rts = partsOf(artifacts, opts.jsmTemplate, 'request-type');
    for (const a of rts) {
      if (!sd) { push({ result: 'not-captured', kind: a.kind, name: a.name, artifactId: a.id, details: ['no service desk captured'] }); continue; }
      const got = byName(sd.requestTypes, a.name);
      if (!got) { push({ result: 'missing', kind: a.kind, name: a.name, artifactId: a.id, details: ['request type not on the service desk'] }); continue; }
      const details: string[] = [];
      const wantWt = byId.get(a.attributes.workType as string)?.name;
      if (wantWt && norm(wantWt) !== norm(got.workType)) details.push(`work type "${got.workType ?? '?'}", expected "${wantWt}"`);
      const wantGroup = byId.get(a.attributes.portalGroup as string)?.name;
      if (wantGroup && !got.groups.some((g) => norm(g) === norm(wantGroup))) details.push(`portal groups [${got.groups.join(', ')}], expected to include "${wantGroup}"`);
      push({ result: details.length ? 'mismatched' : 'matched', kind: a.kind, name: a.name, artifactId: a.id, details, captured: { workType: got.workType, groups: got.groups, fields: got.fields } });
    }
    for (const r of sd?.requestTypes ?? []) if (!rts.some((a) => norm(a.name) === norm(r.name))) push({ result: 'extra', kind: 'request-type', name: r.name, details: ['created by the template but not in the reference library'], captured: { workType: r.workType, groups: r.groups } });

    // Queues
    const queues = partsOf(artifacts, opts.jsmTemplate, 'queue');
    for (const a of queues) {
      if (!sd) { push({ result: 'not-captured', kind: a.kind, name: a.name, artifactId: a.id, details: ['no service desk captured'] }); continue; }
      const got = byName(sd.queues, a.name);
      push(got ? { result: 'matched', kind: a.kind, name: a.name, artifactId: a.id, details: [], captured: { jql: got.jql } } : { result: 'missing', kind: a.kind, name: a.name, artifactId: a.id, details: ['queue not on the service desk'] });
    }
    for (const q of sd?.queues ?? []) if (!queues.some((a) => norm(a.name) === norm(q.name))) push({ result: 'extra', kind: 'queue', name: q.name, details: ['created by the template but not in the reference library'], captured: { jql: q.jql } });

    // Template parts with no read API (SLAs) are reported, never silently passed.
    for (const a of partsOf(artifacts, opts.jsmTemplate, 'sla')) push({ result: 'not-captured', kind: a.kind, name: a.name, artifactId: a.id, details: ['SLA configuration has no public read API; verify in Project settings → SLAs'] });
  }

  // ── Site-level fields (e.g. Approvers) ──────────────────────────────────
  for (const a of artifacts.filter((x) => x.kind === 'field')) {
    if (!cap.fields) { push({ result: 'not-captured', kind: a.kind, name: a.name, artifactId: a.id, details: ['fields were not captured'] }); continue; }
    const got = cap.fields.filter((f) => norm(f.name) === norm(a.name));
    if (!got.length) { push({ result: 'missing', kind: a.kind, name: a.name, artifactId: a.id, details: ['field not on the site'] }); continue; }
    push({ result: 'matched', kind: a.kind, name: a.name, artifactId: a.id, details: got.length > 1 ? [`${got.length} fields share this name; the builder must use the field id`] : [], captured: { fields: got.map((f) => ({ id: f.id, schemaType: f.schemaType, customType: f.customType })) } });
  }

  // ── Assets schema template ──────────────────────────────────────────────
  if (opts.assetsTemplate) {
    const tpl = byId.get(opts.assetsTemplate);
    if (!tpl) throw new Error(`unknown Assets template artifact ${opts.assetsTemplate}`);
    const as = cap.assets?.schema ? cap.assets : undefined;
    push(as
      ? { result: 'matched', kind: tpl.kind, name: tpl.name, artifactId: tpl.id, details: [], captured: { schemaKey: as.schema!.key, objectTypes: as.objectTypes.map((t) => ({ name: t.name, parent: t.parent })), statusTypes: as.statusTypes } }
      : { result: 'not-captured', kind: tpl.kind, name: tpl.name, artifactId: tpl.id, details: ['no Assets schema was captured'] });
    const types = partsOf(artifacts, opts.assetsTemplate, 'assets-object-type');
    for (const a of types) {
      if (!as) { push({ result: 'not-captured', kind: a.kind, name: a.name, artifactId: a.id, details: ['no Assets schema captured'] }); continue; }
      const got = byName(as.objectTypes, a.name);
      push(got
        ? { result: 'matched', kind: a.kind, name: a.name, artifactId: a.id, details: [], captured: { parent: got.parent, abstract: got.abstract, attributes: got.attributes } }
        : { result: 'missing', kind: a.kind, name: a.name, artifactId: a.id, details: [`object type not in schema "${as.schema!.name}"`] });
    }
    for (const t of as?.objectTypes ?? []) if (!types.some((a) => norm(a.name) === norm(t.name))) push({ result: 'extra', kind: 'assets-object-type', name: t.name, details: ['created by the template but not in the reference library'], captured: { parent: t.parent, attributes: t.attributes } });
  }

  const summary = { matched: 0, mismatched: 0, missing: 0, extra: 0, 'not-captured': 0 } as Record<FindingResult, number>;
  for (const f of findings) summary[f.result]++;
  return { site: cap.site, capturedAt: cap.capturedAt, scope: opts, findings, summary };
}

/** Markdown summary for humans (the JSON report is the machine artifact). */
export function renderReport(r: CompareReport, unavailable: Capture['unavailable'] = []): string {
  const icon: Record<FindingResult, string> = { matched: '✅', mismatched: '⚠️', missing: '❌', extra: '➕', 'not-captured': '⏸️' };
  const lines = [
    `# Reference capture: ${r.site}`, '', `Captured ${r.capturedAt}. Scope: ${[r.scope.jsmTemplate, r.scope.assetsTemplate].filter(Boolean).join(', ') || 'none'}.`, '',
    Object.entries(r.summary).map(([k, v]) => `${icon[k as FindingResult]} ${k}: ${v}`).join(' · '), '',
    '| Result | Kind | Name | Artifact | Details |', '|---|---|---|---|---|',
    ...r.findings.map((f) => `| ${icon[f.result]} ${f.result} | ${f.kind} | ${f.name} | ${f.artifactId ?? '—'} | ${f.details.join('; ').replace(/\|/g, '\\|') || ''} |`),
  ];
  if (unavailable.length) lines.push('', '## Endpoints that could not be read', '', ...unavailable.map((u) => `- ${u.what}${u.status ? ` (${u.status})` : ''}: ${u.message}`));
  return lines.join('\n') + '\n';
}
