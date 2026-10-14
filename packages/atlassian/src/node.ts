import { execFileSync } from 'node:child_process';
import { ApiTokenAuth } from './client';

/**
 * Load site credentials. Order: env ATL_EMAIL / ATL_API_TOKEN, then macOS Keychain items
 * "atl-<site>-email" / "atl-<site>-api-token" (site = first label of <site>.atlassian.net).
 */
export function loadSiteAuth(siteUrl: string, env: NodeJS.ProcessEnv = process.env): { auth: ApiTokenAuth; source: string } {
  if (env.ATL_EMAIL && env.ATL_API_TOKEN) return { auth: new ApiTokenAuth(env.ATL_EMAIL, env.ATL_API_TOKEN), source: 'environment' };
  const name = new URL(siteUrl).hostname.split('.')[0];
  const read = (service: string) => {
    try {
      return execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      throw new Error(`Keychain item "${service}" not found. Store it with: security add-generic-password -U -a atl_build -s ${service} -T /usr/bin/security -w`);
    }
  };
  return { auth: new ApiTokenAuth(read(`atl-${name}-email`), read(`atl-${name}-api-token`)), source: 'macOS Keychain' };
}
