import { HttpFetch, ServiceNowError } from './http';

export interface TokenProvider {
  /** Returns a bearer token. `forceRefresh` discards any cached token (used after a 401). */
  getToken(forceRefresh?: boolean): Promise<string>;
  readonly description: string;
}

/** Explains the common OAuth failures, with the ServiceNow-side fix. */
export function explainOAuthError(error?: string, description?: string): string {
  const d = `${error ?? ''} ${description ?? ''}`.toLowerCase();
  if (d.includes('access_denied')) {
    return 'ServiceNow refused the client credentials grant (access_denied). Check: (1) system property ' +
      'glide.oauth.inbound.client.credential.grant_type.enabled = true; (2) the integration has an OAuth application user ' +
      'set; (3) that user is active and not locked out; (4) the integration is active.';
  }
  if (d.includes('invalid_client')) return 'ServiceNow did not recognise the client ID/secret (invalid_client). Re-copy them from the integration record.';
  if (d.includes('unsupported_grant_type')) return 'This instance does not allow the client credentials grant (unsupported_grant_type). Enable it or use the authorization code flow.';
  return `ServiceNow OAuth error: ${error ?? 'unknown'}${description ? ` (${description})` : ''}`;
}

/** OAuth 2.0 client credentials grant against /oauth_token.do, with in-memory caching until shortly before expiry. */
export class ClientCredentialsProvider implements TokenProvider {
  private token?: string;
  private expiresAt = 0;
  readonly description: string;

  constructor(
    private readonly instanceUrl: string,
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly http: HttpFetch,
    private readonly now: () => number = Date.now,
  ) {
    this.description = `OAuth client credentials (${clientId.slice(0, 4)}…)`;
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.now() < this.expiresAt) return this.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret }).toString();
    const res = await this.http(`${this.instanceUrl}/oauth_token.do`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body,
    });
    const raw = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new ServiceNowError(`Token endpoint returned non-JSON (HTTP ${res.status}). Is the instance awake?`, res.status);
    }
    const token = json.access_token;
    if (res.status !== 200 || typeof token !== 'string' || !token) {
      throw new ServiceNowError(explainOAuthError(json.error as string, json.error_description as string), res.status, json.error as string);
    }
    const ttl = Number(json.expires_in ?? 1800);
    this.token = token;
    this.expiresAt = this.now() + Math.max(30, ttl - 60) * 1000;
    return token;
  }
}

/** Pre-issued bearer token, e.g. from the Forge authorization-code flow. */
export class StaticTokenProvider implements TokenProvider {
  readonly description = 'Bearer token';
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
}
