import type { AtlassianClient } from '@snjsm/atlassian';

/** What a template actually creates on a real site. Read-only GET calls only. */
export interface Capture {
  site: string;
  capturedAt: string;
  project?: {
    key: string; id: string; name: string; projectTypeKey: string; style?: string;
    workTypes: { id: string; name: string; subtask: boolean }[];
    workflowScheme?: { id: number; name: string; defaultWorkflow?: string; mappings: Record<string, string> };
    statusesByWorkType: Record<string, { name: string; category: 'TODO' | 'IN_PROGRESS' | 'DONE' }[]>;
  };
  serviceDesk?: {
    id: string;
    requestTypes: { id: string; name: string; workType?: string; groups: string[]; fields: { fieldId: string; name: string; required: boolean }[] }[];
    groups: { id: string; name: string }[];
    queues: { id: string; name: string; jql?: string }[];
  };
  fields?: { id: string; name: string; custom: boolean; schemaType?: string; customType?: string }[];
  assets?: {
    workspaceId: string;
    schema?: { id: string; name: string; key: string };
    objectTypes: { id: string; name: string; parent?: string; abstract?: boolean; attributes: { name: string; type: string }[] }[];
    statusTypes: { name: string; category: string }[];
  };
  /** Endpoints that could not be read, with the HTTP status (useful evidence for the coverage matrix). */
  unavailable: { what: string; status?: number; message: string }[];
}

const CATEGORY: Record<string, 'TODO' | 'IN_PROGRESS' | 'DONE'> = { new: 'TODO', indeterminate: 'IN_PROGRESS', done: 'DONE' };

/** Assets attribute "type" codes → readable names (defaultType ids for type 0). */
function assetsAttrType(a: any): string {
  const t = a?.type;
  if (t === 0) return ['text', 'integer', 'boolean', 'float', 'date', 'time', 'datetime', 'url', 'email', 'textarea', 'select', 'ipaddress'][a?.defaultType?.id] ?? 'default';
  return ({ 1: 'reference', 2: 'user', 4: 'group', 6: 'project', 7: 'status', 8: 'bitbucket-repo', 9: 'opsgenie-team' } as Record<number, string>)[t] ?? `type-${t}`;
}

export async function captureSite(c: AtlassianClient, opts: { projectKey?: string; schemaName?: string }): Promise<Capture> {
  const cap: Capture = { site: c.siteUrl, capturedAt: new Date().toISOString(), unavailable: [] };
  const attempt = async <T>(what: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (e) {
      cap.unavailable.push({ what, status: (e as { status?: number }).status, message: (e as Error).message });
      return undefined;
    }
  };

  if (opts.projectKey) {
    const p = await c.jira('GET', `/rest/api/3/project/${encodeURIComponent(opts.projectKey)}?expand=issueTypes`);
    cap.project = {
      key: p.key, id: p.id, name: p.name, projectTypeKey: p.projectTypeKey, style: p.style,
      workTypes: (p.issueTypes ?? []).map((t: any) => ({ id: t.id, name: t.name, subtask: Boolean(t.subtask) })),
      statusesByWorkType: {},
    };
    const statuses = await attempt('project statuses', () => c.jira('GET', `/rest/api/3/project/${p.key}/statuses`));
    for (const it of (statuses as any[]) ?? []) {
      cap.project.statusesByWorkType[it.name] = (it.statuses ?? []).map((s: any) => ({ name: s.name, category: CATEGORY[s.statusCategory?.key] ?? 'TODO' }));
    }
    const ws = await attempt('workflow scheme', () => c.jira('GET', `/rest/api/3/workflowscheme/project?projectId=${p.id}`));
    const scheme = (ws as any)?.values?.[0]?.workflowScheme;
    if (scheme) {
      const names = new Map(cap.project.workTypes.map((t) => [t.id, t.name]));
      cap.project.workflowScheme = {
        id: scheme.id, name: scheme.name, defaultWorkflow: scheme.defaultWorkflow,
        mappings: Object.fromEntries(Object.entries(scheme.issueTypeMappings ?? {}).map(([k, v]) => [names.get(k) ?? k, String(v)])),
      };
    }
    const desks = await attempt('service desks', () => c.paged<any>('/rest/servicedeskapi/servicedesk', { jsm: true }));
    const desk = desks?.find((d) => d.projectKey === p.key);
    if (desk) {
      const typeNames = new Map(cap.project.workTypes.map((t) => [t.id, t.name]));
      const groups = (await attempt('request type groups', () => c.paged<any>(`/rest/servicedeskapi/servicedesk/${desk.id}/requesttypegroup`, { jsm: true }))) ?? [];
      const groupNames = new Map(groups.map((g) => [String(g.id), g.name]));
      const rts = (await attempt('request types', () => c.paged<any>(`/rest/servicedeskapi/servicedesk/${desk.id}/requesttype`, { jsm: true }))) ?? [];
      const requestTypes = [];
      for (const rt of rts) {
        const f = await attempt(`request type fields: ${rt.name}`, () => c.jsm('GET', `/rest/servicedeskapi/servicedesk/${desk.id}/requesttype/${rt.id}/field`));
        requestTypes.push({
          id: String(rt.id), name: rt.name, workType: typeNames.get(String(rt.issueTypeId)),
          groups: (rt.groupIds ?? []).map((g: string) => groupNames.get(String(g)) ?? String(g)),
          fields: ((f as any)?.requestTypeFields ?? []).map((x: any) => ({ fieldId: x.fieldId, name: x.name, required: Boolean(x.required) })),
        });
      }
      const queues = (await attempt('queues', () => c.paged<any>(`/rest/servicedeskapi/servicedesk/${desk.id}/queue`, { jsm: true }))) ?? [];
      cap.serviceDesk = {
        id: String(desk.id), requestTypes,
        groups: groups.map((g) => ({ id: String(g.id), name: g.name })),
        queues: queues.map((q) => ({ id: String(q.id), name: q.name, jql: q.jql })),
      };
    } else {
      cap.unavailable.push({ what: 'service desk', message: `no service desk found for project ${p.key}` });
    }
    const fields = await attempt('fields', () => c.jira('GET', '/rest/api/3/field'));
    cap.fields = ((fields as any[]) ?? []).map((f) => ({ id: f.id, name: f.name, custom: Boolean(f.custom), schemaType: f.schema?.type, customType: f.schema?.custom }));
  }

  if (opts.schemaName) {
    const workspaceId = await attempt('assets workspace', () => c.assetsWorkspaceId());
    if (workspaceId) {
      cap.assets = { workspaceId, objectTypes: [], statusTypes: [] };
      const list = await attempt('assets schemas', () => c.assets('GET', '/objectschema/list?maxResults=100'));
      const schemas: any[] = (list as any)?.values ?? (list as any)?.objectschemas ?? [];
      const key = (v: unknown) => String(v ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
      const s = schemas.find((x) => key(x.name) === key(opts.schemaName) || key(x.objectSchemaKey) === key(opts.schemaName));
      if (!s) {
        cap.unavailable.push({ what: 'assets schema', message: `schema "${opts.schemaName}" not found (found: ${schemas.map((x) => x.name).join(', ') || 'none'})` });
      } else {
        cap.assets.schema = { id: String(s.id), name: s.name, key: s.objectSchemaKey };
        const types = ((await attempt('assets object types', () => c.assets('GET', `/objectschema/${s.id}/objecttypes/flat`))) as any[]) ?? [];
        const byId = new Map(types.map((t) => [String(t.id), t.name]));
        for (const t of types) {
          const attrs = ((await attempt(`assets attributes: ${t.name}`, () => c.assets('GET', `/objecttype/${t.id}/attributes`))) as any[]) ?? [];
          cap.assets.objectTypes.push({
            id: String(t.id), name: t.name, parent: t.parentObjectTypeId ? byId.get(String(t.parentObjectTypeId)) : undefined, abstract: Boolean(t.abstractObjectType),
            attributes: attrs.map((a) => ({ name: a.name, type: assetsAttrType(a) })),
          });
        }
        const st = ((await attempt('assets status types', () => c.assets('GET', `/config/statustype?objectSchemaId=${s.id}`))) as any[]) ?? [];
        cap.assets.statusTypes = st.map((x) => ({ name: x.name, category: ({ 0: 'inactive', 1: 'active', 2: 'pending' } as Record<number, string>)[x.category] ?? String(x.category) }));
      }
    }
  }
  return cap;
}
