import type { SnRecord } from '../types';
import type { TokenProvider } from './auth';
import { HttpFetch, HttpResponse, ServiceNowError, nodeFetch } from './http';

export interface ClientOptions {
  instanceUrl: string;
  auth: TokenProvider;
  fetch?: HttpFetch;
  /** Max requests per second (sequential). Keep this low on production instances. */
  maxRequestsPerSecond?: number;
  maxRetries?: number;
  pageSize?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface TableQuery {
  fields?: string[];
  /** Encoded query without ORDERBY. Paging adds its own ordering. */
  query?: string;
  displayValue?: boolean;
  pageSize?: number;
  /** Resume after this sys_id (checkpoint from a previous run). */
  startAfter?: string;
  /** Stop after this many records (sampling). */
  limit?: number;
}

export interface GroupCount {
  group: Record<string, string>;
  count: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const SYS_ID = /^[0-9a-f]{32}$/;

/**
 * Read-only ServiceNow REST client: Table API with keyset paging and Aggregate (stats) API for counts.
 * Only GET requests are sent (plus the OAuth token POST in the auth provider).
 */
export class ServiceNowClient {
  readonly instanceUrl: string;
  private readonly http: HttpFetch;
  private readonly minIntervalMs: number;
  private readonly maxRetries: number;
  private readonly pageSize: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private lastRequestAt = 0;
  requestCount = 0;

  constructor(private readonly opts: ClientOptions) {
    this.instanceUrl = opts.instanceUrl;
    this.http = opts.fetch ?? nodeFetch;
    this.minIntervalMs = 1000 / Math.max(0.1, opts.maxRequestsPerSecond ?? 4);
    this.maxRetries = opts.maxRetries ?? 5;
    this.pageSize = Math.min(10000, Math.max(1, opts.pageSize ?? 1000));
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
  }

  /** GET a JSON API path (e.g. /api/now/table/sys_script?…). Retries 429/5xx with backoff and refreshes the token once on 401. */
  async get(path: string): Promise<{ json: any; headers: HttpResponse['headers'] }> {
    let refreshed = false;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastRequestAt + this.minIntervalMs - this.now();
      if (wait > 0) await this.sleep(wait);
      this.lastRequestAt = this.now();
      this.requestCount++;
      const token = await this.opts.auth.getToken(false);
      const res = await this.http(`${this.instanceUrl}${path}`, {
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      });
      if (res.status === 401 && !refreshed) {
        refreshed = true;
        await this.opts.auth.getToken(true);
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt < this.maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(30000, 500 * 2 ** attempt));
        continue;
      }
      const raw = await res.text();
      if (res.status === 401) throw new ServiceNowError('ServiceNow rejected the token (401).', 401);
      if (res.status === 403) throw new ServiceNowError(`No read access (403) for ${path.split('?')[0]}. Grant the integration user read on this table.`, 403);
      if (res.status < 200 || res.status >= 300) throw new ServiceNowError(`ServiceNow returned ${res.status} for ${path.split('?')[0]}: ${raw.slice(0, 300)}`, res.status);
      try {
        return { json: raw ? JSON.parse(raw) : {}, headers: res.headers };
      } catch {
        throw new ServiceNowError(`ServiceNow returned a web page instead of JSON for ${path.split('?')[0]}. Is the instance awake? (developer instances hibernate when idle)`, res.status);
      }
    }
  }

  /** Instance build/release from glide.buildname (+ glide.war for the full version). */
  async instanceInfo(): Promise<{ build?: string; war?: string }> {
    const { json } = await this.get('/api/now/table/sys_properties?sysparm_query=nameINglide.buildname,glide.war&sysparm_fields=name,value&sysparm_limit=5');
    const rows: { name: string; value: string }[] = json?.result ?? [];
    return { build: rows.find((r) => r.name === 'glide.buildname')?.value, war: rows.find((r) => r.name === 'glide.war')?.value };
  }

  /** Server-side count (Aggregate API). No records are transferred. */
  async count(table: string, query?: string): Promise<number> {
    const q = new URLSearchParams({ sysparm_count: 'true' });
    if (query) q.set('sysparm_query', query);
    const { json } = await this.get(`/api/now/stats/${encodeURIComponent(table)}?${q}`);
    return Number(json?.result?.stats?.count ?? 0);
  }

  /** Server-side grouped counts, e.g. CI counts by sys_class_name, or relationships by type. */
  async countBy(table: string, groupBy: string[], query?: string): Promise<GroupCount[]> {
    const q = new URLSearchParams({ sysparm_count: 'true', sysparm_group_by: groupBy.join(',') });
    if (query) q.set('sysparm_query', query);
    const { json } = await this.get(`/api/now/stats/${encodeURIComponent(table)}?${q}`);
    const rows: any[] = Array.isArray(json?.result) ? json.result : json?.result ? [json.result] : [];
    return rows.map((r) => ({
      group: Object.fromEntries(((r.groupby_fields ?? []) as { field: string; value: string }[]).map((g) => [g.field, g.value])),
      count: Number(r?.stats?.count ?? 0),
    }));
  }

  /**
   * Iterate a table page by page using keyset paging on sys_id (stable across millions of rows, unlike offsets).
   * Yields pages, so callers can checkpoint `lastSysId` and resume with `startAfter`.
   */
  async *iterateTable(table: string, q: TableQuery = {}): AsyncGenerator<{ records: SnRecord[]; lastSysId: string; fetched: number }> {
    const pageSize = Math.min(this.pageSize, q.pageSize ?? this.pageSize);
    const fields = q.fields?.length ? [...new Set(['sys_id', ...q.fields])] : undefined;
    let after = q.startAfter;
    if (after && !SYS_ID.test(after)) throw new Error('startAfter must be a 32-character sys_id');
    let fetched = 0;
    for (;;) {
      const remaining = q.limit !== undefined ? q.limit - fetched : Infinity;
      if (remaining <= 0) return;
      const parts = [q.query, after ? `sys_id>${after}` : undefined, 'ORDERBYsys_id'].filter(Boolean);
      const params = new URLSearchParams({
        sysparm_query: parts.join('^'),
        sysparm_limit: String(Math.min(pageSize, remaining)),
        sysparm_exclude_reference_link: 'true',
        sysparm_display_value: q.displayValue ? 'all' : 'false',
      });
      if (fields) params.set('sysparm_fields', fields.join(','));
      const { json } = await this.get(`/api/now/table/${encodeURIComponent(table)}?${params}`);
      const rows: Record<string, unknown>[] = json?.result ?? [];
      if (!rows.length) return;
      const records = rows.map((r) => normaliseRow(table, r));
      fetched += records.length;
      after = records[records.length - 1]!.sysId;
      yield { records, lastSysId: after, fetched };
      if (rows.length < Math.min(pageSize, remaining)) return;
    }
  }
}

/** Table API row → SnRecord. With display values on, each field is {value, display_value}. */
export function normaliseRow(table: string, row: Record<string, unknown>): SnRecord {
  const fields: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    if (v && typeof v === 'object' && 'value' in (v as object)) {
      const o = v as { value?: unknown; display_value?: unknown };
      fields[k] = String(o.value ?? '');
      if (o.display_value !== undefined && String(o.display_value) !== fields[k]) fields[`${k}__display`] = String(o.display_value ?? '');
    } else {
      fields[k] = v === null || v === undefined ? '' : String(v);
    }
  }
  return { table: fields.sys_class_name || table, sysId: fields.sys_id ?? '', fields };
}
