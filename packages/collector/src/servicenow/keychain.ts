import { execFileSync } from 'node:child_process';
import { instanceHost } from './instance';

/**
 * Node-only: load OAuth client credentials for an instance. Order:
 *  1. env SN_CLIENT_ID / SN_CLIENT_SECRET (CI, containers)
 *  2. macOS Keychain items "sn-<instance>-client-id" / "sn-<instance>-client-secret", where <instance> is the
 *     first label of the host (dev317128.service-now.com → sn-dev317128-…)
 * Secrets are returned in memory only. They are never logged or written to disk.
 */
export function loadClientCredentials(instanceUrl: string, env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string; source: string } {
  if (env.SN_CLIENT_ID && env.SN_CLIENT_SECRET) return { clientId: env.SN_CLIENT_ID, clientSecret: env.SN_CLIENT_SECRET, source: 'environment' };
  const name = instanceHost(instanceUrl).split('.')[0];
  if (process.platform !== 'darwin') throw new Error('Set SN_CLIENT_ID and SN_CLIENT_SECRET (Keychain lookup is macOS only).');
  const read = (service: string) => {
    try {
      return execFileSync('security', ['find-generic-password', '-s', service, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      throw new Error(`Keychain item "${service}" not found. Store it with: security add-generic-password -U -a atl_discovery -s ${service} -T /usr/bin/security -w`);
    }
  };
  return { clientId: read(`sn-${name}-client-id`), clientSecret: read(`sn-${name}-client-secret`), source: 'macOS Keychain' };
}
