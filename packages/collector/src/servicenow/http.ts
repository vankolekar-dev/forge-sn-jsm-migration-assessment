/**
 * Minimal fetch contract, compatible with Node's global fetch and @forge/api fetch, so the same client runs in a
 * CLI, a container or a Forge function.
 */
export interface HttpResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}
export type HttpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

export const nodeFetch: HttpFetch = (url, init) => fetch(url, init) as unknown as Promise<HttpResponse>;

export class ServiceNowError extends Error {
  constructor(message: string, readonly status?: number, readonly code?: string) {
    super(message);
    this.name = 'ServiceNowError';
  }
}

/** One ServiceNow HTTP exchange, as recorded for diagnostics: never headers or request bodies (they carry credentials). */
export interface RequestLogEntry {
  at: string; method: string; path: string; status?: number; ms: number;
  /** Start of the response body for non-2xx responses, with any tokens redacted. */
  detail?: string;
  /** Network or runtime error, when there was no response. */
  error?: string;
}

const TOKENS = /("(?:access_token|refresh_token|id_token|client_secret|password)"\s*:\s*)"[^"]*"/gi;

/** Wraps a fetch so every exchange is reported to `record`; error bodies are read once and replayed to the caller. */
export function loggingFetch(http: HttpFetch, record: (e: RequestLogEntry) => void, now: () => number = Date.now): HttpFetch {
  return async (url, init) => {
    const started = now();
    const u = new URL(url);
    const base = { at: new Date(started).toISOString(), method: init.method, path: `${u.pathname}${u.search}`.slice(0, 400) };
    let res: HttpResponse;
    try {
      res = await http(url, init);
    } catch (e) {
      record({ ...base, ms: now() - started, error: (e as Error).message ?? String(e) });
      throw e;
    }
    if (res.status >= 200 && res.status < 300) {
      record({ ...base, status: res.status, ms: now() - started });
      return res;
    }
    const text = await res.text();
    record({ ...base, status: res.status, ms: now() - started, detail: text.replace(TOKENS, '$1"***"').replace(/\s+/g, ' ').slice(0, 300) });
    return { status: res.status, headers: res.headers, text: async () => text };
  };
}
