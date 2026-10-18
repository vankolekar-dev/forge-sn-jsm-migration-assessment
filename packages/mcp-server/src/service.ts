import { resolve } from 'node:path';
import { normaliseSite } from '@snjsm/atlassian';
import type { ServiceConfig } from '@snjsm/workflow';
import { FsStore } from './fs-store';

export {
  BuildService, cleanupPhrase, confirmPhrase, signOffPhrase, testPhrase,
  type BlueprintInput, type ScopeInput, type ServiceConfig,
} from '@snjsm/workflow';
export { FsStore } from './fs-store';

/** Service configuration for the MCP server and CLI: files under a work directory. */
export interface FsServiceConfig extends ServiceConfig {
  store: FsStore;
  /** Absolute work directory (blueprints, plans, state). */
  workdir: string;
}

export function configFromEnv(env: NodeJS.ProcessEnv, clientFor: ServiceConfig['clientFor'], cwd = process.cwd()): FsServiceConfig {
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(normaliseSite);
  const workdir = resolve(cwd, env.SNJSM_WORKDIR || 'out');
  return {
    workdir,
    store: new FsStore(workdir),
    ...(env.SNJSM_SITE ? { defaultSite: normaliseSite(env.SNJSM_SITE) } : {}),
    writeSites: list(env.SNJSM_WRITE_SITES),
    writeSitesHint: 'SNJSM_WRITE_SITES',
    allowUnsigned: env.SNJSM_ALLOW_UNSIGNED === '1',
    by: env.SNJSM_BY || env.USER || 'unknown',
    ...(env.SNJSM_LEAD_ACCOUNT_ID ? { options: { leadAccountId: env.SNJSM_LEAD_ACCOUNT_ID } } : {}),
    clientFor,
  };
}
