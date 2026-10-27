/**
 * Build CLI over the same service (and gates) as the MCP server.
 *
 *   npm run jsm -- summary   --blueprint fixture/blueprint.json
 *   npm run jsm -- review    --blueprint fixture/blueprint.json                          offline sign-off review (signHash)
 *   npm run jsm -- sign-off  --blueprint … --hash <signHash> [--reject id] [--defer id] [--reinstate id] [--comment …] [--confirm "SIGN OFF <hash> FOR <blueprintId>"]
 *   npm run jsm -- plan      --blueprint fixture/blueprint.json [--cap c] [--el id]     offline, from the state file
 *   npm run jsm -- dry-run   --blueprint fixture/blueprint.json --site x.atlassian.net  read-only against the site
 *   npm run jsm -- apply     --blueprint … --site … --hash <planHash> [--confirm "APPLY <hash> TO <site>"]
 *   npm run jsm -- manual    --blueprint … [--site …]
 *   npm run jsm -- confirm   --blueprint … --site … --id <designId> [--remote-id 123] [--remote-key K] [--note …]
 *   npm run jsm -- verify    --blueprint … --site …
 *   npm run jsm -- status    --blueprint … --site …
 *   npm run jsm -- breakdown --blueprint … [--site …]
 *   npm run jsm -- build-list --blueprint … [--group automation] [--custom] [--inactive] [--per-group 25]   proposed JSM answer for everything else in ServiceNow (not reviewed)
 *   npm run jsm -- test-plan --blueprint … --site … [--outcome id]                    offline acceptance-test plan
 *   npm run jsm -- test      --blueprint … --site … --hash <runHash> [--keep] [--confirm "TEST <hash> ON <site>"]
 *   npm run jsm -- test-cleanup --blueprint … --site … --run <runId> [--confirm "CLEANUP <runId> ON <site>"]
 *
 * Paths are relative to SNJSM_WORKDIR (default ./out). apply, test and test-cleanup need the site in
 * SNJSM_WRITE_SITES; without --confirm they ask you to type the phrase. Add --json for machine output.
 * Test personas: ATL_PERSONA_<NAME>_EMAIL / _API_TOKEN or Keychain atl-<site>-persona-<name>-email / -api-token.
 */
import { createInterface } from 'node:readline/promises';
import { AtlassianClient } from '@snjsm/atlassian';
import { loadPersonaAuth, loadSiteAuth } from '@snjsm/atlassian/node';
import { buildList, buildListMarkdown } from '@snjsm/reference';
import { BuildService, cleanupPhrase, configFromEnv, confirmPhrase, signOffPhrase, testPhrase, type BlueprintInput } from '@snjsm/mcp-server';

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
  const cfg = configFromEnv(process.env, (site, readOnly) => new AtlassianClient({ site, auth: loadSiteAuth(site).auth, readOnly }));
  cfg.personaClientFor = (s, persona) => { const p = loadPersonaAuth(s, persona); return p ? new AtlassianClient({ site: s, auth: p.auth, readOnly: false }) : undefined; };
  const svc = new BuildService(cfg);
  /** The typed confirmation: from --confirm, or asked for on a terminal. */
  const typed = async (phrase: (target: string) => string, what: string) => {
    const given = a.one('confirm');
    if (given) return given;
    const target = svc.siteFor(await svc.loadBlueprint(blueprint!), site);
    if (!target || !process.stdin.isTTY) throw new Error(`--confirm "${phrase('<site>')}" is required`);
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = await rl.question(`Review the ${what}, then type exactly:\n  ${phrase(target)}\n> `);
    rl.close();
    return answer;
  };
  const blueprint = a.one('blueprint');
  if (!blueprint) throw new Error('--blueprint <path> is required');
  const site = a.one('site');
  const base: BlueprintInput = { blueprint, ...(site ? { site } : {}), capabilityIds: a.many('cap'), elementIds: a.many('el') };

  let out: unknown;
  switch (a.cmd) {
    case 'summary': out = await svc.summary(base); break;
    case 'space': {
      const mode = a.one('mode');
      if (mode !== 'new' && mode !== 'existing') throw new Error('--mode new|existing is required');
      const opt = (k: string) => a.one(k);
      out = await svc.setSpace({ blueprint, mode, ...(opt('id') ? { designId: opt('id')! } : {}), ...(opt('key') ? { key: opt('key')! } : {}), ...(opt('name') ? { name: opt('name')! } : {}), ...(opt('reason') ? { reason: opt('reason')! } : {}) });
      break;
    }
    case 'review': out = await svc.signOffReview({ blueprint }); break;
    case 'sign-off': {
      const signHash = a.one('hash');
      if (!signHash) throw new Error('--hash <signHash> from review is required');
      let confirm = a.one('confirm');
      if (!confirm) {
        const bp = await svc.loadBlueprint(blueprint);
        if (!process.stdin.isTTY) throw new Error('--confirm "SIGN OFF <signHash> FOR <blueprintId>" is required');
        const rl = createInterface({ input: process.stdin, output: process.stderr });
        confirm = await rl.question(`Review the outcomes, then type exactly:\n  ${signOffPhrase(signHash, bp.id)}\n> `);
        rl.close();
      }
      out = await svc.signOff({ blueprint, signHash, confirm, reject: a.many('reject'), defer: a.many('defer'), reinstate: a.many('reinstate'), ...(a.one('comment') ? { comment: a.one('comment')! } : {}) });
      break;
    }
    case 'plan': out = await svc.plan(base); break;
    case 'dry-run': out = await svc.plan({ ...base, dryRun: true }); break;
    case 'apply': {
      const planHash = a.one('hash');
      if (!planHash) throw new Error('--hash <planHash> from a dry-run is required');
      let confirm = a.one('confirm');
      if (!confirm) {
        const target = svc.siteFor(await svc.loadBlueprint(blueprint), site);
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
    case 'status': out = await svc.status(base); break;
    case 'breakdown': out = await svc.workBreakdown(base); break;
    case 'build-list': {
      const bp = await svc.loadBlueprint(blueprint);
      const per = Number(a.one('per-group') ?? 25);
      if (!Number.isInteger(per) || per < 0 || per > 500) throw new Error('--per-group must be a whole number from 0 to 500');
      const o = { ...(a.has('inactive') ? { includeInactive: true } : {}), ...(a.one('group') ? { group: a.one('group')! } : {}), ...(a.has('custom') ? { customOnly: true } : {}), perGroup: per };
      out = { ...buildList(bp, o), markdown: buildListMarkdown(bp, o) };
      break;
    }
    case 'test-plan': out = await svc.acceptancePlan({ blueprint, ...(site ? { site } : {}), outcomeIds: a.many('outcome') }); break;
    case 'test': {
      const runHash = a.one('hash');
      if (!runHash) throw new Error('--hash <runHash> from test-plan is required');
      const confirm = await typed((t) => testPhrase(runHash, t), 'test plan');
      out = await svc.acceptanceRun({ blueprint, ...(site ? { site } : {}), runHash, confirm, ...(a.has('keep') ? { keep: true } : {}) });
      break;
    }
    case 'test-cleanup': {
      const runId = a.one('run');
      if (!runId) throw new Error('--run <runId> is required');
      const confirm = await typed((t) => cleanupPhrase(runId, t), 'test-data ledger');
      out = await svc.acceptanceCleanup({ blueprint, ...(site ? { site } : {}), runId, confirm });
      break;
    }
    default: throw new Error(`unknown command ${a.cmd}\n\n${readHelp()}`);
  }
  const { markdown, ...rest } = (out ?? {}) as { markdown?: string };
  if (a.has('json')) console.log(JSON.stringify(out, null, 2));
  else { if (markdown) console.log(markdown); console.error(JSON.stringify(rest, null, 2)); }
}

function readHelp() {
  return 'usage: npm run jsm -- <summary|space|review|sign-off|plan|dry-run|apply|manual|confirm|verify|status|breakdown|build-list|test-plan|test|test-cleanup> --blueprint <path> [--site <site>] [--cap <id>] [--el <id>] [--json]';
}

main().catch((e) => { console.error(`error: ${(e as Error).message}`); process.exit(1); });
