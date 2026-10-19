import type { SnRecord } from '../types';
import type { HttpFetch, HttpResponse } from './http';

/**
 * A ServiceNow instance in memory, for tests: OAuth token endpoint (client credentials and password grants), Table
 * API with sys_id keyset paging and field selection, and the Aggregate (stats) API with group-by counts. Records keep
 * their tables; sys_ids that are not 32 hex characters are replaced by stable ones, as on a real instance.
 * Every request is logged, so tests can assert the collector only reads.
 */
export class FakeServiceNow {
  readonly instanceUrl: string;
  readonly requests: { method: string; path: string; query: string }[] = [];
  private readonly tables = new Map<string, Record<string, string>[]>();
  private issued = 0;
  /** Valid credentials; a grant succeeds only with these. */
  creds = { clientId: 'client-1', clientSecret: 'secret-1', username: 'svc.migration', password: 'pw-1' };
  allowClientCredentials = true;
  /** Basic auth with the integration user's credentials (on by default, as on most instances). */
  allowBasic = true;

  constructor(records: SnRecord[], opts: { host?: string; release?: string } = {}) {
    this.instanceUrl = `https://${opts.host ?? 'dev12345.service-now.com'}`;
    let n = 0;
    for (const r of records) {
      const sysId = /^[0-9a-f]{32}$/.test(r.sysId) ? r.sysId : (++n).toString(16).padStart(32, '0');
      const row = { ...r.fields, sys_id: sysId, sys_class_name: r.fields.sys_class_name ?? r.table };
      const list = this.tables.get(r.table) ?? [];
      list.push(row);
      this.tables.set(r.table, list);
    }
    for (const list of this.tables.values()) list.sort((a, b) => a.sys_id!.localeCompare(b.sys_id!));
    this.tables.set('sys_properties', [{ sys_id: 'f'.repeat(32), name: 'glide.buildname', value: opts.release ?? 'Xanadu' }]);
  }

  get fetch(): HttpFetch {
    return async (url, init) => this.handle(url, init);
  }

  private json(status: number, body: unknown): HttpResponse {
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  }

  private async handle(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<HttpResponse> {
    const u = new URL(url);
    if (`${u.protocol}//${u.host}` !== this.instanceUrl) return this.json(404, { error: 'unknown host' });
    this.requests.push({ method: init.method, path: u.pathname, query: u.searchParams.get('sysparm_query') ?? '' });
    if (u.pathname === '/oauth_token.do' && init.method === 'POST') return this.token(new URLSearchParams(init.body ?? ''));
    if (init.method !== 'GET') return this.json(405, { error: { message: 'read-only fake' } });
    const authz = init.headers.Authorization ?? '';
    const basic = authz.startsWith('Basic ') && this.allowBasic && Buffer.from(authz.slice(6), 'base64').toString('utf8') === `${this.creds.username}:${this.creds.password}`;
    if (!basic && !/^Bearer tok-\d+$/.test(authz)) return this.json(401, { error: { message: 'User Not Authenticated', detail: 'Required to provide Auth information' }, status: 'failure' });
    const table = decodeURIComponent(u.pathname.split('/').at(-1) ?? '');
    if (u.pathname.startsWith('/api/now/table/')) return this.table(table, u.searchParams);
    if (u.pathname.startsWith('/api/now/stats/')) return this.stats(table, u.searchParams);
    return this.json(404, { error: { message: 'not found' } });
  }

  private token(f: URLSearchParams): HttpResponse {
    const c = this.creds;
    if (f.get('client_id') !== c.clientId || f.get('client_secret') !== c.clientSecret) return this.json(401, { error: 'invalid_client', error_description: 'bad client' });
    const grant = f.get('grant_type');
    if (grant === 'client_credentials' && !this.allowClientCredentials) return this.json(400, { error: 'unsupported_grant_type' });
    if (grant === 'password' && (f.get('username') !== c.username || f.get('password') !== c.password)) return this.json(401, { error: 'invalid_grant', error_description: 'access_denied' });
    if (grant === 'refresh_token' && !/^ref-\d+$/.test(f.get('refresh_token') ?? '')) return this.json(401, { error: 'invalid_grant' });
    if (!['client_credentials', 'password', 'refresh_token'].includes(grant ?? '')) return this.json(400, { error: 'unsupported_grant_type' });
    const n = ++this.issued;
    return this.json(200, { access_token: `tok-${n}`, expires_in: 1800, ...(grant !== 'client_credentials' ? { refresh_token: `ref-${n}` } : {}) });
  }

  private rows(table: string, query: string): Record<string, string>[] | undefined {
    const list = this.tables.get(table);
    if (!list) return undefined;
    const match = compileQuery(query);
    return list.filter(match);
  }

  private table(table: string, q: URLSearchParams): HttpResponse {
    const rows = this.rows(table, q.get('sysparm_query') ?? '');
    if (!rows) return this.json(400, { error: { message: 'Invalid table' } });
    const limit = Number(q.get('sysparm_limit') ?? 10000);
    const fields = q.get('sysparm_fields')?.split(',');
    const display = q.get('sysparm_display_value') === 'all';
    const result = rows.slice(0, limit).map((r) => {
      const keys = fields ?? Object.keys(r).filter((k) => !k.endsWith('__display'));
      return Object.fromEntries(keys.map((k) => [k, display ? { value: r[k] ?? '', display_value: r[`${k}__display`] ?? r[k] ?? '' } : r[k] ?? '']));
    });
    return this.json(200, { result });
  }

  private stats(table: string, q: URLSearchParams): HttpResponse {
    const rows = this.rows(table, '') ?? [];
    const groupBy = q.get('sysparm_group_by')?.split(',').filter(Boolean);
    if (!groupBy?.length) return this.json(200, { result: { stats: { count: String(rows.length) } } });
    const counts = new Map<string, { fields: { field: string; value: string }[]; count: number }>();
    for (const r of rows) {
      const fields = groupBy.map((g) => ({ field: g, value: r[g] ?? '' }));
      const k = JSON.stringify(fields);
      const e = counts.get(k) ?? { fields, count: 0 };
      e.count++;
      counts.set(k, e);
    }
    return this.json(200, { result: [...counts.values()].map((e) => ({ groupby_fields: e.fields, stats: { count: String(e.count) } })) });
  }
}

/**
 * A small ServiceNow encoded-query evaluator: `^` is AND, `^OR` joins the previous condition, ORDERBY is ignored.
 * Lenient on purpose: a condition on a field the fixture row does not have matches, so sparse fixtures still flow.
 */
export function compileQuery(query: string): (r: Record<string, string>) => boolean {
  const groups: ((r: Record<string, string>) => boolean)[][] = [];
  for (const raw of query.split('^').filter(Boolean)) {
    if (/^(ORDERBY|ORDERBYDESC)/.test(raw)) continue;
    // Field names are lower case, so an upper-case OR prefix is unambiguous.
    const isOr = groups.length > 0 && /^OR[a-z]/.test(raw);
    const cond = condition(isOr ? raw.slice(2) : raw);
    if (isOr) groups[groups.length - 1]!.push(cond); else groups.push([cond]);
  }
  return (r) => groups.every((g) => g.some((c) => c(r)));
}

function condition(term: string): (r: Record<string, string>) => boolean {
  const m = /^([a-z0-9_.]+?)(ISNOTEMPTY|ISEMPTY|STARTSWITH|NOT IN|IN|!=|>=|<=|>|<|=)(.*)$/.exec(term);
  if (!m) return () => true;
  const [, field, op, value] = m as unknown as [string, string, string, string];
  return (r) => {
    const v = r[field!];
    if (v === undefined) return true;
    switch (op) {
      case 'ISNOTEMPTY': return v !== '';
      case 'ISEMPTY': return v === '';
      case 'STARTSWITH': return v.startsWith(value);
      case 'IN': return value.split(',').includes(v);
      case 'NOT IN': return !value.split(',').includes(v);
      case '!=': return value === 'NULL' ? v !== '' : v !== value;
      case '=': return value === 'NULL' ? v === '' : v === value;
      case '>': return v > value;
      case '<': return v < value;
      case '>=': return v >= value;
      case '<=': return v <= value;
      default: return true;
    }
  };
}
