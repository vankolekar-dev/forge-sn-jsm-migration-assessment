import type { DesignElement } from '@snjsm/model';
import type { Handler, HandlerContext, Remote } from '../types';
import { cached, invalidate, isTemplateProvided, keyFrom, label, matchByName, nameEq, orMissing, step } from './util';

type E<T extends DesignElement['type']> = Extract<DesignElement, { type: T }>;

// ── Space (JSM project from a template) ───────────────────────────────────

async function serviceDeskId(ctx: HandlerContext, projectId: string): Promise<string | undefined> {
  const r = await ctx.api.jsm<{ values?: { id: string; projectId: string }[] }>('GET', '/rest/servicedeskapi/servicedesk?limit=100');
  return r.values?.find((s) => String(s.projectId) === String(projectId))?.id;
}

async function spaceRemote(ctx: HandlerContext, p: { id: string; key: string; name: string }): Promise<Remote> {
  const sd = await serviceDeskId(ctx, p.id);
  return { kind: 'project', id: String(p.id), key: p.key, name: p.name, ...(sd ? { extra: { serviceDeskId: String(sd) } } : {}) };
}

type Project = { id: string; key: string; name: string; projectTypeKey?: string };

/** Why a key cannot be used for a new space (in use, reserved by a trashed space, invalid), or undefined if free. */
async function keyProblem(ctx: HandlerContext, key: string): Promise<string | undefined> {
  return cached(ctx, `keycheck:${key}`, async () => {
    try {
      const r = await ctx.api.jira<{ errors?: Record<string, string>; errorMessages?: string[] }>('GET', `/rest/api/3/projectvalidate/key?key=${encodeURIComponent(key)}`);
      return Object.values(r?.errors ?? {})[0] ?? r?.errorMessages?.[0];
    } catch (e) {
      if ((e as { status?: number }).status !== 404) throw e;
      // Validation endpoint unavailable: fall back to "is there a space with this key".
      const p = await orMissing(ctx.api.jira<Project>('GET', `/rest/api/3/project/${key}`));
      return p ? `space "${p.name}" uses this key` : undefined;
    }
  });
}

/** Key candidates from a base key: ISD, ISD2 … ISD9 (kept within 10 characters). */
const keyCandidates = (base: string) => [base, ...Array.from({ length: 8 }, (_, i) => `${base.slice(0, 9)}${i + 2}`)];

/** The key a new space will be created with: the design's key if free, else the first free key derived from the name. */
async function resolveKey(ctx: HandlerContext<E<'space'>>): Promise<{ key?: string; note?: string; problem?: string }> {
  return cached(ctx, `spacekey:${ctx.el.id}`, async () => {
    const s = ctx.el.spec;
    if (s.key) {
      const why = await keyProblem(ctx, s.key);
      return why ? { problem: `space key ${s.key} cannot be used (${why}). Choose another key, or build into that space (mode "existing", key ${s.key}).` } : { key: s.key };
    }
    const base = keyFrom(s.name);
    for (const k of keyCandidates(base)) {
      const why = await keyProblem(ctx, k);
      if (!why) return { key: k, ...(k !== base ? { note: `key ${base} is taken: using ${k}` } : {}) };
    }
    return { problem: `no free key near ${base}: set the space key in the design` };
  });
}

const createBody = (ctx: HandlerContext<E<'space'>>, key: string, lead: string) => {
  const s = ctx.el.spec;
  return { key, name: s.name, projectTypeKey: s.productType, projectTemplateKey: s.templateKey, description: s.description, leadAccountId: lead, assigneeType: 'UNASSIGNED' };
};

/**
 * Space: either created from the template (mode "new") or an existing space the design is built into (mode
 * "existing", by key). A new space never silently adopts a same-named space that this build did not create: the
 * dry-run blocks it so a person chooses (build into it, or rename).
 */
export const space: Handler<E<'space'>> = {
  type: 'space',
  canCreate: (el) => el.spec.mode !== 'existing',
  async discover(ctx) {
    const s = ctx.el.spec;
    if (s.mode === 'existing') {
      const p = await orMissing(ctx.api.jira<Project>('GET', `/rest/api/3/project/${s.key}`));
      return p ? spaceRemote(ctx, p) : undefined;
    }
    const r = await ctx.api.jira<{ values?: Project[] }>('GET', `/rest/api/3/project/search?query=${encodeURIComponent(s.name)}&maxResults=50`);
    const hit = (r.values ?? []).find((p) => nameEq(p.name, s.name));
    return hit ? spaceRemote(ctx, hit) : undefined;
  },
  async check(ctx, found) {
    const s = ctx.el.spec;
    if (s.mode === 'existing') {
      if (!found) return { problem: `existing space ${s.key} was not found on the site (or this account cannot see it)` };
      const p = await orMissing(ctx.api.jira<Project>('GET', `/rest/api/3/project/${found.id}`));
      if (p?.projectTypeKey && p.projectTypeKey !== s.productType) return { problem: `space ${s.key} is a ${p.projectTypeKey} space, the design needs ${s.productType}` };
      return { resolved: { key: found.key ?? s.key! }, note: `building into existing space ${found.key} "${found.name ?? ''}"` };
    }
    if (found) return { problem: `a space named "${found.name ?? s.name}" already exists (${found.key}). Build into it (mode "existing", key ${found.key}) or choose another name.` };
    const k = await resolveKey(ctx);
    return k.problem ? { problem: k.problem } : { resolved: { key: k.key! }, ...(k.note ? { note: k.note } : {}) };
  },
  desired: (ctx) => (ctx.el.spec.mode === 'existing' ? { projectTypeKey: ctx.el.spec.productType } : { name: ctx.el.spec.name, projectTypeKey: ctx.el.spec.productType }),
  async observe(ctx, remote) {
    const p = await orMissing(ctx.api.jira<{ name: string; projectTypeKey: string }>('GET', `/rest/api/3/project/${remote.id}`));
    if (!p) return undefined;
    return ctx.el.spec.mode === 'existing' ? { projectTypeKey: p.projectTypeKey } : { name: p.name, projectTypeKey: p.projectTypeKey };
  },
  preview(ctx) {
    if (ctx.el.spec.mode === 'existing') return [];
    const resolved = ctx.cache.get(`spacekey:${ctx.el.id}`) as { key?: string } | undefined;
    const key = resolved?.key ?? ctx.el.spec.key ?? keyFrom(ctx.el.spec.name);
    return [{ method: 'POST', path: '/rest/api/3/project', body: createBody(ctx, key, ctx.options.leadAccountId ?? '<caller>') }];
  },
  async create(ctx) {
    if (ctx.el.spec.mode === 'existing') throw new Error(`existing space ${ctx.el.spec.key} not found: nothing is created for an existing space`);
    const k = await resolveKey(ctx);
    if (k.problem) throw new Error(k.problem);
    const lead = ctx.options.leadAccountId ?? (await ctx.api.jira<{ accountId: string }>('GET', '/rest/api/3/myself')).accountId;
    const p = await ctx.api.jira<{ id: number | string; key: string }>('POST', '/rest/api/3/project', createBody(ctx, k.key!, lead));
    return spaceRemote(ctx, { id: String(p.id), key: p.key, name: ctx.el.spec.name });
  },
  manual: (ctx) => ctx.el.spec.mode === 'existing'
    ? step(ctx, {
      title: `Give access to space ${ctx.el.spec.key}`, why: 'The existing space was not found with this account',
      where: `Projects → ${ctx.el.spec.key} → Space settings → Access`,
      instructions: [`Check the key ${ctx.el.spec.key} and that the build account can administer the space.`, 'Record the project id afterwards.'],
      values: { key: ctx.el.spec.key }, checks: ['The space opens for the build account with admin rights.'], record: 'remote-id',
    })
    : step(ctx, {
      title: `Create space "${ctx.el.spec.name}"`, why: 'Space creation failed or needs a person',
      where: 'Projects → Create project → Jira Service Management → IT service management',
      instructions: ['Create the space from the IT service management template with the values below.', 'Record the project id afterwards.'],
      values: { ...ctx.el.spec, key: (ctx.cache.get(`spacekey:${ctx.el.id}`) as { key?: string } | undefined)?.key ?? ctx.el.spec.key ?? keyFrom(ctx.el.spec.name) },
      checks: ['The space opens and shows the ITSM request types and queues.'], record: 'remote-id',
    }),
};

// ── Work type ─────────────────────────────────────────────────────────────

async function projectWorkTypes(ctx: HandlerContext, projectId: string) {
  return cached(ctx, `issuetypes:${projectId}`, () => ctx.api.jira<{ id: string; name: string; description?: string; hierarchyLevel?: number }[]>('GET', `/rest/api/3/issuetype/project?projectId=${projectId}`));
}

const spaceOfDesign = (ctx: HandlerContext) => ctx.bp.design.find((d) => d.type === 'space');

export const workType: Handler<E<'work-type'>> = {
  type: 'work-type',
  canCreate: () => true,
  manualAspects: (el) => (isTemplateProvided(el) ? [] : ['add to the space work type scheme and set its workflow']),
  async discover(ctx) {
    const sp = spaceOfDesign(ctx);
    const project = sp ? ctx.remoteOf(sp.id) : undefined;
    const list = project ? await projectWorkTypes(ctx, project.id) : await cached(ctx, 'issuetypes:all', () => ctx.api.jira<{ id: string; name: string }[]>('GET', '/rest/api/3/issuetype'));
    const hit = matchByName(ctx.el, list);
    return hit && { kind: 'issuetype', id: String(hit.id), name: hit.name };
  },
  desired: (ctx) => ({ name: ctx.el.spec.name }),
  async observe(ctx, remote) {
    const t = await orMissing(ctx.api.jira<{ name: string }>('GET', `/rest/api/3/issuetype/${remote.id}`));
    // "[System] Service request" on the site is the design's "Service request": not a difference.
    return t && { name: nameEq(t.name, ctx.el.spec.name) ? ctx.el.spec.name : t.name };
  },
  preview: (ctx) => [{ method: 'POST', path: '/rest/api/3/issuetype', body: { name: ctx.el.spec.name, description: ctx.el.spec.description, hierarchyLevel: ctx.el.spec.hierarchyLevel } }],
  async create(ctx) {
    const t = await ctx.api.jira<{ id: string; name: string }>('POST', '/rest/api/3/issuetype', { name: ctx.el.spec.name, description: ctx.el.spec.description, hierarchyLevel: ctx.el.spec.hierarchyLevel });
    invalidate(ctx, 'issuetypes:');
    return { kind: 'issuetype', id: String(t.id), name: t.name };
  },
  manual: (ctx, aspects) => step(ctx, {
    title: `Work type "${ctx.el.spec.name}"${aspects.length ? `: ${aspects.join(', ')}` : ''}`, why: aspects.length ? 'No stable public API for these aspects' : 'Not found on the site',
    where: 'Space settings → Work types',
    instructions: [`Make sure the space has the work type "${ctx.el.spec.name}".`, ...(ctx.el.spec.workflowId ? [`Associate it with the workflow "${label(ctx, ctx.el.spec.workflowId)}".`] : [])],
    values: { name: ctx.el.spec.name, description: ctx.el.spec.description, workflow: ctx.el.spec.workflowId ? label(ctx, ctx.el.spec.workflowId) : undefined },
    checks: ['Create a test request of this type and check it starts in the expected status.'], record: aspects.length ? 'confirm' : 'remote-id',
  }),
};

// ── Workflow (adopted from the template; approvals are a guided step) ─────

export const workflow: Handler<E<'workflow'>> = {
  type: 'workflow',
  canCreate: () => false,
  manualAspects: (el) => (el.spec.approvals.length ? ['approval steps'] : []),
  async discover(ctx) {
    for (const n of [ctx.el.spec.name, ctx.el.name]) {
      const r = await ctx.api.jira<{ values?: { id: string | { entityId?: string; name?: string }; name?: string }[] }>('GET', `/rest/api/3/workflows/search?queryString=${encodeURIComponent(n)}&maxResults=50`);
      const hit = (r.values ?? []).find((w) => nameEq(w.name ?? (typeof w.id === 'object' ? w.id.name : undefined), n));
      if (hit) return { kind: 'workflow', id: typeof hit.id === 'object' ? String(hit.id.entityId ?? hit.id.name) : String(hit.id), name: n };
    }
    // Template workflows are often renamed per space ("<KEY>: Service request fulfilment workflow ...").
    const sp = spaceOfDesign(ctx);
    const key = sp ? ctx.remoteOf(sp.id)?.key : undefined;
    if (key) {
      const r = await ctx.api.jira<{ values?: { id: string | { entityId?: string }; name?: string }[] }>('GET', `/rest/api/3/workflows/search?queryString=${encodeURIComponent(key)}&maxResults=50`);
      const hit = (r.values ?? []).find((w) => (w.name ?? '').toLowerCase().includes(ctx.el.spec.name.toLowerCase().replace(/ workflow$/, '')));
      if (hit) return { kind: 'workflow', id: typeof hit.id === 'object' ? String(hit.id.entityId) : String(hit.id), name: hit.name };
    }
    return undefined;
  },
  manual: (ctx, aspects) => {
    const s = ctx.el.spec;
    const statusName = (id: string) => s.statuses.find((x) => x.id === id)?.name ?? id;
    const tr = (id: string) => s.transitions.find((t) => t.id === id)?.name ?? id;
    return step(ctx, {
      title: aspects.length ? `Workflow "${s.name}": ${aspects.join(', ')}` : `Workflow "${s.name}"`,
      why: aspects.length ? 'Approval configuration has no verified public API' : 'Workflow not found (it should come with the ITSM template)',
      where: 'Space settings → Workflows → edit workflow → select status → Approval',
      instructions: aspects.length
        ? s.approvals.map((a) => `At status "${statusName(a.atStatusId)}": add an approval. Approvers: ${a.approvers.kind === 'field' ? `field "${label(ctx, a.approvers.fieldId)}"` : a.approvers.kind === 'group' ? `group "${label(ctx, a.approvers.groupId)}"` : a.approvers.kind}. Decision: ${a.decision === 'all' ? 'all approvers' : 'one approver'}. Approve → "${tr(a.approveTransitionId)}", decline → "${tr(a.declineTransitionId)}".`)
        : ['Create or import the workflow with the statuses and transitions below.'],
      values: { statuses: s.statuses.map((x) => `${x.name} (${x.category})`), transitions: s.transitions.map((t) => `${t.name}: ${t.from.length ? t.from.map(statusName).join('/') : 'any'} → ${statusName(t.to)}`), approvals: s.approvals.length },
      checks: ['Raise a test request: it waits in the approval status and moves on approve / decline as described.'],
      record: aspects.length ? 'confirm' : 'remote-id',
    });
  },
};

// ── Field ─────────────────────────────────────────────────────────────────

const CF = 'com.atlassian.jira.plugin.system.customfieldtypes:';
const FIELD_TYPES: Record<string, { type: string; searcherKey: string }> = {
  text: { type: `${CF}textfield`, searcherKey: `${CF}textsearcher` },
  paragraph: { type: `${CF}textarea`, searcherKey: `${CF}textsearcher` },
  number: { type: `${CF}float`, searcherKey: `${CF}exactnumber` },
  date: { type: `${CF}datepicker`, searcherKey: `${CF}daterange` },
  datetime: { type: `${CF}datetime`, searcherKey: `${CF}datetimerange` },
  select: { type: `${CF}select`, searcherKey: `${CF}multiselectsearcher` },
  multiselect: { type: `${CF}multiselect`, searcherKey: `${CF}multiselectsearcher` },
  radio: { type: `${CF}radiobuttons`, searcherKey: `${CF}multiselectsearcher` },
  checkbox: { type: `${CF}multicheckboxes`, searcherKey: `${CF}multiselectsearcher` },
  'cascading-select': { type: `${CF}cascadingselect`, searcherKey: `${CF}cascadingselectsearcher` },
  user: { type: `${CF}userpicker`, searcherKey: `${CF}userpickergroupsearcher` },
  multiuser: { type: `${CF}multiuserpicker`, searcherKey: `${CF}userpickergroupsearcher` },
  group: { type: `${CF}grouppicker`, searcherKey: `${CF}grouppickersearcher` },
  url: { type: `${CF}url`, searcherKey: `${CF}exacttextsearcher` },
  labels: { type: `${CF}labels`, searcherKey: `${CF}labelsearcher` },
  'assets-object': { type: 'com.atlassian.jira.plugins.cmdb:cmdb-object-cftype', searcherKey: 'com.atlassian.jira.plugins.cmdb:cmdb-object-searcher' },
};
const HAS_OPTIONS = new Set(['select', 'multiselect', 'radio', 'checkbox']);

type JiraField = { id: string; name: string; custom: boolean; schema?: { custom?: string } };
const allFields = (ctx: HandlerContext) => cached(ctx, 'fields', () => ctx.api.jira<JiraField[]>('GET', '/rest/api/3/field'));

async function fieldContext(ctx: HandlerContext, fieldId: string): Promise<string | undefined> {
  const r = await ctx.api.jira<{ values?: { id: string; isGlobalContext?: boolean }[] }>('GET', `/rest/api/3/field/${fieldId}/context`);
  return (r.values?.find((c) => c.isGlobalContext) ?? r.values?.[0])?.id;
}

/** Built-in or platform-managed fields are adopted, never created. */
const isProvided = (el: E<'field'>) => Boolean(el.spec.systemFieldId) || el.spec.fieldType === 'team' || (el.origin === 'reference' && !el.spec.options?.length && el.spec.fieldType !== 'assets-object');

export const field: Handler<E<'field'>> = {
  type: 'field',
  canCreate: (el) => !isProvided(el) && Boolean(FIELD_TYPES[el.spec.fieldType]),
  manualAspects: (el) => (el.spec.fieldType === 'assets-object' ? ['Assets object field configuration (object schema, AQL scope, display)'] : []),
  async discover(ctx) {
    const s = ctx.el.spec;
    const fields = await allFields(ctx);
    if (s.systemFieldId) {
      // Some "system" fields (Approvers, Team) are custom fields with site-specific ids: fall back to the name.
      const f = fields.find((x) => x.id === s.systemFieldId) ?? fields.find((x) => nameEq(x.name, s.name));
      return f && { kind: 'field', id: f.id, name: f.name };
    }
    const want = FIELD_TYPES[s.fieldType]?.type;
    const same = fields.filter((f) => nameEq(f.name, s.name));
    const f = same.find((x) => !want || x.schema?.custom === want) ?? (isProvided(ctx.el) ? same[0] : undefined);
    return f && { kind: 'field', id: f.id, name: f.name };
  },
  desired: (ctx) => ({ name: ctx.el.spec.name, ...(HAS_OPTIONS.has(ctx.el.spec.fieldType) && ctx.el.spec.options ? { options: ctx.el.spec.options } : {}) }),
  async observe(ctx, remote) {
    const f = (await allFields(ctx)).find((x) => x.id === remote.id);
    if (!f) return undefined;
    const out: Record<string, unknown> = { name: f.name };
    if (HAS_OPTIONS.has(ctx.el.spec.fieldType) && ctx.el.spec.options) {
      const c = remote.extra?.['contextId'] ?? (await fieldContext(ctx, f.id));
      const o = c ? await ctx.api.jira<{ values?: { value: string; disabled?: boolean }[] }>('GET', `/rest/api/3/field/${f.id}/context/${c}/option`) : { values: [] };
      out['options'] = (o.values ?? []).filter((x) => !x.disabled).map((x) => x.value);
    }
    return out;
  },
  preview(ctx) {
    const s = ctx.el.spec;
    const t = FIELD_TYPES[s.fieldType];
    const reqs = [{ method: 'POST', path: '/rest/api/3/field', body: { name: s.name, description: s.description, ...t } }];
    if (HAS_OPTIONS.has(s.fieldType) && s.options?.length) reqs.push({ method: 'POST', path: '/rest/api/3/field/<new-field>/context/<default-context>/option', body: { options: s.options.map((value) => ({ value })) } as never });
    return reqs;
  },
  async create(ctx) {
    const s = ctx.el.spec;
    const f = await ctx.api.jira<{ id: string; name: string }>('POST', '/rest/api/3/field', { name: s.name, description: s.description, ...FIELD_TYPES[s.fieldType] });
    ctx.cache.delete('fields');
    const remote: Remote = { kind: 'field', id: f.id, name: f.name };
    if (HAS_OPTIONS.has(s.fieldType) && s.options?.length) {
      const c = await fieldContext(ctx, f.id);
      if (!c) throw new Error(`field ${f.id} has no context to add options to`);
      await ctx.api.jira('POST', `/rest/api/3/field/${f.id}/context/${c}/option`, { options: s.options.map((value) => ({ value })) });
      remote.extra = { contextId: c };
    }
    return remote;
  },
  async update(ctx, remote, changes) {
    const opt = changes.find((c) => c.path === 'options');
    if (!opt) return;
    const have = new Set((opt.have as string[] | undefined) ?? []);
    const add = (opt.want as string[]).filter((o) => !have.has(o));
    if (!add.length) return;
    const c = remote.extra?.['contextId'] ?? (await fieldContext(ctx, remote.id));
    await ctx.api.jira('POST', `/rest/api/3/field/${remote.id}/context/${c}/option`, { options: add.map((value) => ({ value })) });
  },
  manual: (ctx, aspects) => {
    const s = ctx.el.spec;
    return step(ctx, {
      title: aspects.length ? `Field "${s.name}": ${aspects.join(', ')}` : `Field "${s.name}"`,
      why: aspects.length ? 'Assets field configuration has no public API' : isProvided(ctx.el) ? 'Built-in field not found on the site' : 'No API create for this field type',
      where: aspects.length ? 'Settings → Work items → Fields → find the field → Contexts and default value → Assets object field configuration' : 'Settings → Work items → Fields → Create field',
      instructions: aspects.length && s.assets
        ? [`Object schema: the schema of "${label(ctx, s.assets.objectTypeId)}".`, `Filter scope (AQL): objectType = "${label(ctx, s.assets.objectTypeId).replace(/ \(.*\)$/, '')}"${s.assets.aqlFilter ? ` AND ${s.assets.aqlFilter}` : ''}.`, `Multiple objects: ${s.assets.multiple ? 'yes' : 'no'}.`]
        : [`Create a ${s.fieldType} field named "${s.name}".`, ...(s.options?.length ? [`Options: ${s.options.join(', ')}.`] : [])],
      values: { name: s.name, type: s.fieldType, description: s.description, options: s.options, assets: s.assets && labelAssets(ctx, s.assets) },
      checks: ['The field shows on a test request with the expected choices.'],
      record: aspects.length ? 'confirm' : 'remote-id',
    });
  },
};

const labelAssets = (ctx: HandlerContext, a: NonNullable<E<'field'>['spec']['assets']>) => ({ objectType: label(ctx, a.objectTypeId), aqlFilter: a.aqlFilter, multiple: a.multiple });

// ── Team (Atlassian team: guided; group: API) ─────────────────────────────

export const team: Handler<E<'team'>> = {
  type: 'team',
  canCreate: (el) => el.spec.kind === 'group',
  async discover(ctx) {
    if (ctx.el.spec.kind !== 'group') return undefined;
    const r = await ctx.api.jira<{ values?: { groupId: string; name: string }[] }>('GET', `/rest/api/3/group/bulk?groupName=${encodeURIComponent(ctx.el.spec.name)}`);
    const g = (r.values ?? []).find((x) => nameEq(x.name, ctx.el.spec.name));
    return g && { kind: 'group', id: g.groupId, name: g.name };
  },
  preview: (ctx) => [{ method: 'POST', path: '/rest/api/3/group', body: { name: ctx.el.spec.name } }],
  async create(ctx) {
    const g = await ctx.api.jira<{ groupId: string; name: string }>('POST', '/rest/api/3/group', { name: ctx.el.spec.name });
    return { kind: 'group', id: g.groupId, name: g.name };
  },
  manual: (ctx) => step(ctx, {
    title: `Team "${ctx.el.spec.name}"`, why: 'Atlassian Teams are org-scoped; the engine does not create them yet',
    where: 'Teams (home.atlassian.com → Teams) → Create team',
    instructions: [`Create (or reuse) the team "${ctx.el.spec.name}" and add its members.`, 'Record the team id (from the team URL).'],
    values: { name: ctx.el.spec.name, purpose: ctx.el.spec.purpose },
    checks: ['The team can be picked in the Team field of a request.'], record: 'remote-id',
  }),
};
