/**
 * API coverage spike for the "unknown" rows of the coverage matrix.
 *
 *   npm run api:spike -- --site vish-se-demo --project REFITSM                     # read probes only (safe)
 *   npm run api:spike -- --site vish-se-demo --project REFITSM --write --sandbox SPIKE   # + write probes
 *   --only automation,form      run a subset (probe id prefixes)       --list   show probes
 *
 * Write probes create throwaway "zz-spike-<tag>" items in the SANDBOX project (never the reference project)
 * and delete them afterwards. Anything that could not be deleted is listed as a leftover.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AtlassianClient, normaliseSite } from '@snjsm/atlassian';
import { loadSiteAuth } from '@snjsm/atlassian/node';
import { parseArgs, probeIds, renderSpike, runSpike, str } from '../src';

const ROOT = resolve(__dirname, '../../..');

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  if (flags.list) { console.log(probeIds().join('\n')); return; }
  const siteArg = str(flags.site);
  const projectKey = str(flags.project);
  if (!siteArg || !projectKey) throw new Error('usage: npm run api:spike -- --site <name> --project <KEY> [--write --sandbox <KEY>] [--only a,b]');
  const site = normaliseSite(siteArg.includes('.') ? siteArg : `${siteArg}.atlassian.net`);
  const write = flags.write === true;
  const { auth, source } = loadSiteAuth(site);
  const client = new AtlassianClient({ site, auth, readOnly: !write });
  const tag = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  console.log(`site: ${site}\ncredentials: ${source} (${auth.description})\nmode: ${write ? `WRITE (sandbox ${str(flags.sandbox)}, tag zz-spike-${tag})` : 'read-only'}`);

  const report = await runSpike({ client, projectKey, sandboxKey: str(flags.sandbox), write, tag }, str(flags.only)?.split(','));
  const out = join(ROOT, 'out');
  mkdirSync(out, { recursive: true });
  const stamp = report.ranAt.replace(/[:.]/g, '-');
  writeFileSync(join(out, `spike-${stamp}.json`), JSON.stringify(report, null, 2));
  const md = renderSpike(report);
  writeFileSync(join(out, `spike-${stamp}.md`), md);
  console.log(`\n${md}\nrequests: ${client.requestCount}\nreports: out/spike-${stamp}.{json,md}`);
  if (report.leftovers.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
