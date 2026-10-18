import { HttpFetch, ServiceNowError } from './http';

export interface TokenProvider {
  /** Returns a bearer token. `forceRefresh` discards any cached token (used after a 401). */
  getToken(forceRefresh?: boolean): Promise<string>;
  readonly description: string;
}

/** Explains the common OAuth failures, with the ServiceNow-side fix. */
export function explainOAuthError(error?: string, description?: string, grant: 'client_credentials' | 'password' = 'client_credentials'): string {
  const d = `${error ?? ''} ${description ?? ''}`.toLowerCase();
  if (grant === 'password' && (d.includes('access_denied') || d.includes('invalid_grant'))) {
    return 'ServiceNow refused the integration user (access_denied / invalid_grant). Check the user name and password, that the user is active, ' +
      'not locked out and has web service access, and that the OAuth API endpoint (application registry) is active.';
  }
  if (d.includes('access_denied')) {
    return 'ServiceNow refused the client credentials grant (access_denied). Check: (1) system property ' +
      'glide.oauth.inbound.client.credential.grant_type.enabled = true; (2) the integration has an OAuth application user ' +
      'set; (3) that user is active and not locked out; (4) the integration is active.';
  }
  if (d.includes('invalid_client')) return 'ServiceNow did not recognise the client ID/secret (invalid_client). Re-copy them from the integration record.';
  if (d.includes('unsupported_grant_type')) return 'This instance does not allow this grant (unsupported_grant_type). For client credentials set glide.oauth.inbound.client.credential.grant_type.enabled = true, or use the password grant with an integration user.';
  if (d.includes('invalid_grant')) return 'ServiceNow refused the user name or password, or the refresh token expired (invalid_grant). Check the integration user (active, not locked out, web service access) and its password.';
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

/** POST a token request to /oauth_token.do and return the parsed token response, with actionable errors. */
async function requestToken(instanceUrl: string, form: Record<string, string>, http: HttpFetch, grant: 'client_credentials' | 'password' = 'password'): Promise<{ access_token: string; expires_in?: number; refresh_token?: string }> {
  const res = await http(`${instanceUrl}/oauth_token.do`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const raw = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ServiceNowError(`Token endpoint returned non-JSON (HTTP ${res.status}). Is the instance awake?`, res.status);
  }
  if (res.status !== 200 || typeof json.access_token !== 'string' || !json.access_token) {
    throw new ServiceNowError(explainOAuthError(json.error as string, json.error_description as string, grant), res.status, json.error as string);
  }
  return json as { access_token: string; expires_in?: number; refresh_token?: string };
}

/**
 * OAuth 2.0 resource-owner password grant: the OAuth API endpoint's client id/secret plus an integration user.
 * Uses the refresh token when it has one, and falls back to the password when the refresh token is refused.
 */
export class PasswordGrantProvider implements TokenProvider {
  private token?: string;
  private refresh?: string;
  private expiresAt = 0;
  readonly description: string;

  constructor(
    private readonly instanceUrl: string,
    private readonly creds: { clientId: string; clientSecret: string; username: string; password: string },
    private readonly http: HttpFetch,
    private readonly now: () => number = Date.now,
  ) {
    this.description = `OAuth password grant (${creds.username}, client ${creds.clientId.slice(0, 4)}…)`;
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.now() < this.expiresAt) return this.token;
    const client = { client_id: this.creds.clientId, client_secret: this.creds.clientSecret };
    let r: Awaited<ReturnType<typeof requestToken>> | undefined;
    if (this.refresh) {
      r = await requestToken(this.instanceUrl, { grant_type: 'refresh_token', refresh_token: this.refresh, ...client }, this.http).catch(() => undefined);
    }
    r ??= await requestToken(this.instanceUrl, { grant_type: 'password', username: this.creds.username, password: this.creds.password, ...client }, this.http);
    this.token = r.access_token;
    if (r.refresh_token) this.refresh = r.refresh_token;
    this.expiresAt = this.now() + Math.max(30, Number(r.expires_in ?? 1800) - 60) * 1000;
    return this.token;
  }
}
