import type { ApplyResult } from './engine';
import type { ManualStep, Plan, VerifyReport } from './types';

const esc = (s: unknown) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
const table = (head: string[], rows: unknown[][]) => (rows.length ? [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(esc).join(' | ')} |`)].join('\n') : '_None._');
const ICON: Record<string, string> = { noop: '✔︎', adopt: '🔗', create: '➕', update: '✏️', manual: '🖐', blocked: '⏸', done: '✅', failed: '❌', skipped: '⏭', ok: '✅', drift: '⚠️', missing: '❌', pending: '🖐', unverifiable: '👁', 'not-built': '·', error: '❌' };

export function renderManual(m: ManualStep, n?: number): string {
  return [
    `### ${n !== undefined ? `${n}. ` : ''}${m.title}`,
    `_Why:_ ${m.why} · _Where:_ ${m.where} · _Record:_ ${m.record === 'remote-id' ? 'the site id' : 'confirmation'} (\`${m.designId}\`)`,
    '', ...m.instructions.map((i) => (i.startsWith('•') ? `  - ${i.slice(1).trim()}` : `- ${i}`)),
    '', '**Check**', ...m.checks.map((c) => `- [ ] ${c}`),
  ].join('\n');
}

export function renderPlan(p: Plan): string {
  const out = [
    `# Build plan (${p.mode}) for \`${p.blueprintId}\``,
    `${p.site ? `Site **${p.site}** · ` : ''}plan hash \`${p.planHash}\` · ${p.createdAt.slice(0, 16).replace('T', ' ')} UTC${p.scope.capabilityIds?.length ? ` · capabilities ${p.scope.capabilityIds.join(', ')}` : ''}`,
    '',
    Object.entries(p.summary).filter(([, v]) => v).map(([k, v]) => `${ICON[k]} ${k} **${v}**`).join(' · '),
    p.mode === 'offline' ? '\n> Offline plan: nothing was read from the site. Run a dry-run to see exactly what exists.' : '',
    '\n## Steps (build order)',
    table(['#', 'Action', 'Type', 'Element', 'Coverage', 'Why'], p.steps.map((s, i) => [i + 1, `${ICON[s.action]} ${s.action}`, s.type, s.name, s.coverage, s.reason])),
  ];
  const reqs = p.steps.filter((s) => s.requests?.length);
  if (reqs.length) {
    out.push('\n## API requests apply would send', '_Payloads are unverified until the write probes pass in a sandbox. `<design-id>` = id of something built earlier in the run._');
    for (const s of reqs) out.push(`\n**${s.name}** (\`${s.designId}\`)\n\n\`\`\`json\n${JSON.stringify(s.requests, null, 2)}\n\`\`\``);
  }
  const manual = p.steps.filter((s) => s.manual);
  if (manual.length) { out.push('\n## Guided steps'); manual.forEach((s, i) => out.push(renderManual(s.manual!, i + 1))); }
  if (p.warnings.length) out.push('\n## Warnings', ...p.warnings.map((w) => `- ${w}`));
  return out.join('\n') + '\n';
}

export function renderApply(r: ApplyResult): string {
  return [
    `# Apply result (plan \`${r.planHash}\`)`,
    Object.entries(r.summary).filter(([, v]) => v).map(([k, v]) => `${ICON[k]} ${k} **${v}**`).join(' · '),
    '', table(['Element', 'Action', 'Result', 'Site id', 'Detail'], r.results.map((x) => [x.designId, x.action, `${ICON[x.result]} ${x.result}`, x.remote ? x.remote.key ?? x.remote.id : '', x.detail ?? ''])),
    r.manual.length ? `\n## Guided steps to do now\n\n${r.manual.map((m, i) => renderManual(m, i + 1)).join('\n\n')}` : '',
  ].join('\n') + '\n';
}

export function renderVerify(v: VerifyReport): string {
  return [
    `# Build verification on ${v.site}`, `_${v.at.slice(0, 16).replace('T', ' ')} UTC. Checks the build matches the design; outcome acceptance tests run separately._`, '',
    Object.entries(v.summary).filter(([, n]) => n).map(([k, n]) => `${ICON[k]} ${k} **${n}**`).join(' · '),
    '', table(['Element', 'Type', 'Status', 'Detail'], v.results.map((x) => [x.name, x.type, `${ICON[x.status]} ${x.status}`, x.detail])),
  ].join('\n') + '\n';
}
