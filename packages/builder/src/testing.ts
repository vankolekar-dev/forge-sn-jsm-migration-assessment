import { referenceArtifacts } from '@snjsm/reference';
import type { SiteApi } from './types';

/**
 * In-memory Atlassian site for tests and offline demos. It implements only the endpoints the handlers use, seeds
 * a space created from a template with the template's reference artifacts, and records every write.
 * It is a model of the API contract we believe in (unverified); the real contract is proven by the write probes.
 */
type Obj = Record<string, any>;
const notFound = (what: string) => Object.assign(new Error(`404 ${what} not found`), { status: 404 });
const bad = (what: string) => Object.assign(new Error(`400 ${what}`), { status: 400 });
const forbidden = (what: string) => Object.assign(new Error(`403 ${what}`), { status: 403 });
const NO_ROUTE = Symbol('no-route');

export class FakeSite {
  readonly writes: { method: string; path: string; body?: unknown; as?: string }[] = [];
  private seq = 10000;
  projects: Obj[] = [];
  serviceDesks: Obj[] = [];
  issueTypes: Obj[] = [{ id: '1', name: 'Task' }];
  projectIssueTypes = new Map<string, string[]>();
  workflows: Obj[] = [];
  /** Ids of fields created through the API in this fake (used by opts.staleFieldList). */
  readonly createdFields = new Set<string>();
  fields: Obj[] = [
    { id: 'summary', name: 'Summary', custom: false },
    { id: 'description', name: 'Description', custom: false },
    { id: 'customfield_10001', name: 'Team', custom: true, schema: { custom: 'com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team' } },
    { id: 'customfield_10003', name: 'Approvers', custom: true, schema: { custom: 'com.atlassian.servicedesk.approvals-plugin:sd-approvals' } },
  ];
  contexts = new Map<string, { id: string; isGlobalContext: boolean; options: Obj[] }[]>();
  groups: Obj[] = [];
  requestTypes: Obj[] = [];
  rtGroups: Obj[] = [];
  queues: Obj[] = [];
  automations: Obj[] = [];
  schemas: Obj[] = [];
  statusTypes: Obj[] = [];
  referenceTypes: Obj[] = [];
  objectTypes: Obj[] = [];
  attributes: Obj[] = [];
  icons = [{ id: '1', name: 'Laptop' }, { id: '2', name: 'Box' }];

  /**
   * @param opts.systemPrefix name template work types "[System] <name>", as seen on a live site (2026-10-15)
   * @param opts.staleFieldList GET /rest/api/3/field omits fields created through the API, as seen on a live site
   *   (2026-10-16); /rest/api/3/field/search is current
   */
  constructor(readonly siteUrl = 'https://fake-sandbox.atlassian.net', readonly opts: { systemPrefix?: boolean; staleFieldList?: boolean } = {}) {}
  private id = () => String(++this.seq);

  /**
   * One-shot faults: the next matching request fails with 503 (an uncertain write for POST), either after the
   * site applied it (applied: true, like a lost response) or before.
   */
  faults: { method: string; path: RegExp; applied: boolean }[] = [];

  // ---- Runtime: requests, workflow, approvals, SLAs and Assets objects (used by the acceptance runner) ----
  issues: Obj[] = [];
  objects: Obj[] = [];
  /** Runtime workflow: from = status names ([] = any status). */
  transitions: { name: string; from: string[]; to: string }[] = [];
  initialStatus = 'Waiting for support';
  doneStatuses = new Set(['Resolved', 'Closed', 'Canceled']);
  /** What an approval decision does to the request (the workflow's approve/decline transitions). */
  approvalOutcomes: Record<'approve' | 'decline', { status: string; resolution?: string }> = {
    approve: { status: 'Waiting for support' },
    decline: { status: 'Resolved', resolution: 'Declined' },
  };
  /** SLAs: the cycle runs while the request is in one of `runningIn` (empty = from creation until done). */
  slas: { name: string; goalMillis: number; runningIn?: string[] }[] = [];
  /** Emulated automation: called after a request is created, transitioned or an approval is decided. */
  automation?: (event: 'created' | 'transitioned' | 'approval', issue: Obj, site: FakeSite) => void;

  /** Add a pending approval for a request (what an approval step does on entering its status). */
  requestApproval(issue: Obj, approverIds: string[]) {
    issue.approvals.push({ id: this.id(), name: 'Approval', finalDecision: 'pending', approvers: approverIds.map((a) => ({ approver: { accountId: a }, approverDecision: 'pending' })) });
  }
  setStatus(issue: Obj, status: string, resolution?: string | null) {
    issue.fields.status = { name: status };
    issue.fields.resolution = this.doneStatuses.has(status) ? { name: resolution ?? 'Done' } : null;
  }

  /** A client view. Read-only views reject writes, like AtlassianClient. `as` = the persona's account id. */
  client(readOnly: boolean, as = 'fake-user'): SiteApi {
    const go = (api: 'jira' | 'jsm' | 'assets' | 'call') => async (method: string, path: string, body?: unknown) => {
      const m = method.toUpperCase();
      const isQueryPost = m === 'POST' && /\/rule\/summary$/.test(path);
      if (readOnly && m !== 'GET' && !isQueryPost) throw new Error(`read-only client refused ${m} ${path}`);
      if (m !== 'GET' && !isQueryPost) this.writes.push({ method: m, path, body, ...(as !== 'fake-user' ? { as } : {}) });
      const f = this.faults.findIndex((x) => x.method === m && x.path.test(path));
      if (f >= 0) {
        const [fault] = this.faults.splice(f, 1);
        if (fault!.applied) await this.route(api, m, path, body as Obj, as);
        throw Object.assign(new Error(`${m} ${path} → 503 (injected; ${fault!.applied ? 'applied' : 'not applied'})`), { status: 503, uncertain: m === 'POST' });
      }
      return this.route(api, m, path, body as Obj, as);
    };
    return { siteUrl: this.siteUrl, readOnly, jira: go('jira'), jsm: go('jsm'), assets: go('assets'), call: go('call'), cloudId: async () => 'fake-cloud' } as SiteApi;
  }

  private runtime(api: string, m: string, path: string, body: Obj, as: string): unknown {
    const at = (re: RegExp) => path.match(re);
    let r: RegExpMatchArray | null;
    const issue = (key: string) => this.issues.find((i) => i.key === key || i.id === key) ?? (() => { throw notFound(`issue ${key}`); })();
    if (api === 'jira') {
      if (path === '/rest/api/3/myself') return { accountId: as };
      if ((r = at(/^\/rest\/api\/3\/issue\/([\w-]+)\/transitions$/))) {
        const i = issue(r[1]!);
        const avail = this.transitions.map((t, n) => ({ ...t, id: String(n + 1) })).filter((t) => !t.from.length || t.from.includes(i.fields.status.name));
        if (m === 'GET') return { transitions: avail.map((t) => ({ id: t.id, name: t.name, to: { name: t.to } })) };
        const t = avail.find((x) => x.id === String(body.transition?.id));
        if (!t) throw bad(`transition ${body.transition?.id} is not available from ${i.fields.status.name}`);
        this.setStatus(i, t.to, body.fields?.resolution?.name);
        this.automation?.('transitioned', i, this);
        return undefined;
      }
      if ((r = at(/^\/rest\/api\/3\/issue\/([\w-]+)$/))) {
        const i = issue(r[1]!);
        if (m === 'GET') return { id: i.id, key: i.key, fields: i.fields };
        if (m === 'DELETE') { this.issues = this.issues.filter((x) => x !== i); return undefined; }
        if (m === 'PUT') {
          Object.assign(i.fields, body.fields ?? {});
          for (const op of body.update?.labels ?? []) if (op.add) i.fields.labels = [...new Set([...(i.fields.labels ?? []), op.add])];
          return undefined;
        }
      }
    }
    if (api === 'jsm') {
      if (path === '/rest/servicedeskapi/assets/workspace') return { values: [{ workspaceId: 'fake-workspace' }] };
      if (path === '/rest/servicedeskapi/request' && m === 'POST') {
        const sd = this.serviceDesks.find((d) => d.id === String(body.serviceDeskId)) ?? (() => { throw bad(`service desk ${body.serviceDeskId}`); })();
        const t = this.requestTypes.find((x) => x.id === String(body.requestTypeId) && x.sd === sd.id) ?? (() => { throw bad(`request type ${body.requestTypeId}`); })();
        const values = body.requestFieldValues ?? {};
        if (!values.summary) throw bad('summary is required');
        const id = this.id();
        const n = this.issues.filter((i) => i.projectKey === sd.projectKey).length + 1;
        const i: Obj = { id, key: `${sd.projectKey}-${n}`, projectKey: sd.projectKey, requestTypeId: t.id, approvals: [], comments: [], fields: { labels: [], ...values, reporter: { accountId: body.raiseOnBehalfOf ?? as } } };
        this.setStatus(i, this.initialStatus);
        this.issues.push(i);
        this.automation?.('created', i, this);
        return { issueId: id, issueKey: i.key, currentStatus: { status: i.fields.status.name } };
      }
      if ((r = at(/^\/rest\/servicedeskapi\/request\/([\w-]+)\/approval$/))) return { values: issue(r[1]!).approvals };
      if ((r = at(/^\/rest\/servicedeskapi\/request\/([\w-]+)\/approval\/(\w+)$/)) && m === 'POST') {
        const i = issue(r[1]!);
        const a = i.approvals.find((x: Obj) => x.id === r![2]) ?? (() => { throw notFound('approval'); })();
        const mine = a.approvers.find((x: Obj) => x.approver.accountId === as);
        if (!mine) throw forbidden(`${as} is not an approver`);
        if (a.finalDecision !== 'pending') throw bad('approval already decided');
        const decision = body.decision === 'approve' ? 'approve' : body.decision === 'decline' ? 'decline' : (() => { throw bad(`decision ${body.decision}`); })();
        mine.approverDecision = a.finalDecision = decision === 'approve' ? 'approved' : 'declined';
        const o = this.approvalOutcomes[decision];
        this.setStatus(i, o.status, o.resolution);
        this.automation?.('approval', i, this);
        return a;
      }
      if ((r = at(/^\/rest\/servicedeskapi\/request\/([\w-]+)\/comment$/)) && m === 'POST') {
        const c = { id: this.id(), body: body.body, public: body.public !== false, author: { accountId: as } };
        issue(r[1]!).comments.push(c);
        return c;
      }
      if ((r = at(/^\/rest\/servicedeskapi\/request\/([\w-]+)\/sla$/))) {
        const i = issue(r[1]!);
        const status = i.fields.status.name as string;
        return { values: this.slas.map((s) => {
          const running = s.runningIn?.length ? s.runningIn.includes(status) : !this.doneStatuses.has(status);
          return { name: s.name, ...(running ? { ongoingCycle: { breached: false, paused: false, goalDuration: { millis: s.goalMillis } } } : {}), completedCycles: [] };
        }) };
      }
    }
    if (api === 'assets') {
      if (path === '/object/create' && m === 'POST') {
        const t = this.objectTypes.find((x) => x.id === String(body.objectTypeId)) ?? (() => { throw bad(`object type ${body.objectTypeId}`); })();
        const attrs: Obj[] = body.attributes ?? [];
        for (const a of attrs) if (!this.attributes.some((x) => x.id === String(a.objectTypeAttributeId) && x.objectTypeId === t.id)) throw bad(`attribute ${a.objectTypeAttributeId} is not on object type ${t.id}`);
        const nameAttr = this.attributes.find((x) => x.objectTypeId === t.id && x.name === 'Name');
        const label = attrs.find((a) => nameAttr && String(a.objectTypeAttributeId) === nameAttr.id)?.objectAttributeValues?.[0]?.value;
        if (!label) throw bad('Name is required');
        const schema = this.schemas.find((x) => x.id === t.objectSchemaId);
        const id = this.id();
        const o = { id, objectKey: `${schema?.objectSchemaKey ?? 'OBJ'}-${id}`, label, objectType: { id: t.id }, attributes: attrs };
        this.objects.push(o);
        return o;
      }
      if ((r = at(/^\/object\/(\w+)$/))) {
        const o = this.objects.find((x) => x.id === r![1]) ?? (() => { throw notFound(`object ${r![1]}`); })();
        if (m === 'GET') return o;
        if (m === 'DELETE') { this.objects = this.objects.filter((x) => x !== o); return undefined; }
      }
    }
    return NO_ROUTE;
  }

  /** Seed what creating a space from a template provides (from the reference library). */
  private seedTemplate(project: Obj, templateKey: string) {
    const template = referenceArtifacts().find((a) => a.kind === 'project-template' && (a.attributes as Obj | undefined)?.['templateKey'] === templateKey) ?? referenceArtifacts().find((a) => a.kind === 'project-template');
    const parts = referenceArtifacts().filter((a) => a.partOf === template?.id);
    const sd = { id: this.id(), projectId: project.id, projectKey: project.key };
    this.serviceDesks.push(sd);
    const types: string[] = [];
    for (const a of parts) {
      if (a.kind === 'work-type') { const t = { id: this.id(), name: this.opts.systemPrefix ? `[System] ${a.name}` : a.name }; this.issueTypes.push(t); types.push(t.id); }
      if (a.kind === 'workflow') this.workflows.push({ id: { entityId: this.id() }, name: a.name });
      if (a.kind === 'portal-group') this.rtGroups.push({ id: this.id(), name: a.name, sd: sd.id });
      if (a.kind === 'queue') this.queues.push({ id: this.id(), name: a.name, jql: String((a.attributes as Obj | undefined)?.['jql'] ?? 'resolution = EMPTY'), sd: sd.id });
    }
    for (const a of parts.filter((x) => x.kind === 'request-type')) this.requestTypes.push({ id: this.id(), name: a.name, description: '', issueTypeId: types[0], sd: sd.id });
    this.projectIssueTypes.set(project.id, types);
  }

  /**
   * Simulate the guided step "create an Assets schema from a template" (the UI does this; there is no public API).
   * Seeds the template's verified object types (with parents) and their own attributes from the reference library,
   * plus the system attributes every object type has. Inherited attributes are not repeated on children.
   * Returns the new schema, whose id a person records when confirming the guided step.
   */
  createSchemaFromTemplate(templateId: string, name: string, key: string): Obj {
    const template = referenceArtifacts().find((a) => a.id === templateId && a.kind === 'assets-schema-template');
    if (!template) throw new Error(`unknown Assets schema template ${templateId}`);
    const s = { id: this.id(), name, objectSchemaKey: key };
    this.schemas.push(s);
    const types = referenceArtifacts().filter((a) => a.partOf === templateId && a.kind === 'assets-object-type' && a.verification.status !== 'deprecated');
    const byName = new Map<string, Obj>();
    const typeCode: Record<string, number> = { reference: 1, user: 2, group: 4, status: 7 };
    // Parents first, so children can point at them.
    const pending = [...types];
    while (pending.length) {
      const i = pending.findIndex((a) => { const p = (a.attributes as Obj | undefined)?.['parent']; return !p || byName.has(p); });
      const [a] = pending.splice(i < 0 ? 0 : i, 1);
      const attrs = (a!.attributes ?? {}) as Obj;
      const t = { id: this.id(), name: a!.name, objectSchemaId: s.id, parentObjectTypeId: attrs['parent'] ? byName.get(attrs['parent'])?.id : undefined, abstractObjectType: !!attrs['abstract'] };
      this.objectTypes.push(t);
      byName.set(a!.name, t);
      const own = ((attrs['attributes'] ?? []) as Obj[]).filter((x) => !x['inherited']);
      const names = new Set(own.map((x) => String(x['name'])));
      for (const n of ['Key', 'Name', 'Created', 'Updated']) if (!names.has(n)) this.attributes.push({ id: this.id(), name: n, objectTypeId: t.id, type: 0 });
      for (const x of own) this.attributes.push({ id: this.id(), name: x['name'], objectTypeId: t.id, type: typeCode[String(x['type'])] ?? 0 });
    }
    return s;
  }

  private route(api: string, m: string, full: string, body: Obj, as = 'fake-user'): unknown {
    const [path, qs = ''] = full.replace(/^https:\/\/api\.atlassian\.com/, '').split('?');
    const q = new URLSearchParams(qs);
    const seg = path!.split('/').filter(Boolean);
    const at = (re: RegExp) => path!.match(re);
    let r: RegExpMatchArray | null;
    const rt = this.runtime(api, m, path!, body, as);
    if (rt !== NO_ROUTE) return rt;

    if (api === 'call' && (r = at(/\/rule\/summary$/))) return { data: this.automations };

    if (api === 'jira') {
      if (path === '/rest/api/3/myself') return { accountId: 'fake-user' };
      if (path === '/rest/api/3/projectvalidate/key') {
        const k = q.get('key') ?? '';
        const used = this.projects.find((p) => p.key === k);
        return { errorMessages: [], errors: used ? { projectKey: `Project '${used.name}' uses this project key.` } : /^[A-Z][A-Z0-9]{1,9}$/.test(k) ? {} : { projectKey: 'invalid key' } };
      }
      if (path === '/rest/api/3/project/search') return { values: this.projects.filter((p) => p.name.toLowerCase().includes((q.get('query') ?? '').toLowerCase())) };
      if (path === '/rest/api/3/project' && m === 'POST') {
        if (!body.key || !body.name || !body.leadAccountId) throw bad('project needs key, name and leadAccountId');
        if (this.projects.some((p) => p.key === body.key)) throw bad(`key ${body.key} is taken`);
        const p = { id: this.id(), key: body.key, name: body.name, projectTypeKey: body.projectTypeKey };
        this.projects.push(p);
        if (body.projectTemplateKey) this.seedTemplate(p, body.projectTemplateKey);
        return { id: Number(p.id), key: p.key };
      }
      if ((r = at(/^\/rest\/api\/3\/project\/([^/]+)$/))) return this.projects.find((p) => p.id === r![1] || p.key === r![1]) ?? (() => { throw notFound('project'); })();
      if (path === '/rest/api/3/issuetype/project') return (this.projectIssueTypes.get(q.get('projectId') ?? '') ?? []).map((id) => this.issueTypes.find((t) => t.id === id));
      if (path === '/rest/api/3/issuetype' && m === 'GET') return this.issueTypes;
      if (path === '/rest/api/3/issuetype' && m === 'POST') { const t = { id: this.id(), name: body.name, description: body.description }; this.issueTypes.push(t); return t; }
      if ((r = at(/^\/rest\/api\/3\/issuetype\/(\w+)$/))) return this.issueTypes.find((t) => t.id === r![1]) ?? (() => { throw notFound('issuetype'); })();
      if (path === '/rest/api/3/workflows/search') return { values: this.workflows.filter((w) => w.name.toLowerCase().includes((q.get('queryString') ?? '').toLowerCase())) };
      if (path === '/rest/api/3/field' && m === 'GET') return this.opts.staleFieldList ? this.fields.filter((f) => !this.createdFields.has(f.id)) : this.fields;
      if (path === '/rest/api/3/field/search') {
        const ids = q.getAll('id');
        const query = (q.get('query') ?? '').toLowerCase();
        const all = this.fields.filter((f) => (ids.length ? ids.includes(f.id) : f.name.toLowerCase().includes(query)));
        const startAt = Number(q.get('startAt') ?? 0), max = Number(q.get('maxResults') ?? 50);
        return { values: all.slice(startAt, startAt + max), startAt, total: all.length, isLast: startAt + max >= all.length };
      }
      if (path === '/rest/api/3/field' && m === 'POST') {
        if (!body.type || !body.searcherKey) throw bad('field needs type and searcherKey');
        const f = { id: `customfield_${this.id()}`, name: body.name, custom: true, schema: { custom: body.type } };
        this.fields.push(f);
        this.createdFields.add(f.id);
        this.contexts.set(f.id, [{ id: this.id(), isGlobalContext: true, options: [] }]);
        return f;
      }
      if ((r = at(/^\/rest\/api\/3\/field\/([^/]+)\/context$/))) return { values: (this.contexts.get(r[1]!) ?? []).map(({ options: _o, ...c }) => c) };
      if ((r = at(/^\/rest\/api\/3\/field\/([^/]+)\/context\/([^/]+)\/option$/))) {
        const c = (this.contexts.get(r[1]!) ?? []).find((x) => x.id === r![2]);
        if (!c) throw notFound('context');
        if (m === 'POST') { for (const o of body.options as Obj[]) { if (c.options.some((x) => x.value === o.value)) throw bad(`option ${o.value} exists`); c.options.push({ id: this.id(), value: o.value }); } return { options: c.options }; }
        return { values: c.options };
      }
      if (path === '/rest/api/3/group/bulk') return { values: this.groups.filter((g) => g.name === q.get('groupName')) };
      if (path === '/rest/api/3/group' && m === 'POST') { const g = { groupId: this.id(), name: body.name }; this.groups.push(g); return g; }
    }

    if (api === 'jsm') {
      if (path === '/rest/servicedeskapi/servicedesk') return { values: this.serviceDesks };
      if ((r = at(/^\/rest\/servicedeskapi\/servicedesk\/(\w+)\/requesttypegroup$/))) return { values: this.rtGroups.filter((g) => g.sd === r![1]) };
      if ((r = at(/^\/rest\/servicedeskapi\/servicedesk\/(\w+)\/requesttype$/))) {
        if (m === 'POST') { if (!this.issueTypes.some((t) => t.id === body.issueTypeId)) throw bad('unknown issueTypeId'); const rt = { id: this.id(), name: body.name, description: body.description, issueTypeId: body.issueTypeId, sd: r[1] }; this.requestTypes.push(rt); return rt; }
        return { values: this.requestTypes.filter((x) => x.sd === r![1]) };
      }
      if ((r = at(/^\/rest\/servicedeskapi\/servicedesk\/(\w+)\/requesttype\/(\w+)$/))) return this.requestTypes.find((x) => x.sd === r![1] && x.id === r![2]) ?? (() => { throw notFound('request type'); })();
      if ((r = at(/^\/rest\/servicedeskapi\/servicedesk\/(\w+)\/queue$/))) return { values: this.queues.filter((x) => x.sd === r![1]) };
      if ((r = at(/^\/rest\/servicedeskapi\/servicedesk\/(\w+)\/queue\/(\w+)$/))) return this.queues.find((x) => x.id === r![2]) ?? (() => { throw notFound('queue'); })();
    }

    if (api === 'assets') {
      if (path === '/objectschema/list') return { values: this.schemas };
      if (path === '/objectschema/create') { if (!body.objectSchemaKey) throw bad('schema key'); const s = { id: this.id(), name: body.name, objectSchemaKey: body.objectSchemaKey }; this.schemas.push(s); return s; }
      if ((r = at(/^\/objectschema\/(\w+)\/objecttypes\/flat$/))) return this.objectTypes.filter((t) => t.objectSchemaId === r![1]);
      if ((r = at(/^\/objectschema\/(\w+)$/))) return this.schemas.find((s) => s.id === r![1]) ?? (() => { throw notFound('schema'); })();
      if (path === '/config/statustype' && m === 'GET') return this.statusTypes.filter((s) => !q.get('objectSchemaId') || !s.objectSchemaId || s.objectSchemaId === q.get('objectSchemaId'));
      if (path === '/config/statustype' && m === 'POST') { const s = { id: this.id(), name: body.name, category: body.category, objectSchemaId: body.objectSchemaId }; this.statusTypes.push(s); return s; }
      if (path === '/config/referencetype') return this.referenceTypes;
      if (path === '/icon/global') return this.icons;
      if (path === '/objecttype/create') {
        if (!body.iconId) throw bad('iconId required');
        if (!this.schemas.some((s) => s.id === String(body.objectSchemaId))) throw bad('unknown schema');
        const t = { id: this.id(), name: body.name, objectSchemaId: String(body.objectSchemaId), parentObjectTypeId: body.parentObjectTypeId };
        this.objectTypes.push(t);
        // Live site (2026-10-16): an object type created through the API gets only Key, Created and Updated; no Name.
        for (const n of ['Key', 'Created', 'Updated']) this.attributes.push({ id: this.id(), name: n, objectTypeId: t.id, type: 0, system: true });
        return t;
      }
      if ((r = at(/^\/objecttype\/(\w+)\/attributes$/))) return this.attributes.filter((a) => a.objectTypeId === r![1]);
      if ((r = at(/^\/objecttype\/(\w+)$/))) return this.objectTypes.find((t) => t.id === r![1]) ?? (() => { throw notFound('object type'); })();
      if ((r = at(/^\/objecttypeattribute\/(\w+)$/)) && m === 'POST') {
        if (body.type === 1 && (!body.typeValue || !body.additionalValue || String(body.typeValue).startsWith('<'))) throw bad('reference attribute needs typeValue and additionalValue');
        const a = { id: this.id(), name: body.name, objectTypeId: r[1], type: body.type, options: body.options };
        this.attributes.push(a);
        return a;
      }
      if ((r = at(/^\/objecttypeattribute\/(\w+)\/(\w+)$/)) && m === 'PUT') { const a = this.attributes.find((x) => x.id === r![2]); if (!a) throw notFound('attribute'); Object.assign(a, { options: body.options }); return a; }
    }
    throw Object.assign(new Error(`fake site: no route for ${api} ${m} ${path} (${seg.length} segments)`), { status: 501 });
  }
}
