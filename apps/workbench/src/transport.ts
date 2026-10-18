import { AtlassianClient, UnreachableError, normaliseSite, type HttpFetch, type HttpResponse, type RawResult } from '@snjsm/atlassian';

/** A Forge product request (api.asUser().requestJira or api.asApp().requestJira) on a path, after validation. */
export type ProductRequest = (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

/** Paths the engine may call through Forge. Anything else is refused before it reaches the platform. */
const ALLOWED = [/^\/rest\/(api\/3|servicedeskapi|agile\/1\.0)\//, /^\/jsm\/assets\/workspace\/[A-Za-z0-9-]+\/v1\//];

/**
 * Map an absolute URL from AtlassianClient to a product path for this site:
 *  - https://<site>/rest/...                                  → /rest/...
 *  - https://api.atlassian.com/jsm/assets/workspace/<id>/v1/… → /jsm/assets/workspace/<id>/v1/… (Assets via requestJira)
 *  - https://api.atlassian.com/ex/jira/<cloudId>/rest/...     → /rest/... (only for this site's cloud id)
 * Returns undefined for anything Forge cannot reach for this site (other hosts, Automation, Forms).
 */
export function productPath(url: string, siteUrl: string, cloudId: string): string | undefined {
  let u: URL;
  try { u = new URL(url); } catch { return undefined; }
  if (u.protocol !== 'https:' || u.username || u.password || u.hash) return undefined;
  let path: string | undefined;
  if (`https://${u.hostname}` === siteUrl) path = u.pathname;
  else if (u.hostname === 'api.atlassian.com') {
    if (u.pathname.startsWith('/jsm/assets/workspace/')) path = u.pathname;
    else {
      const m = /^\/ex\/jira\/([^/]+)(\/.*)$/.exec(u.pathname);
      if (m && m[1] === cloudId) path = m[2];
    }
  }
  if (!path || path.split('/').some((s) => s === '..' || s === '.') || /%2e%2e|%2f/i.test(path)) return undefined;
  if (!ALLOWED.some((r) => r.test(path!))) return undefined;
  return `${path}${u.search}`;
}

/** HttpFetch for AtlassianClient that sends requests through Forge, with the platform's auth (no credentials here). */
export function forgeFetch(request: ProductRequest, siteUrl: string, cloudId: string): HttpFetch {
  return async (url, init) => {
    const path = productPath(url, siteUrl, cloudId);
    if (!path) throw new Error(`not reachable from the workbench: ${url.replace(/\?.*$/, '')} (only this site's REST and Assets APIs)`);
    const { Authorization: _drop, ...headers } = init.headers;
    return request(path, { method: init.method, headers, ...(init.body !== undefined ? { body: init.body } : {}) });
  };
}

/** AtlassianClient for this site inside Forge: auth comes from the platform; the cloud id from the install context. */
export class ForgeSiteClient extends AtlassianClient {
  constructor(private readonly ctx: { siteUrl: string; cloudId: string; request: ProductRequest; readOnly: boolean; sleep?: (ms: number) => Promise<void> }) {
    super({
      site: ctx.siteUrl, readOnly: ctx.readOnly,
      auth: { header: async () => '', description: 'Forge' },
      fetch: forgeFetch(ctx.request, normaliseSite(ctx.siteUrl), ctx.cloudId),
      maxRetries: 3,
      ...(ctx.sleep ? { sleep: ctx.sleep } : {}),
    });
  }

  /** Refuse unreachable URLs at once (not as a lost response, which the client would retry with backoff). */
  override async raw(method: string, url: string, body?: unknown, extraHeaders?: Record<string, string>): Promise<RawResult> {
    if (!productPath(url, normaliseSite(this.ctx.siteUrl), this.ctx.cloudId)) {
      const path = url.replace(/^https:\/\/[^/]+/, '').replace(/\?.*$/, '');
      throw new UnreachableError(method, path, "from the workbench only this site's REST and Assets APIs are reachable");
    }
    return super.raw(method, url, body, extraHeaders);
  }

  override async cloudId(): Promise<string> {
    return this.ctx.cloudId;
  }
}

/** Cloud id from a Forge install context ARI (ari:cloud:jira::site/<cloudId>). */
export function cloudIdOf(installContext: unknown): string {
  const m = typeof installContext === 'string' ? /^ari:cloud:[a-z-]+::site\/([0-9a-f-]{36})$/i.exec(installContext) : null;
  if (!m) throw new Error('missing or unexpected install context');
  return m[1]!;
}
