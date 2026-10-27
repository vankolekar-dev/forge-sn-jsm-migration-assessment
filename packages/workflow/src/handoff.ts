/**
 * Handoff briefs: what an agent, or Solution Composer in JSM, needs to carry the build on from here.
 *
 *  - agent: for an AI agent with the snjsm-builder MCP tools (Rovo CLI, Claude, OpenAI Codex): where things stand,
 *    the next gated steps, the ground rules and how to connect the server.
 *  - solution-composer: plain-language prompts, one per capability, that describe the in-scope design so a person
 *    can paste them into Solution Composer. Solution Composer has no API, so a person stays in the loop.
 *
 * Both are pure functions of the blueprint and the facts the service gathers (state, guided steps, build list).
 * The proposed build list is summarised but never turned into build instructions: it has not been reviewed.
 * Forge-safe (no node: imports).
 */
import type { BuildState } from '@snjsm/builder';
import type { Blueprint, DesignElement, DesignElementType } from '@snjsm/model';
import { getCapability, READINESS_LABEL, READINESS_ORDER, type BuildList } from '@snjsm/reference';
import { cleanupPhrase, confirmPhrase, signOffPhrase, testPhrase } from './phrases';

export const HANDOFF_AUDIENCES = ['agent', 'solution-composer'] as const;
export type HandoffAudience = (typeof HANDOFF_AUDIENCES)[number];

export interface HandoffFacts {
  /** Blueprint path as the tools take it, relative to the work directory. */
  blueprintKey: string;
  site?: string;
  writeAllowed: boolean;
  signedOff: boolean;
  /** In-scope design elements (sign-off scope), in build order. */
  design: DesignElement[];
  state?: BuildState;
  pendingManual: { designId: string; title: string }[];
  buildList: BuildList;
}

const ORDER: DesignElementType[] = [
  'space', 'portal-group', 'work-type', 'workflow', 'field', 'form', 'request-type', 'queue', 'calendar', 'sla', 'team',
  'automation', 'notification', 'assets-schema', 'assets-object-type', 'assets-attribute', 'assets-reference-type', 'assets-status-type',
];
const rank = (t: DesignElementType) => { const i = ORDER.indexOf(t); return i < 0 ? ORDER.length : i; };
const q = (s: string) => `"${s}"`;
const human = (s: string) => s.replace(/[-_]/g, ' ');
const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);

/** The capability's display name from the reference catalogue, else its id. */
export function capabilityName(id: string): string { return getCapability(id)?.name ?? id; }

/**
 * Build order for prompts: first the foundation (elements that deliver no outcome themselves: the space, work types,
 * fields, schemas), keyed '', then each capability with the elements that deliver its outcomes. An element that
 * delivers outcomes of several capabilities goes with the first of them. Every in-scope element appears once.
 */
export function elementsByCapability(bp: Blueprint, design: DesignElement[]): Map<string, DesignElement[]> {
  const capOf = new Map(bp.outcomes.map((o) => [o.id, o.capabilityId]));
  const order = bp.capabilities.map((c) => c.capabilityId);
  const out = new Map<string, DesignElement[]>([['', []]]);
  for (const id of order) out.set(id, []);
  for (const e of design) {
    const caps = e.deliversOutcomeIds.map((o) => capOf.get(o)).filter((c): c is string => Boolean(c));
    const cap = order.find((c) => caps.includes(c)) ?? '';
    out.get(cap)!.push(e);
  }
  for (const [k, v] of out) if (!v.length) out.delete(k);
  return out;
}

/** Names for ids, including the statuses and transitions inside workflows. */
function namesOf(design: DesignElement[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of design) {
    m.set(e.id, e.name);
    if (e.type === 'workflow') {
      const s = e.spec as { statuses?: { id: string; name: string }[]; transitions?: { id?: string; name?: string }[] };
      for (const x of s.statuses ?? []) m.set(x.id, x.name);
      for (const x of s.transitions ?? []) if (x.id && x.name) m.set(x.id, x.name);
    }
  }
  return m;
}
const unstop = (s: string) => s.trim().replace(/\.+$/, '');

/** One line of plain language for a design element, resolving ids to names. */
export function describeElement(el: DesignElement, names: Map<string, string>): string {
  const name = (id: string | undefined) => (id ? names.get(id) ?? id : '');
  const cfg = (c: Record<string, unknown> | undefined) => Object.entries(c ?? {})
    .map(([k, v]) => `${human(k)} ${typeof v === 'string' && names.has(v) ? q(name(v)) : JSON.stringify(v)}`).join(', ');
  const step = (s: { type: string; config?: Record<string, unknown> }) => `${human(s.type)}${s.config && Object.keys(s.config).length ? ` (${cfg(s.config)})` : ''}`;
  switch (el.type) {
    case 'space': {
      const s = el.spec;
      return s.mode === 'existing' ? `Use the existing service space ${q(s.name)}${s.key ? ` (key ${s.key})` : ''}.`
        : `Create a service space ${q(s.name)}${s.key ? ` with key ${s.key}` : ''} from the ${s.templateKey ? 'template ' + s.templateKey : 'IT service management template'}.`;
    }
    case 'portal-group': return `Portal group ${q(el.spec.name)}.`;
    case 'work-type': return `Work type ${q(el.spec.name)}${el.spec.workflowId ? ` using workflow ${q(name(el.spec.workflowId))}` : ''}.`;
    case 'workflow': {
      const s = el.spec as { name: string; statuses?: { name: string }[]; transitions?: { name?: string; from?: string[]; to?: string }[] };
      return `Workflow ${q(s.name)} with statuses ${list((s.statuses ?? []).map((x) => x.name))}${s.transitions?.length ? ` and ${s.transitions.length} transitions` : ''}.`;
    }
    case 'field': {
      const s = el.spec as { name: string; fieldType?: string; systemFieldId?: string; options?: unknown[] };
      return s.systemFieldId ? `System field ${q(s.name)}.` : `Custom field ${q(s.name)} (${human(s.fieldType ?? 'text')}${s.options?.length ? `, ${s.options.length} options` : ''}).`;
    }
    case 'form': {
      const s = el.spec as { name: string; sections: { title?: string; fields: { fieldId: string; required?: boolean; condition?: string }[] }[] };
      const secs = s.sections.map((sec) => `${sec.title ? `section ${q(sec.title)}: ` : ''}${sec.fields.map((f) => `${name(f.fieldId)}${f.required ? ' (required' + (f.condition ? `, only when ${f.condition}` : '') + ')' : f.condition ? ` (only when ${f.condition})` : ''}`).join(', ')}`);
      return `Form ${q(s.name)}: ${secs.join('; ')}.`;
    }
    case 'request-type': {
      const s = el.spec as { name: string; description?: string; workTypeId?: string; portalGroupIds?: string[]; formId?: string };
      return `Request type ${q(s.name)}${s.description ? ` (${unstop(s.description)})` : ''}${s.portalGroupIds?.length ? ` in portal group ${list(s.portalGroupIds.map((g) => q(name(g))))}` : ''}${s.workTypeId ? `, on work type ${q(name(s.workTypeId))}` : ''}${s.formId ? `, with form ${q(name(s.formId))}` : ''}.`;
    }
    case 'queue': {
      const s = el.spec as { name: string; jql: string; columns?: string[] };
      return `Queue ${q(s.name)} showing \`${s.jql}\`${s.columns?.length ? ` with columns ${list(s.columns)}` : ''}.`;
    }
    case 'calendar': {
      const s = el.spec as { name: string; timeZone: string; workingHours: { days: string[]; start: string; end: string }[] };
      return `Calendar ${q(s.name)} (${s.workingHours.map((w) => `${w.days.join(', ')} ${w.start}–${w.end}`).join('; ')}, ${s.timeZone}).`;
    }
    case 'sla': {
      const s = el.spec as { name: string; start: string[]; pause: string[]; stop: string[]; goals: { jql?: string; target: { value: number; unit: string }; calendarId?: string }[] };
      const goals = s.goals.map((g) => `${g.target.value} ${human(g.target.unit)}${g.jql ? ` for \`${g.jql}\`` : ''}${g.calendarId ? ` on calendar ${q(name(g.calendarId))}` : ''}`);
      return `SLA ${q(s.name)}: starts on ${list(s.start)}${s.pause.length ? `, pauses on ${list(s.pause)}` : ''}, stops on ${list(s.stop)}; goal ${goals.join('; ')}.`;
    }
    case 'team': return `Team ${q(el.spec.name)}${(el.spec as { purpose?: string }).purpose ? `: ${unstop((el.spec as { purpose?: string }).purpose!)}` : ''}.`;
    case 'automation': {
      const s = el.spec as { name: string; trigger: { type: string; config?: Record<string, unknown> }; conditions: { type: string; config?: Record<string, unknown> }[]; actions: { type: string; config?: Record<string, unknown> }[] };
      return `Automation rule ${q(s.name)}: when ${step(s.trigger)}${s.conditions.length ? `, if ${s.conditions.map(step).join(' and ')}` : ''}, then ${s.actions.map(step).join(', then ')}.`;
    }
    case 'notification': {
      const s = el.spec as { name: string; audience?: string; event?: string; channel?: string };
      return `Notification ${q(s.name)}: ${s.channel ?? 'email'} to ${s.audience ?? 'customers'} on ${s.event ?? 'the default events'}.`;
    }
    case 'assets-schema': return `Assets schema ${q(el.spec.name)}${(el.spec as { key?: string }).key ? ` (key ${(el.spec as { key?: string }).key})` : ''}.`;
    case 'assets-object-type': return `Assets object type ${q(el.spec.name)}${(el.spec as { description?: string }).description ? `: ${unstop((el.spec as { description?: string }).description!)}` : ''}.`;
    case 'assets-attribute': {
      const s = el.spec as { name: string; objectTypeId?: string; attributeType?: string; referenceObjectTypeId?: string };
      return `Attribute ${q(s.name)} on ${q(name(s.objectTypeId))} (${human(s.attributeType ?? 'text')}${s.referenceObjectTypeId ? ` to ${q(name(s.referenceObjectTypeId))}` : ''}).`;
    }
    case 'assets-reference-type': return `Assets reference type ${q(el.spec.name)}.`;
    case 'assets-status-type': return `Assets status ${q(el.spec.name)}.`;
    default: return `${human((el as DesignElement).type)} ${q((el as DesignElement).name)}.`;
  }
}

function onSite(f: HandoffFacts, id: string): string | undefined {
  const s = f.state?.elements[id]?.status;
  return s && s !== 'failed' && s !== 'manual-pending' ? s : undefined;
}

function standing(bp: Blueprint, f: HandoffFacts): string[] {
  const built = f.design.filter((e) => onSite(f, e.id)).length;
  const caps = bp.capabilities.filter((c) => c.status !== 'detected' && c.status !== 'out-of-scope');
  const t = f.buildList.totals;
  return [
    `- **Blueprint:** \`${f.blueprintKey}\` (${bp.id}) for ${bp.customer.name}`,
    `- **Target site:** ${f.site ?? 'not chosen yet'}${f.site ? (f.writeAllowed ? ' (writes allowed)' : ' (read-only: not in SNJSM_WRITE_SITES)') : ''}`,
    `- **Signed off:** ${f.signedOff ? 'yes' : 'no'}`,
    `- **Capabilities:** ${caps.length ? caps.map((c) => {
      const os = bp.outcomes.filter((o) => o.capabilityId === c.capabilityId);
      const n = (s: string) => os.filter((o) => o.status === s).length;
      return `${capabilityName(c.capabilityId)} (${c.status}; ${n('confirmed')} outcomes confirmed${n('deferred') ? `, ${n('deferred')} deferred` : ''}${n('rejected') ? `, ${n('rejected')} rejected` : ''})`;
    }).join('; ') : 'none proposed yet'}`,
    `- **Design in scope:** ${f.design.length} elements; ${built} on the site${f.pendingManual.length ? `; ${f.pendingManual.length} guided steps pending` : ''}`,
    `- **Everything else ServiceNow has:** ${t.proposed} components on the build list (proposed, not reviewed), ${t.covered} already covered by the blueprint`,
  ];
}

function nextSteps(bp: Blueprint, f: HandoffFacts): string[] {
  const site = f.site ?? '<site>';
  const steps: string[] = [];
  if (!f.site) steps.push('Ask the person which sandbox site to build on (`blueprint_summary` shows the default), and use it as `site`.');
  if (!f.signedOff) {
    steps.push(`Call \`signoff_review\`, walk the person through every outcome and its acceptance criteria, and wait. Only call \`signoff_record\` when they have typed \`${signOffPhrase('<signHash>', bp.id)}\` themselves.`);
  }
  const unbuilt = f.design.filter((e) => !f.state?.elements[e.id]);
  if (unbuilt.length) {
    steps.push(`Call \`build_plan\` (a dry-run), show the person what would be created, changed or left as guided steps, and wait. Only call \`build_apply\` when they have typed \`${confirmPhrase('<planHash>', site)}\`${f.writeAllowed ? '' : ' (and the site is in SNJSM_WRITE_SITES)'}.`);
  }
  if (f.pendingManual.length || unbuilt.length) {
    const next = f.pendingManual.slice(0, 3).map((m) => `“${m.title.length > 90 ? `${m.title.slice(0, 89)}…` : m.title}”`);
    steps.push(`Call \`build_manual_steps\` and guide the person through each step in the JSM UI${next.length ? `, starting with ${list(next)}` : ''}. Record each one with \`build_confirm_manual\` once they say it is done.`);
  }
  steps.push('Call `build_verify` and report anything that is drift or missing.');
  steps.push(`Call \`acceptance_plan\`, show what is ready and what is blocked, and only call \`acceptance_run\` when the person has typed \`${testPhrase('<runHash>', site)}\`. Remove leftovers with \`acceptance_cleanup\` and \`${cleanupPhrase('<runId>', site)}\`.`);
  steps.push('Optionally call `build_work_breakdown` to create the Jira epics and stories for the remaining work.');
  return steps.map((s, i) => `${i + 1}. ${s}`);
}

/** Brief for an AI agent that has (or can be given) the snjsm-builder MCP tools. */
export function agentBrief(bp: Blueprint, f: HandoffFacts): string {
  const t = f.buildList.totals;
  return [
    `# Handoff brief: ${bp.name}`,
    '',
    'For an AI agent with the **snjsm-builder** MCP tools: Rovo CLI, Claude (Code or Desktop) or OpenAI Codex.',
    'You are continuing a ServiceNow → Jira Service Management migration that is driven by outcomes the customer signed off.',
    '',
    '## Where things stand',
    '',
    ...standing(bp, f),
    '',
    '## What to do next',
    '',
    ...nextSteps(bp, f),
    '',
    '## Ground rules',
    '',
    '- Build only the signed-off design. The tools refuse anything else; do not work around them with direct API calls.',
    '- Never type or invent a gate phrase. Show it, then wait for the person to type it themselves.',
    '- Build only on sandbox sites listed in SNJSM_WRITE_SITES. Never on production.',
    '- The build list is **proposed, not reviewed**. Use `build_list` to discuss what else ServiceNow has, but never build from it: to bring something in, propose it to the person as a new outcome or capability, which then needs analysis and sign-off.',
    '- Guided steps happen in the JSM UI. Give the person the exact values, and record the result only when they confirm.',
    '- When you finish, report what changed with links, what is still pending, and anything that failed.',
    '',
    '## Tools',
    '',
    '| Stage | Tools |',
    '|---|---|',
    '| Understand | `blueprint_summary`, `build_status`, `build_list` |',
    '| Target | `blueprint_set_space` |',
    '| Sign-off | `signoff_review`, `signoff_record` |',
    '| Build | `build_plan`, `build_apply`, `build_manual_steps`, `build_confirm_manual`, `build_verify` |',
    '| Acceptance | `acceptance_plan`, `acceptance_run`, `acceptance_cleanup` |',
    '| Plan the remaining work | `build_work_breakdown` |',
    '| This brief | `blueprint_handoff` |',
    '',
    '## Connect the tools',
    '',
    'Build the repo once (`npm run build`), then register the stdio server. Use the same environment in every client:',
    '',
    '```json',
    '{ "SNJSM_WORKDIR": "/path/to/repo/out", "SNJSM_SITE": "' + (f.site ?? 'acme-sandbox.atlassian.net') + '", "SNJSM_WRITE_SITES": "' + (f.site ?? 'acme-sandbox.atlassian.net') + '" }',
    '```',
    '',
    '- **Rovo CLI and Claude Code:** `.mcp.json` in the repo, under `mcpServers.snjsm-builder` with `"command": "node"` and `"args": ["/path/to/repo/packages/mcp-server/dist/server.js"]`. Rovo CLI also picks up the `sn-jsm-outcome-migration` skill in this repo.',
    '- **Claude Desktop:** the same entry in `claude_desktop_config.json`.',
    '- **OpenAI Codex:** `~/.codex/config.toml`:',
    '',
    '```toml',
    '[mcp_servers.snjsm-builder]',
    'command = "node"',
    'args = ["/path/to/repo/packages/mcp-server/dist/server.js"]',
    'env = { SNJSM_WORKDIR = "/path/to/repo/out", SNJSM_SITE = "' + (f.site ?? 'acme-sandbox.atlassian.net') + '", SNJSM_WRITE_SITES = "' + (f.site ?? 'acme-sandbox.atlassian.net') + '" }',
    '```',
    '',
    `Without MCP, the same steps are \`npm run jsm -- <command>\` (\`npm run jsm -- help\`). The build list covers ${t.proposed} components; \`npm run jsm -- build-list\` prints it.`,
  ].join('\n');
}

/** Plain-language prompts for Solution Composer, one per capability, from the in-scope design. */
export function composerBrief(bp: Blueprint, f: HandoffFacts): string {
  const names = namesOf(bp.design);
  const groups = elementsByCapability(bp, f.design);
  const lines = [
    `# Solution Composer prompts: ${bp.name}`,
    '',
    '> Paste one prompt at a time into Solution Composer in Jira Service Management, review what it proposes, and accept only what matches.',
    '> Keep the names exactly as written, so `build_verify` can check the result against the design afterwards.',
    ...(f.signedOff ? [] : ['>', '> **Not signed off yet:** these prompts describe a draft design. Get sign-off before building anything a customer will rely on.']),
    '',
  ];
  let n = 0;
  for (const capId of groups.keys()) {
    const els = [...groups.get(capId)!].sort((a, b) => rank(a.type) - rank(b.type));
    const todo = els.filter((e) => !onSite(f, e.id));
    const done = els.filter((e) => onSite(f, e.id));
    const outcomes = bp.outcomes.filter((o) => o.capabilityId === capId && o.status === 'confirmed');
    const space = els.find((e) => e.type === 'space') ?? f.design.find((e) => e.type === 'space');
    lines.push(`## ${++n}. ${capId ? capabilityName(capId) : 'Foundation (do this first)'}`, '');
    if (!capId) lines.push('What the capabilities below build on: the space, work types, fields and Assets schema.', '');
    if (!todo.length) { lines.push('Everything here is already on the site.', ''); continue; }
    const where = space && space.type === 'space' ? ` in the Jira Service Management space ${q(space.spec.name)}${space.spec.key ? ` (key ${space.spec.key})` : ''}` : '';
    lines.push('```text');
    lines.push(capId ? `Set up ${q(capabilityName(capId))}${where}.` : `Set up the foundation for the service${where}.`);
    if (outcomes.length) lines.push('', 'It must achieve these outcomes:', ...outcomes.map((o) => `- ${o.statement}`));
    lines.push('', 'Create:');
    for (const e of todo) lines.push(`- ${describeElement(e, names)}`);
    if (done.length) lines.push('', `These already exist; reuse them and do not create copies: ${list(done.map((e) => q(e.name)))}.`);
    lines.push('```', '');
  }
  if (!f.design.length) lines.push('No design elements are in scope yet.', '');
  const t = f.buildList.totals;
  lines.push(
    '## Not included: everything else ServiceNow has',
    '',
    `${t.proposed} more ServiceNow components have a proposed JSM answer on the build list. It is **not reviewed**, so there are no prompts for it here: bring an item into a capability (outcome, design and sign-off) first.`,
    '',
    '| Readiness | Components |', '|---|---|',
    ...READINESS_ORDER.filter((r) => t.byReadiness[r]).map((r) => `| ${READINESS_LABEL[r]} | ${t.byReadiness[r]} |`),
  );
  return lines.join('\n');
}

export function handoffBrief(audience: HandoffAudience, bp: Blueprint, f: HandoffFacts): string {
  return audience === 'agent' ? agentBrief(bp, f) : composerBrief(bp, f);
}
