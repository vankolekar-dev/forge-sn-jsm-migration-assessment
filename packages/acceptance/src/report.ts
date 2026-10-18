import type { AcceptancePlan, AcceptanceResult, CriterionStatus, Verdict } from './types';

const PLAN_ICON: Record<CriterionStatus, string> = { ready: '▶', blocked: '⛔', manual: '👤', excluded: '–' };
const VERDICT_ICON: Record<Verdict, string> = { pass: '✅', fail: '❌', error: '⚠️', partial: '◐', manual: '👤', blocked: '⛔', excluded: '–' };
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Readiness: what will run, and what blocks the rest (usually guided steps or persona credentials). */
export function renderAcceptancePlan(p: AcceptancePlan, phrase?: string): string {
  const L: string[] = [];
  L.push(`# Acceptance test plan: ${p.blueprintId} on ${p.site}`, '');
  L.push(`Run hash **${p.runHash}**. ${p.summary.ready} ready, ${p.summary.blocked} blocked, ${p.summary.manual} manual, ${p.summary.excluded} excluded.`, '');
  if (phrase) L.push(`To run the ready checks (creates tagged test requests and Assets objects, removed afterwards), confirm with: \`${phrase}\``, '');
  L.push('| | Criterion | Outcome | Steps | Why not ready |', '|---|---|---|---|---|');
  for (const c of p.criteria) L.push(`| ${PLAN_ICON[c.status]} ${c.status} | ${c.acId} | ${cell(c.statement)} | ${c.steps.map((s) => s.kind).join(' → ') || '—'} | ${cell(c.reasons.join('; ')) || ''} |`);
  L.push('', '## Test data', '', '| Fixture | Status | Detail |', '|---|---|---|');
  for (const f of p.fixtures) L.push(`| ${f.id} | ${f.status} | ${cell(f.status === 'unavailable' ? f.reasons.join('; ') : f.description)} |`);
  L.push('', '## Personas', '', '| Persona | Account id | Runner can act as it |', '|---|---|---|');
  for (const [name, v] of Object.entries(p.personas)) L.push(`| ${name} | ${v.accountId ?? (name === 'requester' ? '(runner account)' : name === 'agent' ? '(runner account)' : '—')} | ${v.canAct ? 'yes' : 'no'} |`);
  return L.join('\n') + '\n';
}

/** Outcome-parity report: verdict per outcome, then the evidence per criterion and step. */
export function renderAcceptanceResult(r: AcceptanceResult): string {
  const L: string[] = [];
  L.push(`# Acceptance results: ${r.blueprintId} on ${r.site}`, '');
  L.push(`Run ${r.runId} (plan ${r.runHash}), ${r.startedAt} → ${r.finishedAt}.`, '');
  const s = r.summary;
  L.push(`Outcomes: ${s.pass} pass, ${s.partial} partial, ${s.fail} fail, ${s.error} error, ${s.blocked} blocked, ${s.manual} manual${s.excluded ? `, ${s.excluded} excluded` : ''}.`, '');
  L.push('| | Outcome | Criteria |', '|---|---|---|');
  for (const o of r.outcomes) L.push(`| ${VERDICT_ICON[o.verdict]} ${o.verdict} | ${cell(o.statement)} | ${o.criteria.map((c) => `${VERDICT_ICON[c.verdict]} ${c.acId.split('.').pop()}`).join(', ')} |`);
  L.push('', '## Criteria', '');
  for (const o of r.outcomes) {
    for (const c of o.criteria) {
      L.push(`### ${VERDICT_ICON[c.verdict]} ${c.acId}${c.request ? ` (${c.request})` : ''}`, '');
      if (c.detail) L.push(c.detail, '');
      if (c.steps.length) {
        L.push('| # | Step | Result | Detail |', '|---|---|---|---|');
        for (const st of c.steps) L.push(`| ${st.index} | ${st.kind} | ${st.result} | ${cell(st.detail)} |`);
        L.push('');
      }
    }
  }
  if (r.manualChecks.length) {
    L.push('## Manual checks', '', 'These cannot be read back through an API. A person checks them in the sandbox:', '');
    for (const m of r.manualChecks) L.push(`- [ ] **${m.acId}**: ${m.check}`);
    L.push('');
  }
  L.push('## Test data', '', '| Fixture | Result | Object | Detail |', '|---|---|---|---|');
  for (const f of r.fixtures) L.push(`| ${f.id} | ${f.result} | ${f.objectKey ?? ''} | ${cell(f.detail ?? '')} |`);
  const c = r.ledger.cleanup;
  L.push('', c
    ? `Cleanup: removed ${c.removed.length} item(s)${c.leftovers.length ? `; **${c.leftovers.length} left over**: ${c.leftovers.map((x) => `${x.ref} (${x.error})`).join('; ')}` : '.'}`
    : `Test data kept for inspection (${r.ledger.requests.length} request(s), ${r.ledger.objects.length} object(s), tagged \`${r.ledger.tag}\`). Run the cleanup when done.`);
  if (r.warnings.length) L.push('', '## Warnings', '', ...r.warnings.map((w) => `- ${w}`));
  return L.join('\n') + '\n';
}
