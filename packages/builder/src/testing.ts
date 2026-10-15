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

export class FakeSite {
  readonly writes: { method: string; path: string; body?: unknown }[] = [];
  private seq = 10000;
  projects: Obj[] = [];
  serviceDesks: Obj[] = [];
  issueTypes: Obj[] = [{ id: '1', name: 'Task' }];
  projectIssueTypes = new Map<string, string[]>();
  workflows: Obj[] = [];
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
   */
  constructor(readonly siteUrl = 'https://fake-sandbox.atlassian.net', readonly opts: { systemPrefix?: boolean } = {}) {}
  private id = () => String(++this.seq);

  /** A client view. Read-only views reject writes, like AtlassianClient. */
  client(readOnly: boolean): SiteApi {
    const go = (api: 'jira' | 'jsm' | 'assets' | 'call') => async (method: string, path: string, body?: unknown) => {
      const m = method.toUpperCase();
      const isQueryPost = m === 'POST' && /\/rule\/summary$/.test(path);
      if (readOnly && m !== 'GET' && !isQueryPost) throw new Error(`read-only client refused ${m} ${path}`);
      if (m !== 'GET' && !isQueryPost) this.writes.push({ method: m, path, body });
      return this.route(api, m, path, body as Obj);
    };
    return { siteUrl: this.siteUrl, readOnly, jira: go('jira'), jsm: go('jsm'), assets: go('assets'), call: go('call'), cloudId: async () => 'fake-cloud' } as SiteApi;
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

  private route(api: string, m: string, full: string, body: Obj): unknown {
    const [path, qs = ''] = full.replace(/^https:\/\/api\.atlassian\.com/, '').split('?');
    const q = new URLSearchParams(qs);
    const seg = path!.split('/').filter(Boolean);
    const at = (re: RegExp) => path!.match(re);
    let r: RegExpMatchArray | null;

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
      if (path === '/rest/api/3/field' && m === 'GET') return this.fields;
      if (path === '/rest/api/3/field' && m === 'POST') {
        if (!body.type || !body.searcherKey) throw bad('field needs type and searcherKey');
        const f = { id: `customfield_${this.id()}`, name: body.name, custom: true, schema: { custom: body.type } };
        this.fields.push(f);
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
        for (const n of ['Key', 'Name', 'Created', 'Updated']) this.attributes.push({ id: this.id(), name: n, objectTypeId: t.id, type: 0 });
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
