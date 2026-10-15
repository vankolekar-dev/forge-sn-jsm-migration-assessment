import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BuildService } from './service';

const blueprint = z.string().describe('Blueprint JSON path, relative to the work directory (e.g. "acme/blueprint.json")');
const site = z.string().optional().describe('Atlassian site, e.g. "acme-sandbox.atlassian.net" (default: SNJSM_SITE, then the blueprint target site)');
const scope = {
  capabilityIds: z.array(z.string()).optional().describe('Limit to these capabilities (dependencies are included)'),
  elementIds: z.array(z.string()).optional().describe('Limit to these design element ids (dependencies are included)'),
};

const ok = (v: unknown) => {
  const { markdown, ...rest } = (v ?? {}) as { markdown?: string };
  return { content: [{ type: 'text' as const, text: JSON.stringify(rest, null, 2) }, ...(markdown ? [{ type: 'text' as const, text: markdown }] : [])] };
};
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message ?? String(e) }] });
const run = <A>(fn: (a: A) => unknown | Promise<unknown>) => async (a: A) => {
  try { return ok(await fn(a)); } catch (e) { return fail(e); }
};

/** Register the build tools. Only build_apply writes to a site, and only behind the service's gates. */
export function registerTools(server: McpServer, svc: BuildService): void {
  const ro = { readOnlyHint: true, openWorldHint: true } as const;

  server.registerTool('blueprint_summary', {
    title: 'Blueprint summary',
    description: 'Summarise a Migration Blueprint: capabilities, outcomes, design elements by type and build strategy, sign-off, target site, and whether apply is allowed there.',
    inputSchema: { blueprint, site }, annotations: { readOnlyHint: true },
  }, run((a) => svc.summary(a)));

  server.registerTool('blueprint_set_space', {
    title: 'Choose the target space',
    description: 'Choose where a space in the design is built: mode "new" creates it from the template (optional name and key; a free key is chosen when omitted), mode "existing" builds into the space with that key. Edits the local blueprint file and records the decision; a previous sign-off then needs renewing. Only call when the person has chosen.',
    inputSchema: {
      blueprint, designId: z.string().optional().describe('Space design element id (needed when the blueprint has more than one space)'),
      mode: z.enum(['new', 'existing']), key: z.string().optional().describe('Space key, e.g. ITSD'), name: z.string().optional().describe('New space name'),
      reason: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, run((a) => svc.setSpace(a)));

  server.registerTool('build_plan', {
    title: 'Plan or dry-run the build',
    description: 'Plan the JSM build from the blueprint design. Offline (default) uses only the state file. With dryRun=true it reads the site with a read-only client to decide adopt / create / update / guided per element and returns the planHash a person must approve before build_apply. Writes the plan to plans/.',
    inputSchema: { blueprint, site, dryRun: z.boolean().optional().describe('Read the live site (read-only) to compute the real plan'), ...scope },
    annotations: ro,
  }, run((a) => svc.plan(a)));

  server.registerTool('build_apply', {
    title: 'Apply a reviewed dry-run',
    description: 'Build on the site exactly what a reviewed dry-run planned. Never call this on your own initiative: show the dry-run to the person, and only pass confirm when they have typed "APPLY <planHash> TO <site>" themselves. Refused unless the site is in SNJSM_WRITE_SITES, the blueprint is signed off (or unsigned builds are allowed for a sandbox), and a fresh dry-run still matches planHash. Additive only: never deletes.',
    inputSchema: {
      blueprint, site, planHash: z.string().describe('planHash from build_plan with dryRun=true'),
      confirm: z.string().describe('The exact phrase typed by the person: APPLY <planHash> TO <site>'), ...scope,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, run((a) => svc.apply(a)));

  server.registerTool('build_manual_steps', {
    title: 'Guided steps pending',
    description: 'List the guided (manual) steps still waiting for a person, in build order, with where to go, the exact values to enter and how to check them.',
    inputSchema: { blueprint, site, ...scope }, annotations: { readOnlyHint: true },
  }, run((a) => svc.manualSteps(a)));

  server.registerTool('build_confirm_manual', {
    title: 'Record a finished guided step',
    description: 'Record in the local state file that a person finished a guided step. Pass the site id of what they created when the step asks for it (other elements depend on it). Does not write to the site. Only call when the person says they did it.',
    inputSchema: {
      blueprint, site, designId: z.string(), remoteId: z.string().optional().describe('Site id of the created item'),
      remoteKey: z.string().optional(), note: z.string().optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  }, run((a) => svc.confirmManual(a)));

  server.registerTool('build_verify', {
    title: 'Verify the build',
    description: 'Read-only check that every built element is on the site and matches the design (ok, drift, missing, pending, unverifiable, not built).',
    inputSchema: { blueprint, site, ...scope }, annotations: ro,
  }, run((a) => svc.verify(a)));

  server.registerTool('build_status', {
    title: 'Build status',
    description: 'Show the state file for a blueprint on a site: what is built, failed or pending, and the last runs.',
    inputSchema: { blueprint, site }, annotations: { readOnlyHint: true },
  }, run((a) => svc.status(a)));

  server.registerTool('build_work_breakdown', {
    title: 'Jira work breakdown',
    description: 'One epic per capability with an automated-build story and one story per guided step, for Rovo to create in Jira (this tool does not create anything).',
    inputSchema: { blueprint, site, ...scope }, annotations: { readOnlyHint: true },
  }, run((a) => svc.workBreakdown(a)));
}
