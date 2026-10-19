import api, { assumeTrustedRoute, fetch as forgeFetch, route } from '@forge/api';
import { kvs, WhereConditions } from '@forge/kvs';
import { Queue } from '@forge/events';
import { normaliseSite } from '@snjsm/atlassian';
import type { HttpFetch } from '@snjsm/collector';
import type { Kv } from './kv-store';
import { cloudIdOf, ForgeSiteClient, type ProductRequest } from './transport';
import type { Actor, Caller, JobMessage, Platform } from './workbench';

/** Forge KVS behind the narrow Kv interface. */
export const forgeKv: Kv = {
  get: <T>(key: string) => kvs.get<T>(key),
  async getMany<T>(keys: string[]) {
    const out = new Map<string, T>();
    for (let i = 0; i < keys.length; i += 20) {
      const r = await kvs.batchGet<T>(keys.slice(i, i + 20).map((key) => ({ key })));
      for (const x of r.successfulKeys) out.set(x.key, x.value);
    }
    return out;
  },
  set: (key, value, o) => kvs.set(key, value, o?.ttlSeconds ? { ttl: { value: o.ttlSeconds, unit: 'SECONDS' } } : undefined),
  async setIfAbsent(key, value, o) {
    try {
      await kvs.set(key, value, { keyPolicy: 'FAIL_IF_EXISTS', ...(o?.ttlSeconds ? { ttl: { value: o.ttlSeconds, unit: 'SECONDS' as const } } : {}) });
      return true;
    } catch (e) {
      if ((await kvs.get(key)) !== undefined) return false;
      throw e;
    }
  },
  delete: (key) => kvs.delete(key),
  async deleteMany(keys) {
    for (let i = 0; i < keys.length; i += 20) await kvs.batchDelete(keys.slice(i, i + 20).map((key) => ({ key })));
  },
  async keys(prefix) {
    const out: string[] = [];
    let cursor: string | undefined;
    do {
      let q = kvs.query().where('key', WhereConditions.beginsWith(prefix)).limit(100);
      if (cursor) q = q.cursor(cursor);
      const page = await q.getMany();
      out.push(...page.results.map((r) => r.key));
      cursor = page.nextCursor;
    } while (cursor);
    return out.sort();
  },
  getSecret: <T>(key: string) => kvs.getSecret<T>(key),
  setSecret: (key, value) => kvs.setSecret(key, value),
  deleteSecret: (key) => kvs.deleteSecret(key),
};

/** Egress to ServiceNow (allowed hosts are fixed in the manifest; the collector also validates the instance URL). */
const snFetch: HttpFetch = async (url, init) => {
  const res = await forgeFetch(url, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: 'manual' });
  return { status: res.status, headers: { get: (n: string) => res.headers.get(n) }, text: () => res.text() };
};

/** requestJira as the actor, on a path the transport already validated. */
export function productRequest(actor: Actor): ProductRequest {
  const methods = actor.as === 'app' ? api.asApp() : api.asUser(actor.accountId);
  return async (path, init) => {
    const res = await methods.requestJira(assumeTrustedRoute(path), init);
    return { status: res.status, headers: { get: (n: string) => res.headers.get(n) }, text: () => res.text() };
  };
}

const jobs = new Queue({ key: 'workbench-jobs' });

/** The site this installation belongs to: cloud id from the install context, URL from serverInfo (cached). */
export async function siteOf(installContext: unknown): Promise<Omit<Caller, 'accountId'>> {
  const cloudId = cloudIdOf(installContext);
  const cached = await kvs.get<{ cloudId: string; siteUrl: string }>('site');
  if (cached?.cloudId === cloudId) return cached;
  const res = await api.asApp().requestJira(route`/rest/api/3/serverInfo`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`could not read the site address (serverInfo ${res.status})`);
  const siteUrl = normaliseSite(((await res.json()) as { baseUrl: string }).baseUrl);
  await kvs.set('site', { cloudId, siteUrl });
  return { cloudId, siteUrl };
}

export function platformFor(site: Omit<Caller, 'accountId'>, userActor?: Actor): Platform {
  return {
    kv: forgeKv,
    snFetch,
    client: (actor, readOnly) => new ForgeSiteClient({ siteUrl: site.siteUrl, cloudId: site.cloudId, request: productRequest(actor), readOnly }),
    async isAdmin() {
      if (!userActor || userActor.as !== 'user') return false;
      // A rate limit or server error is not a "no": retry, then fail loudly rather than deny an administrator.
      let res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, { headers: { Accept: 'application/json' } });
      for (let attempt = 1; attempt <= 3 && (res.status === 429 || res.status >= 500); attempt++) {
        const wait = Math.min(Number(res.headers.get('retry-after')) * 1000 || 500 * 2 ** attempt, 4000);
        await new Promise((r) => setTimeout(r, wait));
        res = await api.asUser().requestJira(route`/rest/api/3/mypermissions?permissions=ADMINISTER`, { headers: { Accept: 'application/json' } });
      }
      if (res.status === 429 || res.status >= 500) throw new Error(`could not check your Jira permissions (HTTP ${res.status}); try again`);
      if (!res.ok) return false;
      const j = (await res.json()) as { permissions?: { ADMINISTER?: { havePermission?: boolean } } };
      return j.permissions?.ADMINISTER?.havePermission === true;
    },
    async enqueue(msg: JobMessage, concurrencyKey: string, delaySeconds?: number) {
      await jobs.push({ body: msg, concurrency: { key: concurrencyKey, limit: 1 }, ...(delaySeconds ? { delayInSeconds: Math.min(900, delaySeconds) } : {}) });
    },
  };
}
