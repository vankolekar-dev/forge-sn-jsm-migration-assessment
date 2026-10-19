import { HttpFetch, ServiceNowError } from './http';

export interface TokenProvider {
  /** Returns a bearer token. `forceRefresh` discards any cached token (used after a 401). */
  getToken(forceRefresh?: boolean): Promise<string>;
  readonly description: string;
  /** Authorization scheme for the value getToken returns; Bearer unless stated. */
  readonly scheme?: 'Bearer' | 'Basic';
}

/**
 * HTTP basic authentication as a ServiceNow user: for demos and developer instances. Production connections should
 * use OAuth, so no password is sent on every request.
 */
export class BasicAuthProvider implements TokenProvider {
  readonly scheme = 'Basic' as const;
  readonly description: string;
  private readonly value: string;
  constructor(username: string, password: string) {
    this.description = `Basic auth (${username})`;
    this.value = Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
  }
  async getToken(): Promise<string> {
    return this.value;
  }
}

/** Explains the common OAuth failures, with the ServiceNow-side fix. */
export function explainOAuthError(error?: string, description?: string, grant: 'client_credentials' | 'password' = 'client_credentials'): string {
  const d = `${error ?? ''} ${description ?? ''}`.toLowerCase();
  const name = grant === 'password' ? 'password' : 'client credentials';
  const logs = " If it persists, ServiceNow's System Logs → All (message contains \"oauth\") name the cause, e.g. a crypto module (KMF) access denial: regenerate the client secret or recreate the integration under System Web Services → Inbound Integrations.";
  let hint: string;
  if (d.includes('disabled_grant_type') || d.includes('unsupported_grant_type')) {
    hint = grant === 'password'
      ? 'This instance has the password grant switched off: set glide.oauth.inbound.ropc.grant_type.disabled = false, or use client credentials.'
      : 'This instance does not allow client credentials: set glide.oauth.inbound.client.credential.grant_type.enabled = true (true|false, global), or use the password grant.';
  } else if (d.includes('invalid_client')) {
    hint = 'ServiceNow did not recognise the client id or secret. Re-copy them from the integration record (no trailing spaces).';
  } else if (d.includes('access_denied') || d.includes('invalid_grant')) {
    hint = grant === 'password'
      ? 'ServiceNow refused the password grant. Check that the integration allows the password grant (an integration created as "OAuth – Client credentials grant" does not: choose client credentials here instead), the user name and password, and that the user is active, not locked out and has web service access.'
      : 'ServiceNow refused the client credentials grant. Check that the integration allows client credentials (its default grant type), has an OAuth application user that is active and not locked out, that the integration is active, and that glide.oauth.inbound.client.credential.grant_type.enabled = true.';
  } else if (d.includes('invalid_scope')) {
    hint = 'ServiceNow rejected the token scope. Check the integration\'s auth scopes allow the Table API (useraccount).';
  } else {
    hint = `ServiceNow refused the ${name} grant.`;
  }
  const said = [error, description && description !== error ? description : undefined].filter(Boolean).join(': ');
  return `${hint}${said ? ` ServiceNow said: ${said}.` : ''}${logs}`;
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
    /** Only when the integration restricts its auth scopes (e.g. `useraccount`); most instances need none. */
    private readonly scope?: string,
  ) {
    this.description = `OAuth client credentials (${clientId.slice(0, 4)}…)`;
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.now() < this.expiresAt) return this.token;
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.clientId, client_secret: this.clientSecret, ...(this.scope ? { scope: this.scope } : {}) }).toString();
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
      throw new ServiceNowError(explainOAuthError(json.error as string, json.error_description as string, 'client_credentials'), res.status, json.error as string);
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
    private readonly creds: { clientId: string; clientSecret: string; username: string; password: string; scope?: string },
    private readonly http: HttpFetch,
    private readonly now: () => number = Date.now,
  ) {
    this.description = `OAuth password grant (${creds.username}, client ${creds.clientId.slice(0, 4)}…)`;
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh && this.token && this.now() < this.expiresAt) return this.token;
    const client = { client_id: this.creds.clientId, client_secret: this.creds.clientSecret, ...(this.creds.scope ? { scope: this.creds.scope } : {}) };
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
