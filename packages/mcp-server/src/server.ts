#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AtlassianClient } from '@snjsm/atlassian';
import { loadPersonaAuth, loadSiteAuth } from '@snjsm/atlassian/node';
import { BuildService, configFromEnv } from './service';
import { registerTools } from './tools';

/**
 * stdio MCP server for Rovo CLI.
 *   SNJSM_WORKDIR        work directory (default ./out)
 *   SNJSM_SITE           default site
 *   SNJSM_WRITE_SITES    comma-separated sites apply may write to (empty = apply disabled)
 *   SNJSM_ALLOW_UNSIGNED 1 = allow apply before blueprint sign-off (sandbox only)
 *   SNJSM_BY             name recorded in the state file (default $USER)
 * Credentials: ATL_EMAIL / ATL_API_TOKEN, or Keychain atl-<site>-email / atl-<site>-api-token.
 * Test personas (optional): ATL_PERSONA_<NAME>_EMAIL / _API_TOKEN, or Keychain atl-<site>-persona-<name>-email / -api-token.
 */
export function createServer(svc: BuildService): McpServer {
  const server = new McpServer({ name: 'snjsm-builder', version: '0.1.0' });
  registerTools(server, svc);
  return server;
}

async function main() {
  const auth = new Map<string, ReturnType<typeof loadSiteAuth>['auth']>();
  const cfg = configFromEnv(process.env, (site, readOnly) => {
    if (!auth.has(site)) auth.set(site, loadSiteAuth(site).auth);
    return new AtlassianClient({ site, auth: auth.get(site)!, readOnly });
  });
  const personas = new Map<string, AtlassianClient | undefined>();
  cfg.personaClientFor = (site, persona) => {
    const k = `${site} ${persona}`;
    if (!personas.has(k)) {
      const a = loadPersonaAuth(site, persona);
      personas.set(k, a ? new AtlassianClient({ site, auth: a.auth, readOnly: false }) : undefined);
    }
    return personas.get(k);
  };
  const svc = new BuildService(cfg);
  await createServer(svc).connect(new StdioServerTransport());
  // stdout is the protocol channel: log to stderr only.
  console.error(`snjsm-builder MCP ready (workdir ${svc.cfg.workdir}; apply ${svc.cfg.writeSites.length ? `allowed on ${svc.cfg.writeSites.join(', ')}` : 'disabled'})`);
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
