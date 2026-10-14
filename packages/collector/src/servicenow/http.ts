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
