/**
 * Atlassian Cloud REST client for Jira, JSM and Assets.
 * - Site APIs: https://<site>.atlassian.net/rest/...
 * - Assets APIs: https://api.atlassian.com/jsm/assets/workspace/<workspaceId>/v1/...
 * Supports a read-only mode that refuses any non-GET request. Capture and probe tools use it by default.
 */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export interface AtlassianAuth {
  header(): Promise<string>;
  readonly description: string;
}

/** Email + API token (Basic). For production builds prefer OAuth 2.0 (3LO) or scoped tokens. */
export class ApiTokenAuth implements AtlassianAuth {
  readonly description: string;
  constructor(private readonly email: string, private readonly token: string) {
    this.description = `API token (${email.replace(/(.).*(@.*)/, '$1…$2')})`;
  }
  async header() {
    return `Basic ${Buffer.from(`${this.email}:${this.token}`).toString('base64')}`;
  }
}

export class AtlassianError extends Error {
  constructor(message: string, readonly status: number, readonly method: string, readonly path: string, readonly body?: unknown) {
    super(message);
    this.name = 'AtlassianError';
  }
}

export interface ClientOptions {
  site: string;
  auth: AtlassianAuth;
  fetch?: HttpFetch;
  readOnly?: boolean;
  /** POST endpoints that only query (bulk-get / search) and are allowed in read-only mode. */
  queryPosts?: RegExp[];
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface RawResult {
  status: number;
  json: unknown;
  headers: HttpResponse['headers'];
}

/** Known non-mutating POST endpoints (search / bulk read). Anything else is refused in read-only mode. */
export const DEFAULT_QUERY_POSTS: RegExp[] = [
  /\/rest\/api\/3\/workflows$/, // bulk get workflows (create is /workflows/create)
  /\/rest\/api\/3\/search\/jql$/,
  /\/automation\/public\/[a-z]+\/[0-9a-f-]+\/rest\/v1\/rule\/summary$/,
  /\/jsm\/assets\/workspace\/[^/]+\/v1\/object\/aql$/,
];

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function normaliseSite(raw: string): string {
  const u = new URL(/^https?:\/\//.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  if (!/^[a-z0-9-]+\.atlassian\.net$/i.test(u.hostname)) throw new Error('Site must be <name>.atlassian.net');
  return `https://${u.hostname.toLowerCase()}`;
}

export class AtlassianClient {
  readonly siteUrl: string;
  readonly readOnly: boolean;
  private readonly http: HttpFetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private workspaceId?: string;
  private cloud?: string;
  requestCount = 0;

  constructor(private readonly opts: ClientOptions) {
    this.siteUrl = normaliseSite(opts.site);
    this.readOnly = opts.readOnly ?? true;
    this.http = opts.fetch ?? ((url, init) => fetch(url, init) as unknown as Promise<HttpResponse>);
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Low-level request. Returns status and JSON without throwing on 4xx, so probes can inspect them. */
  async raw(method: string, url: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<RawResult> {
    if (this.readOnly && method !== 'GET' && !(method === 'POST' && (this.opts.queryPosts ?? DEFAULT_QUERY_POSTS).some((r) => r.test(url.split('?')[0]!)))) {
      throw new Error(`read-only client refused ${method} ${url}`);
    }
    const max = this.opts.maxRetries ?? 4;
    for (let attempt = 0; ; attempt++) {
      this.requestCount++;
      const res = await this.http(url, {
        method,
        headers: {
          Accept: 'application/json',
          Authorization: await this.opts.auth.header(),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          ...extraHeaders,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if ((res.status === 429 || res.status >= 500) && attempt < max) {
        const ra = Number(res.headers.get('retry-after'));
        await this.sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(20000, 500 * 2 ** attempt));
        continue;
      }
      const text = await res.text();
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = text.slice(0, 500);
      }
      return { status: res.status, json, headers: res.headers };
    }
  }

  private async ok<T>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    const r = await this.raw(method, url, body, headers);
    if (r.status < 200 || r.status >= 300) {
      const path = url.replace(/^https:\/\/[^/]+/, '');
      throw new AtlassianError(`${method} ${path} → ${r.status}: ${summariseError(r.json)}`, r.status, method, path, r.json);
    }
    return r.json as T;
  }

  /** Site REST call, e.g. jira('GET', '/rest/api/3/project/REFITSM'). */
  jira<T = any>(method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.ok<T>(method, `${this.siteUrl}${path}`, body, headers);
  }

  /** JSM REST call. Adds the experimental opt-in header that some servicedeskapi endpoints require. */
  jsm<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    return this.ok<T>(method, `${this.siteUrl}${path}`, body, { 'X-ExperimentalApi': 'opt-in' });
  }

  /** Site cloud id (needed for api.atlassian.com product APIs such as Automation and Forms). */
  async cloudId(): Promise<string> {
    if (this.cloud) return this.cloud;
    const r = await this.ok<{ cloudId?: string }>('GET', `${this.siteUrl}/_edge/tenant_info`);
    if (!r.cloudId) throw new Error('tenant_info returned no cloudId');
    this.cloud = r.cloudId;
    return r.cloudId;
  }

  /** Call any absolute URL (e.g. api.atlassian.com) with the site's auth; throws on non-2xx. */
  call<T = any>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    return this.ok<T>(method, url, body, headers);
  }

  async assetsWorkspaceId(): Promise<string> {
    if (this.workspaceId) return this.workspaceId;
    const r = await this.jsm<{ values?: { workspaceId: string }[] }>('GET', '/rest/servicedeskapi/assets/workspace');
    const id = r.values?.[0]?.workspaceId;
    if (!id) throw new Error('No Assets workspace found. Assets needs JSM Premium/Enterprise and must be opened once in the UI.');
    this.workspaceId = id;
    return id;
  }

  async assetsUrl(path: string): Promise<string> {
    return `https://api.atlassian.com/jsm/assets/workspace/${await this.assetsWorkspaceId()}/v1${path}`;
  }

  /** Assets REST call, e.g. assets('GET', '/objectschema/list'). */
  async assets<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    return this.ok<T>(method, await this.assetsUrl(path), body);
  }

  /** Collect every page of a Jira "isLast/values" or JSM "isLastPage/values" endpoint. */
  async paged<T = any>(path: string, opts: { jsm?: boolean; pageSize?: number; max?: number } = {}): Promise<T[]> {
    const out: T[] = [];
    const size = opts.pageSize ?? 50;
    for (let start = 0; out.length < (opts.max ?? 5000); start += size) {
      const sep = path.includes('?') ? '&' : '?';
      const p = `${path}${sep}${opts.jsm ? 'start' : 'startAt'}=${start}&${opts.jsm ? 'limit' : 'maxResults'}=${size}`;
      const r: any = opts.jsm ? await this.jsm('GET', p) : await this.jira('GET', p);
      const values: T[] = r.values ?? r.results ?? [];
      out.push(...values);
      if (r.isLast === true || r.isLastPage === true || values.length < size) break;
    }
    return out;
  }
}

export function summariseError(json: unknown): string {
  if (!json || typeof json !== 'object') return String(json ?? '').slice(0, 300);
  const j = json as Record<string, any>;
  const parts = [j.errorMessage, j.message, ...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].filter(Boolean);
  return (parts.length ? parts.join('; ') : JSON.stringify(json)).slice(0, 300);
}
