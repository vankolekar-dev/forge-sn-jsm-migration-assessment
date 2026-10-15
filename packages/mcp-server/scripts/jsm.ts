/**
 * Build CLI over the same service (and gates) as the MCP server.
 *
 *   npm run jsm -- summary   --blueprint fixture/blueprint.json
 *   npm run jsm -- plan      --blueprint fixture/blueprint.json [--cap c] [--el id]     offline, from the state file
 *   npm run jsm -- dry-run   --blueprint fixture/blueprint.json --site x.atlassian.net  read-only against the site
 *   npm run jsm -- apply     --blueprint … --site … --hash <planHash> [--confirm "APPLY <hash> TO <site>"]
 *   npm run jsm -- manual    --blueprint … [--site …]
 *   npm run jsm -- confirm   --blueprint … --site … --id <designId> [--remote-id 123] [--remote-key K] [--note …]
 *   npm run jsm -- verify    --blueprint … --site …
 *   npm run jsm -- status    --blueprint … --site …
 *   npm run jsm -- breakdown --blueprint … [--site …]
 *
 * Paths are relative to SNJSM_WORKDIR (default ./out). apply needs the site in SNJSM_WRITE_SITES; without
 * --confirm it asks you to type the phrase. Add --json for machine output.
 */
import { createInterface } from 'node:readline/promises';
import { AtlassianClient } from '@snjsm/atlassian';
import { loadSiteAuth } from '@snjsm/atlassian/node';
import { BuildService, configFromEnv, confirmPhrase, type BlueprintInput } from '@snjsm/mcp-server';

function args(argv: string[]) {
  const [cmd, ...rest] = argv;
  const flags: Record<string, string[]> = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) (flags[key] ??= []).push('true');
    else { (flags[key] ??= []).push(next); i++; }
  }
  const one = (k: string) => flags[k]?.at(-1);
  return { cmd, one, many: (k: string) => flags[k] ?? [], has: (k: string) => Boolean(flags[k]) };
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.cmd || a.has('help')) { console.log(readHelp()); return; }
  const svc = new BuildService(configFromEnv(process.env, (site, readOnly) => new AtlassianClient({ site, auth: loadSiteAuth(site).auth, readOnly })));
  const blueprint = a.one('blueprint');
  if (!blueprint) throw new Error('--blueprint <path> is required');
  const site = a.one('site');
  const base: BlueprintInput = { blueprint, ...(site ? { site } : {}), capabilityIds: a.many('cap'), elementIds: a.many('el') };

  let out: unknown;
  switch (a.cmd) {
    case 'summary': out = svc.summary(base); break;
    case 'space': {
      const mode = a.one('mode');
      if (mode !== 'new' && mode !== 'existing') throw new Error('--mode new|existing is required');
      const opt = (k: string) => a.one(k);
      out = svc.setSpace({ blueprint, mode, ...(opt('id') ? { designId: opt('id')! } : {}), ...(opt('key') ? { key: opt('key')! } : {}), ...(opt('name') ? { name: opt('name')! } : {}), ...(opt('reason') ? { reason: opt('reason')! } : {}) });
      break;
    }
    case 'plan': out = await svc.plan(base); break;
    case 'dry-run': out = await svc.plan({ ...base, dryRun: true }); break;
    case 'apply': {
      const planHash = a.one('hash');
      if (!planHash) throw new Error('--hash <planHash> from a dry-run is required');
      let confirm = a.one('confirm');
      if (!confirm) {
        const target = svc.siteFor(svc.loadBlueprint(blueprint), site);
        if (!target || !process.stdin.isTTY) throw new Error('--confirm "APPLY <planHash> TO <site>" is required');
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        confirm = await rl.question(`Review the dry-run, then type exactly:\n  ${confirmPhrase(planHash, target)}\n> `);
        rl.close();
      }
      out = await svc.apply({ ...base, planHash, confirm });
      break;
    }
    case 'manual': out = await svc.manualSteps(base); break;
    case 'confirm': {
      const designId = a.one('id');
      if (!designId) throw new Error('--id <designId> is required');
      const opt = (k: string) => a.one(k);
      out = await svc.confirmManual({ blueprint, ...(site ? { site } : {}), designId, ...(opt('remote-id') ? { remoteId: opt('remote-id')! } : {}), ...(opt('remote-key') ? { remoteKey: opt('remote-key')! } : {}), ...(opt('note') ? { note: opt('note')! } : {}) });
      break;
    }
    case 'verify': out = await svc.verify(base); break;
    case 'status': out = svc.status(base); break;
    case 'breakdown': out = await svc.workBreakdown(base); break;
    default: throw new Error(`unknown command ${a.cmd}\n\n${readHelp()}`);
  }
  const { markdown, ...rest } = (out ?? {}) as { markdown?: string };
  if (a.has('json')) console.log(JSON.stringify(out, null, 2));
  else { if (markdown) console.log(markdown); console.error(JSON.stringify(rest, null, 2)); }
}

function readHelp() {
  return 'usage: npm run jsm -- <summary|plan|dry-run|apply|manual|confirm|verify|status|breakdown> --blueprint <path> [--site <site>] [--cap <id>] [--el <id>] [--json]';
}

main().catch((e) => { console.error(`error: ${(e as Error).message}`); process.exit(1); });
