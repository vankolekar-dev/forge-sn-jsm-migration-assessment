import type { Blueprint, Outcome } from '@snjsm/model';
import { getReferenceArtifact } from '@snjsm/reference';
import type { AnalysisResult } from './analyse';
import type { AreaAssessment, AssessmentFinding, Severity } from './assess/types';
import { fmt } from './params';

const SEV_ORDER: Severity[] = ['blocker', 'high', 'medium', 'low', 'info'];
const SEV_ICON: Record<Severity, string> = { blocker: '⛔', high: '🔴', medium: '🟠', low: '🟡', info: 'ℹ️' };
const esc = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const table = (head: string[], rows: unknown[][]) => rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n') : '_None._';
const list = (xs: string[]) => (xs.length ? xs.map((x) => `- ${x}`).join('\n') : '_None._');

function finding(fd: AssessmentFinding, names: (ids: string[]) => string): string {
  const lines = [`- ${SEV_ICON[fd.severity]} **${fd.title}**${fd.effort ? ` _(effort ${fd.effort})_` : ''}`];
  if (fd.detail) lines.push(`  - ${fd.detail}`);
  if (fd.approach) lines.push(`  - **Atlassian approach:** ${fd.approach}`);
  if (fd.recommendation) lines.push(`  - **Recommendation:** ${fd.recommendation}`);
  if (fd.evidenceIds.length) lines.push(`  - Evidence: ${names(fd.evidenceIds)}`);
  return lines.join('\n');
}

function area(a: AreaAssessment, names: (ids: string[]) => string): string {
  const metrics = Object.entries(a.metrics).filter(([k]) => !k.includes(':')).map(([k, v]) => `${k}: **${v}**`).join(' · ');
  const fs = [...a.findings].sort((x, y) => SEV_ORDER.indexOf(x.severity) - SEV_ORDER.indexOf(y.severity));
  return [`### ${a.title}`, a.summary, metrics ? `\n${metrics}` : '', '', fs.map((x) => finding(x, names)).join('\n') || '_No findings._'].join('\n');
}

function outcomeBlock(o: Outcome, names: (ids: string[]) => string): string {
  const d = o.derivation;
  const params = Object.entries(o.parameters);
  return [
    `#### ${o.category}: ${o.statement}`,
    `_Id_ \`${o.id}\` · _priority_ ${o.priority} · _derived by_ ${d?.method ?? '—'} · _confidence_ **${d?.confidence ?? '—'}**`,
    params.length ? `\nParameters: ${params.map(([k, v]) => `\`${k}\` = **${fmt(v)}**`).join(', ')}` : '',
    d?.rationale ? `\n> ${d.rationale}` : '',
    o.notes ? `\n⚠️ ${o.notes}` : '',
    '\nAcceptance tests:',
    ...o.acceptance.map((ac) => `- **Given** ${ac.given}, **when** ${ac.when}, **then** ${ac.then.join('; ')} _(${ac.verification})_`),
    o.evidenceIds.length ? `\nEvidence (${o.evidenceIds.length}): ${names(o.evidenceIds)}` : '\nEvidence: none (reference outcome).',
  ].filter(Boolean).join('\n');
}

/** Customer-ready assessment report in Markdown. */
export interface ReferenceConfidence {
  /** Reference artifacts the design relies on, with their verification and the design elements using them. */
  artifacts: { id: string; name: string; status: 'verified' | 'unverified' | 'deprecated' | 'missing'; verifiedOn?: string; notes?: string; elements: string[] }[];
  verified: number;
  unverified: number;
  deprecated: number;
}

/** How much of the design rests on reference facts confirmed on a live site. */
export function referenceConfidence(bp: Blueprint): ReferenceConfidence {
  const by = new Map<string, ReferenceConfidence['artifacts'][number]>();
  for (const d of bp.design) {
    if (!d.referenceId || d.origin === 'extension') continue;
    let r = by.get(d.referenceId);
    if (!r) {
      const art = getReferenceArtifact(d.referenceId);
      r = { id: d.referenceId, name: art?.name ?? d.referenceId, status: art?.verification.status ?? 'missing', ...(art?.verification.verifiedOn ? { verifiedOn: art.verification.verifiedOn } : {}), ...(art?.verification.notes ? { notes: art.verification.notes } : {}), elements: [] };
      by.set(d.referenceId, r);
    }
    if (!r.elements.includes(d.name)) r.elements.push(d.name);
  }
  const artifacts = [...by.values()].sort((x, y) => ['deprecated', 'missing', 'unverified', 'verified'].indexOf(x.status) - ['deprecated', 'missing', 'unverified', 'verified'].indexOf(y.status) || x.id.localeCompare(y.id));
  const n = (st: string) => artifacts.filter((x) => x.status === st).length;
  return { artifacts, verified: n('verified'), unverified: n('unverified'), deprecated: n('deprecated') + n('missing') };
}

export function renderReport({ blueprint: bp, assessment: a }: AnalysisResult): string {
  const ev = new Map(bp.evidence.map((e) => [e.id, e]));
  const names = (ids: string[], n = 8) => {
    const shown = ids.slice(0, n).map((id) => (ev.get(id) ? `${ev.get(id)!.name}` : id)).map((s) => `\`${s.slice(0, 60)}\``);
    return `${shown.join(', ')}${ids.length > n ? ` … +${ids.length - n} more` : ''}`;
  };
  const findings = a.areas.flatMap((x) => x.findings);
  const risks = findings.filter((x) => x.severity === 'blocker' || x.severity === 'high');
  const caps = bp.capabilities;
  const covered = a.practices.filter((p) => p.covered);
  const uncovered = a.practices.filter((p) => !p.covered);
  const lowConf = bp.outcomes.filter((o) => o.derivation?.confidence === 'low');
  const cmdbArea = a.areas.find((x) => x.area === 'cmdb');
  const cmdbDetails = cmdbArea?.details as { objectTypes?: { label: string; origin: string; classes: string[]; population: number }[]; buildPasses?: { pass: number; what: string; items: string[] }[] } | undefined;
  const errors = a.validation.filter((i) => i.severity === 'error');
  const refs = referenceConfidence(bp);
  const extensions = bp.design.filter((d) => d.origin === 'extension');

  const out: string[] = [];
  out.push(`# ServiceNow → Jira Service Management assessment: ${bp.customer.name}`);
  out.push(`_Generated ${a.generatedAt.slice(0, 16).replace('T', ' ')} UTC from ${a.source.kind === 'servicenow-live' ? `live instance ${a.source.instance}` : `XML export(s): ${a.source.name}`}. Reference catalogue ${bp.referenceLibraryVersion}. Blueprint \`${bp.id}\`._`);
  out.push('> Method: ServiceNow configuration is treated as **evidence** of business outcomes. The target is designed from **Atlassian reference models**; anything beyond them is an extension that must be justified. Success is proven by the acceptance tests below, run in a sandbox. No data is migrated.');

  out.push('## 1. Executive summary');
  out.push(list([
    `**Complexity: ${a.score.score}/100 (${a.score.band}).**`,
    `${a.extraction.evidence} evidence items from ${Object.values(bp.sources[0]?.stats ?? {}).reduce((n, v) => n + v, 0)} records across ${Object.keys(bp.sources[0]?.stats ?? {}).length} tables.`,
    `${a.practices.filter((p) => !p.parent).length} practices found (${a.practices.filter((p) => p.parent).length} sub-practices); ${covered.length} of ${a.practices.length} covered by the reference catalogue.`,
    `${caps.length} capabilit${caps.length === 1 ? 'y' : 'ies'} matched: ${caps.map((c) => `${c.capabilityId} (${c.status}, fit ${c.fit?.score ?? '—'}%)`).join(', ') || 'none'}.`,
    `${bp.outcomes.length} outcomes proposed for sign-off (${lowConf.length} low confidence); ${bp.design.length} design elements, ${bp.design.filter((d) => d.origin === 'extension').length} extensions.`,
    `Reference confidence: the design relies on ${refs.artifacts.length} Atlassian reference facts; ${refs.verified} verified on a live site, ${refs.unverified} not yet verified${refs.deprecated ? `, **${refs.deprecated} contradicted by a site capture (fix the design before sign-off)**` : ''}.`,
    `${risks.length} high-severity or blocking findings.`,
    a.hasUsage ? `Usage window: ${a.usageDays ?? '?'} days.` : 'No usage data: this is a configuration-only view.',
  ]));

  out.push('## 2. Complexity score');
  out.push(table(['Factor', 'Value', 'Weight', 'Points'], a.score.factors.map((f) => [f.label, f.value, f.weight, f.points])));

  out.push('## 3. Practices and catalogue coverage');
  out.push(table(['Practice', 'Domain', 'Evidence', 'Volume', 'Capabilities', 'Covered'], a.practices.map((p) => [p.parent ? `↳ ${p.label}` : p.label, p.domain, p.evidenceIds.length, p.volume ?? '—', p.capabilityIds.join(', ') || '—', p.covered ? '✅' : '❌'])));

  out.push('## 4. Capabilities');
  for (const c of a.capabilities) {
    const sel = caps.find((s) => s.capabilityId === c.capabilityId)!;
    out.push(`### ${c.name} (\`${c.capabilityId}\`)`);
    out.push(list([
      `Status **${sel.status}**, detection score ${c.detection.score}${c.detection.volume !== undefined ? `, ${c.detection.volume} requests in the window` : ''}.`,
      `Core evidence: ${names(c.detection.coreEvidenceIds)}`,
      ...c.detection.notes,
      `Signals: ${c.detection.signals.map((s) => `${s.description} ${Math.round(s.strength * 100)}%${s.local ? '' : ' (not linked)'}`).join('; ') || '—'}`,
      `Build: ${c.buildability.automatedPct}% of elements via API; ${c.buildability.manual.length} need guided manual steps.`,
    ]));
    out.push('**Parameters**');
    out.push(table(['Parameter', 'Value', 'Method', 'Confidence', 'Why', 'Alternatives'], c.parameters.map((p) => [p.name, fmt(p.value), p.method, p.confidence, p.rationale, p.alternatives.map((x) => fmt(x.value)).join(', ') || '—'])));
    if (sel.fit) {
      out.push(`**Fit / gap:** ${sel.fit.score}% (reference ${sel.fit.counts.reference}, configured ${sel.fit.counts.configured}, extension ${sel.fit.counts.extension}).`);
      out.push(table(['Gap', 'Resolution', 'Evidence'], sel.fit.gaps.map((g) => [g.description, g.resolution, names(g.evidenceIds, 4)])));
    }
    if (c.buildability.manual.length) {
      out.push('**Guided manual steps (no public API)**');
      out.push(table(['Element', 'Type', 'Status', 'Aspects'], c.buildability.manual.map((m) => [m.name, m.type, m.status, m.aspects.join(', ')])));
    }
  }

  out.push('## 5. Outcomes for sign-off');
  out.push('Each outcome is platform-neutral. Confirm, change or reject it in the workshop; its acceptance tests become the definition of done.');
  for (const o of bp.outcomes) out.push(outcomeBlock(o, names));

  out.push('## 6. Target design (Atlassian reference)');
  out.push(table(['Element', 'Type', 'Origin', 'Reference', 'Delivers', 'Notes'], bp.design.map((d) => [d.name, d.type, d.origin, d.referenceId ?? '—', d.deliversOutcomeIds.length, d.notes ?? ''])));
  out.push('### Reference confidence');
  out.push('Which Atlassian reference facts the design relies on, and whether they were confirmed by capturing a fresh template on a live site. Unverified facts are assumptions: confirm them before relying on the plan.');
  out.push(table(['Reference', 'Status', 'Checked', 'Used by', 'Notes'], refs.artifacts.map((r) => [`${r.name} (\`${r.id}\`)`, { verified: '✅ verified', unverified: '⚠️ unverified', deprecated: '⛔ contradicted', missing: '⛔ not in library' }[r.status], r.verifiedOn ?? '—', r.elements.slice(0, 4).join(', ') + (r.elements.length > 4 ? ` +${r.elements.length - 4}` : ''), r.notes ?? ''])));
  out.push('### Extensions and why');
  out.push(table(['Element', 'Type', 'Why', 'Outcomes', 'Alternatives considered'], extensions.map((d) => [d.name, d.type, d.justification?.reason ?? '⛔ no justification', d.justification?.outcomeIds.join(', ') || '—', d.justification?.alternativesConsidered.join('; ') || '—'])));

  out.push('## 7. Findings by area');
  for (const x of a.areas) out.push(area(x, names));

  out.push('## 8. CMDB → Assets plan');
  if (cmdbDetails?.objectTypes?.length) {
    out.push(table(['Object type', 'Origin', 'CIs', 'From classes'], cmdbDetails.objectTypes.map((t) => [t.label, t.origin, t.population, t.classes.slice(0, 6).join(', ') + (t.classes.length > 6 ? ` +${t.classes.length - 6}` : '')])));
    out.push('**Build passes**');
    out.push(list((cmdbDetails.buildPasses ?? []).map((p) => `Pass ${p.pass}: ${p.what}${p.items.length ? ` (${p.items.slice(0, 12).join(', ')}${p.items.length > 12 ? ' …' : ''})` : ''}`)));
  } else out.push(cmdbArea?.summary ?? '_Not assessed._');

  out.push('## 9. Risks and blockers');
  out.push(risks.length ? risks.map((x) => finding(x, names)).join('\n') : '_None found._');

  out.push('## 10. Unknowns');
  out.push(table(['Topic', 'Detail', 'How to resolve'], a.unknowns.map((u) => [u.topic, u.detail, u.howToResolve])));

  out.push('## 11. Next steps');
  out.push(list([
    'Outcome workshop: confirm, change or reject each outcome and its parameters (low-confidence ones first).',
    uncovered.length ? `Decide scope for practices with no catalogue capability yet: ${uncovered.filter((p) => !p.parent).map((p) => p.label).join(', ')}.` : 'All detected practices are covered by the catalogue.',
    'Resolve risks and blockers (section 9), especially credentials and high-complexity scripts.',
    a.hasUsage ? 'Retire unused catalog items and scripts with no business behaviour.' : 'Run the live collector for usage and CMDB counts.',
    'Sign off the blueprint, then generate the build plan (dry-run) against a sandbox site.',
    'Run the acceptance tests in the sandbox to prove outcome parity.',
  ]));

  out.push('## Appendix: blueprint validation');
  out.push(a.validation.length ? `${errors.length} errors, ${a.validation.length - errors.length} warnings.\n\n${list(a.validation.slice(0, 40).map((i) => `${i.severity}: \`${i.path}\` ${i.message}`))}` : 'Blueprint is valid.');
  return out.join('\n\n') + '\n';
}

/** One-line console summary. */
export function summaryLine(bp: Blueprint, score: number): string {
  return `${bp.customer.name}: score ${score}, ${bp.capabilities.length} capabilities, ${bp.outcomes.length} outcomes, ${bp.design.length} design elements, ${bp.evidence.length} evidence`;
}
