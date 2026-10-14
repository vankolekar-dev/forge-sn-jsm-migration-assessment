import type { AtlassianClient } from '@snjsm/atlassian';
import type { CoverageStatus } from '@snjsm/model';

/**
 * API coverage spike: settle the "unknown" rows of the coverage matrix with evidence from a real site.
 * - Read probes: GET (or allow-listed query POST) only. Safe on any site.
 * - Write probes: create a throwaway item in a SANDBOX project, then delete it. Only with --write.
 * A read probe proves an endpoint family exists; only a write probe can prove "create" is possible.
 * Internal/private endpoints (/rest/servicedesk/1/...) are never probed: the builder must not depend on them.
 */
export interface CoverageKey { elementType: string; operation: 'create' | 'configure' | 'read'; aspect?: string }

export type ProbeOutcome = 'available' | 'not-found' | 'forbidden' | 'unsupported' | 'error' | 'skipped';

export interface ProbeResult {
  probe: string;
  mode: 'read' | 'write';
  coverage: CoverageKey;
  outcome: ProbeOutcome;
  http?: number;
  endpoint?: string;
  evidence: string;
  /** Only set when the evidence is strong enough to change the coverage matrix. */
  suggests?: { status: CoverageStatus; confidence: 'high' | 'medium' | 'low' };
}

export interface Leftover { what: string; id: string; cleanup: string; error: string }

export interface SpikeContext {
  client: AtlassianClient;
  /** Project used for read probes (e.g. the reference project REFITSM). */
  projectKey: string;
  /** Throwaway project for write probes. Must differ from projectKey. */
  sandboxKey?: string;
  write: boolean;
  /** Unique suffix for throwaway names, so leftovers are easy to find. */
  tag: string;
}

export interface SpikeReport {
  site: string;
  ranAt: string;
  write: boolean;
  results: ProbeResult[];
  leftovers: Leftover[];
}

interface Probe {
  id: string;
  mode: 'read' | 'write';
  coverage: CoverageKey;
  run(ctx: SpikeContext, env: ProbeEnv): Promise<Omit<ProbeResult, 'probe' | 'mode' | 'coverage'>>;
}

interface ProbeEnv {
  /** Memoised lookups shared across probes. */
  serviceDesk(key: string): Promise<{ id: string; projectId: string } | undefined>;
  /** Register a cleanup; it runs after all probes, newest first. */
  cleanup(what: string, id: string, describe: string, fn: () => Promise<unknown>): void;
}

const outcomeOf = (status: number): ProbeOutcome =>
  status >= 200 && status < 300 ? 'available' : status === 404 ? 'not-found' : status === 401 || status === 403 ? 'forbidden' : status === 405 || status === 501 ? 'unsupported' : 'error';

const brief = (json: unknown) => (typeof json === 'string' ? json : JSON.stringify(json ?? '')).slice(0, 240);

async function get(ctx: SpikeContext, url: string, headers?: Record<string, string>) {
  const r = await ctx.client.raw('GET', url, undefined, headers);
  return { http: r.status, outcome: outcomeOf(r.status), endpoint: `GET ${url.replace(/^https:\/\/[^/]+/, '')}`, json: r.json };
}

const JSM = { 'X-ExperimentalApi': 'opt-in' };

// ── Probes ────────────────────────────────────────────────────────────────

const PROBES: Probe[] = [
  {
    id: 'portal-group.read',
    mode: 'read',
    coverage: { elementType: 'portal-group', operation: 'read' },
    async run(ctx, env) {
      const sd = await env.serviceDesk(ctx.projectKey);
      if (!sd) return { outcome: 'skipped', evidence: `no service desk for ${ctx.projectKey}` };
      const r = await get(ctx, `${ctx.client.siteUrl}/rest/servicedeskapi/servicedesk/${sd.id}/requesttypegroup`, JSM);
      return { ...r, evidence: r.outcome === 'available' ? `${(r.json as any)?.values?.length ?? 0} groups readable` : brief(r.json) };
    },
  },
  {
    id: 'portal-group.create',
    mode: 'write',
    coverage: { elementType: 'portal-group', operation: 'create' },
    async run(ctx, env) {
      const sd = await env.serviceDesk(ctx.sandboxKey!);
      if (!sd) return { outcome: 'skipped', evidence: `no service desk for sandbox ${ctx.sandboxKey}` };
      const url = `${ctx.client.siteUrl}/rest/servicedeskapi/servicedesk/${sd.id}/requesttypegroup`;
      const r = await ctx.client.raw('POST', url, { name: `zz-spike-${ctx.tag}` }, JSM);
      const outcome = outcomeOf(r.status);
      if (outcome === 'available') {
        const id = String((r.json as any)?.id ?? '');
        env.cleanup('portal group', id, `DELETE ${url}/${id}`, () => ctx.client.call('DELETE', `${url}/${id}`, undefined, JSM));
        return { outcome, http: r.status, endpoint: `POST …/requesttypegroup`, evidence: `created group ${id}`, suggests: { status: 'api', confidence: 'high' } };
      }
      return { outcome, http: r.status, endpoint: `POST …/requesttypegroup`, evidence: brief(r.json), suggests: outcome === 'not-found' || outcome === 'unsupported' ? { status: 'ui-only', confidence: 'medium' } : undefined };
    },
  },
  {
    id: 'request-type.fields.read',
    mode: 'read',
    coverage: { elementType: 'request-type', operation: 'configure', aspect: 'field layout' },
    async run(ctx, env) {
      const sd = await env.serviceDesk(ctx.projectKey);
      if (!sd) return { outcome: 'skipped', evidence: `no service desk for ${ctx.projectKey}` };
      const rts = await get(ctx, `${ctx.client.siteUrl}/rest/servicedeskapi/servicedesk/${sd.id}/requesttype?limit=1`, JSM);
      const rt = (rts.json as any)?.values?.[0];
      if (!rt) return { ...rts, evidence: 'no request types to inspect' };
      const r = await get(ctx, `${ctx.client.siteUrl}/rest/servicedeskapi/servicedesk/${sd.id}/requesttype/${rt.id}/field`, JSM);
      return { ...r, evidence: r.outcome === 'available' ? `field layout readable (${(r.json as any)?.requestTypeFields?.length ?? 0} fields); write needs a separate check` : brief(r.json) };
    },
  },
  {
    id: 'request-type.create',
    mode: 'write',
    coverage: { elementType: 'request-type', operation: 'create' },
    async run(ctx, env) {
      const sd = await env.serviceDesk(ctx.sandboxKey!);
      if (!sd) return { outcome: 'skipped', evidence: `no service desk for sandbox ${ctx.sandboxKey}` };
      const types = await ctx.client.jira('GET', `/rest/api/3/issuetype/project?projectId=${sd.projectId}`);
      const wt = (types as any[]).find((t) => !t.subtask);
      if (!wt) return { outcome: 'skipped', evidence: 'sandbox has no work types' };
      const url = `${ctx.client.siteUrl}/rest/servicedeskapi/servicedesk/${sd.id}/requesttype`;
      const r = await ctx.client.raw('POST', url, { issueTypeId: wt.id, name: `zz-spike-${ctx.tag}`, description: 'API spike, safe to delete', helpText: '' }, JSM);
      const outcome = outcomeOf(r.status);
      if (outcome === 'available') {
        const id = String((r.json as any)?.id ?? '');
        env.cleanup('request type', id, `DELETE ${url}/${id}`, () => ctx.client.call('DELETE', `${url}/${id}`, undefined, JSM));
        return { outcome, http: r.status, endpoint: 'POST …/requesttype', evidence: `created request type ${id} (portal group and field layout not settable in the same call)`, suggests: { status: 'partial', confidence: 'high' } };
      }
      return { outcome, http: r.status, endpoint: 'POST …/requesttype', evidence: brief(r.json) };
    },
  },
  {
    id: 'workflow.approval.read',
    mode: 'read',
    coverage: { elementType: 'workflow', operation: 'configure', aspect: 'approval step' },
    async run(ctx) {
      // JSM approvals are stored as workflow status properties (approval.*). If the workflows API returns them,
      // they are likely writable through POST /rest/api/3/workflows/update (confirm with a write probe).
      const url = `${ctx.client.siteUrl}/rest/api/3/workflows/search?queryString=${encodeURIComponent('approval')}&maxResults=20&expand=values.transitions`;
      const r = await get(ctx, url);
      if (r.outcome !== 'available') return { ...r, evidence: brief(r.json) };
      const wfs: any[] = (r.json as any)?.values ?? [];
      const withApproval = wfs.flatMap((w) => (w.statuses ?? []).filter((s: any) => Object.keys(s.properties ?? {}).some((k) => k.startsWith('approval'))).map((s: any) => `${w.name} → ${s.statusReference ?? s.name}: ${Object.keys(s.properties).filter((k) => k.startsWith('approval')).join(', ')}`));
      return {
        ...r,
        evidence: withApproval.length ? `approval status properties visible: ${withApproval.slice(0, 3).join(' | ')}` : `${wfs.length} workflows matched; no approval.* status properties visible`,
        suggests: withApproval.length ? { status: 'partial', confidence: 'medium' } : undefined,
      };
    },
  },
  {
    id: 'form.templates.read',
    mode: 'read',
    coverage: { elementType: 'form', operation: 'create' },
    async run(ctx) {
      const cloud = await ctx.client.cloudId();
      const r = await get(ctx, `https://api.atlassian.com/jira/forms/cloud/${cloud}/project/${ctx.projectKey}/form`);
      return { ...r, evidence: r.outcome === 'available' ? `form templates listable (${Array.isArray(r.json) ? r.json.length : '?'}); create needs a write probe` : brief(r.json) };
    },
  },
  {
    id: 'form.templates.create',
    mode: 'write',
    coverage: { elementType: 'form', operation: 'create' },
    async run(ctx, env) {
      const cloud = await ctx.client.cloudId();
      const base = `https://api.atlassian.com/jira/forms/cloud/${cloud}/project/${ctx.sandboxKey}/form`;
      const body = { design: { settings: { templateId: 0, name: `zz-spike-${ctx.tag}`, submit: { lock: false, pdf: false }, language: 'en', templateFormUuid: '' }, layout: [{ version: 1, type: 'doc', content: [] }], conditions: {}, sections: {}, questions: {} } };
      const r = await ctx.client.raw('POST', base, body);
      const outcome = outcomeOf(r.status);
      if (outcome === 'available') {
        const id = String((r.json as any)?.id ?? '');
        env.cleanup('form template', id, `DELETE ${base}/${id}`, () => ctx.client.call('DELETE', `${base}/${id}`));
        return { outcome, http: r.status, endpoint: 'POST /jira/forms/…/project/{key}/form', evidence: `created form template ${id}`, suggests: { status: 'api', confidence: 'high' } };
      }
      return { outcome, http: r.status, endpoint: 'POST /jira/forms/…/project/{key}/form', evidence: brief(r.json) };
    },
  },
  {
    id: 'automation.rules.read',
    mode: 'read',
    coverage: { elementType: 'automation', operation: 'create' },
    async run(ctx) {
      const cloud = await ctx.client.cloudId();
      const url = `https://api.atlassian.com/automation/public/jira/${cloud}/rest/v1/rule/summary`;
      const r = await ctx.client.raw('POST', url, { limit: 5 });
      const outcome = outcomeOf(r.status);
      return { outcome, http: r.status, endpoint: 'POST /automation/public/jira/{cloudId}/rest/v1/rule/summary', evidence: outcome === 'available' ? `rule management API reachable (${(r.json as any)?.data?.length ?? '?'} rules returned); create needs a write probe` : brief(r.json) };
    },
  },
  {
    id: 'automation.rules.create',
    mode: 'write',
    coverage: { elementType: 'automation', operation: 'create' },
    async run(ctx, env) {
      const cloud = await ctx.client.cloudId();
      const sd = await env.serviceDesk(ctx.sandboxKey!);
      if (!sd) return { outcome: 'skipped', evidence: `no service desk for sandbox ${ctx.sandboxKey}` };
      const base = `https://api.atlassian.com/automation/public/jira/${cloud}/rest/v1/rule`;
      // Minimal DISABLED rule, scoped to the sandbox project: manual trigger, single log action.
      const rule = {
        name: `zz-spike-${ctx.tag}`, state: 'DISABLED', description: 'API spike, safe to delete',
        ruleScopeARIs: [`ari:cloud:jira:${cloud}:project/${sd.projectId}`],
        trigger: { component: 'TRIGGER', type: 'jira.manual.trigger.issue', schemaVersion: 1, value: { groups: [] } },
        components: [{ component: 'ACTION', type: 'jira.issue.log', schemaVersion: 1, value: 'spike' }],
      };
      const r = await ctx.client.raw('POST', base, { rule });
      const outcome = outcomeOf(r.status);
      if (outcome === 'available') {
        const uuid = String((r.json as any)?.ruleUuid ?? (r.json as any)?.uuid ?? '');
        env.cleanup('automation rule (disabled)', uuid, `DELETE ${base}/${uuid}`, () => ctx.client.call('DELETE', `${base}/${uuid}`));
        return { outcome, http: r.status, endpoint: 'POST /automation/public/jira/{cloudId}/rest/v1/rule', evidence: `created disabled rule ${uuid}`, suggests: { status: 'api', confidence: 'high' } };
      }
      return { outcome, http: r.status, endpoint: 'POST /automation/public/jira/{cloudId}/rest/v1/rule', evidence: brief(r.json) };
    },
  },
  {
    id: 'assets.reference-type.read',
    mode: 'read',
    coverage: { elementType: 'assets-reference-type', operation: 'create' },
    async run(ctx) {
      const list: any = await ctx.client.assets('GET', '/objectschema/list?maxResults=1');
      const schema = list?.values?.[0];
      if (!schema) return { outcome: 'skipped', evidence: 'no Assets schema to inspect' };
      const r = await get(ctx, await ctx.client.assetsUrl(`/config/referencetype?objectSchemaId=${schema.id}`));
      return { ...r, evidence: r.outcome === 'available' ? `reference types readable (${Array.isArray(r.json) ? r.json.map((x: any) => x.name).join(', ') : '?'})` : brief(r.json) };
    },
  },
  {
    id: 'assets.reference-type.create',
    mode: 'write',
    coverage: { elementType: 'assets-reference-type', operation: 'create' },
    async run(ctx, env) {
      // Use a throwaway schema so the reference schema is never touched.
      const key = `ZZ${ctx.tag.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(-6)}`;
      const s = await ctx.client.raw('POST', await ctx.client.assetsUrl('/objectschema/create'), { name: `zz-spike-${ctx.tag}`, objectSchemaKey: key, description: 'API spike, safe to delete' });
      if (outcomeOf(s.status) !== 'available') return { outcome: outcomeOf(s.status), http: s.status, endpoint: 'POST …/objectschema/create', evidence: `could not create throwaway schema: ${brief(s.json)}` };
      const sid = String((s.json as any)?.id);
      env.cleanup('assets schema', sid, `DELETE …/objectschema/${sid}`, async () => ctx.client.assets('DELETE', `/objectschema/${sid}`));
      const r = await ctx.client.raw('POST', await ctx.client.assetsUrl('/config/referencetype'), { name: 'Spike reference', color: '7F7F7F', objectSchemaId: sid });
      const outcome = outcomeOf(r.status);
      // Reference types live in the throwaway schema; deleting the schema removes them.
      return { outcome, http: r.status, endpoint: 'POST …/config/referencetype', evidence: outcome === 'available' ? `created reference type ${(r.json as any)?.id}` : brief(r.json), suggests: outcome === 'available' ? { status: 'api', confidence: 'high' } : outcome === 'not-found' || outcome === 'unsupported' ? { status: 'ui-only', confidence: 'medium' } : undefined };
    },
  },
  {
    id: 'queue.read',
    mode: 'read',
    coverage: { elementType: 'queue', operation: 'read' },
    async run(ctx, env) {
      const sd = await env.serviceDesk(ctx.projectKey);
      if (!sd) return { outcome: 'skipped', evidence: `no service desk for ${ctx.projectKey}` };
      const r = await get(ctx, `${ctx.client.siteUrl}/rest/servicedeskapi/servicedesk/${sd.id}/queue`, JSM);
      return { ...r, evidence: r.outcome === 'available' ? `${(r.json as any)?.values?.length ?? 0} queues readable (no public create endpoint known)` : brief(r.json) };
    },
  },
];

export const probeIds = () => PROBES.map((p) => `${p.id} (${p.mode})`);

export async function runSpike(ctx: SpikeContext, only?: string[]): Promise<SpikeReport> {
  if (ctx.write) {
    if (!ctx.sandboxKey) throw new Error('write probes need a sandbox project (--sandbox KEY)');
    if (ctx.sandboxKey.toUpperCase() === ctx.projectKey.toUpperCase()) throw new Error('the sandbox project must not be the reference project');
    if (ctx.client.readOnly) throw new Error('write probes need a client created with readOnly: false');
  }
  const desks = new Map<string, Promise<{ id: string; projectId: string } | undefined>>();
  const cleanups: { what: string; id: string; describe: string; fn: () => Promise<unknown> }[] = [];
  const env: ProbeEnv = {
    serviceDesk(key) {
      if (!desks.has(key)) {
        desks.set(key, ctx.client.paged<any>('/rest/servicedeskapi/servicedesk', { jsm: true }).then((all) => {
          const d = all.find((x) => String(x.projectKey).toUpperCase() === key.toUpperCase());
          return d ? { id: String(d.id), projectId: String(d.projectId) } : undefined;
        }));
      }
      return desks.get(key)!;
    },
    cleanup(what, id, describe, fn) { cleanups.push({ what, id, describe, fn }); },
  };

  const results: ProbeResult[] = [];
  for (const p of PROBES) {
    if (only?.length && !only.some((o) => p.id.startsWith(o))) continue;
    const base = { probe: p.id, mode: p.mode, coverage: p.coverage };
    if (p.mode === 'write' && !ctx.write) { results.push({ ...base, outcome: 'skipped', evidence: 'write probe; rerun with --write --sandbox KEY' }); continue; }
    try {
      results.push({ ...base, ...(await p.run(ctx, env)) });
    } catch (e) {
      results.push({ ...base, outcome: 'error', http: (e as { status?: number }).status, evidence: (e as Error).message.slice(0, 240) });
    }
  }

  const leftovers: Leftover[] = [];
  for (const c of cleanups.reverse()) {
    try { await c.fn(); } catch (e) { leftovers.push({ what: c.what, id: c.id, cleanup: c.describe, error: (e as Error).message.slice(0, 200) }); }
  }
  return { site: ctx.client.siteUrl, ranAt: new Date().toISOString(), write: ctx.write, results, leftovers };
}

export function renderSpike(r: SpikeReport): string {
  const icon: Record<ProbeOutcome, string> = { available: '✅', 'not-found': '❌', forbidden: '🔒', unsupported: '🚫', error: '⚠️', skipped: '⏸️' };
  const lines = [
    `# API spike: ${r.site}`, '', `Ran ${r.ranAt}. Write probes: ${r.write ? 'ON' : 'off'}.`, '',
    '| Probe | Mode | Coverage | Outcome | HTTP | Suggests | Evidence |', '|---|---|---|---|---|---|---|',
    ...r.results.map((x) => `| ${x.probe} | ${x.mode} | ${x.coverage.elementType} ${x.coverage.operation}${x.coverage.aspect ? ` (${x.coverage.aspect})` : ''} | ${icon[x.outcome]} ${x.outcome} | ${x.http ?? ''} | ${x.suggests ? `${x.suggests.status} (${x.suggests.confidence})` : ''} | ${x.evidence.replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
  ];
  if (r.leftovers.length) lines.push('', '## ⚠️ Leftovers to clean up manually', '', ...r.leftovers.map((l) => `- ${l.what} ${l.id}: ${l.cleanup} (${l.error})`));
  return lines.join('\n') + '\n';
}
