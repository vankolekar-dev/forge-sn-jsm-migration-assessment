/**
 * Capture what Atlassian templates really create on a site and compare with the reference library. READ-ONLY.
 *
 *   npm run ref:capture -- --site vish-se-demo --project REFITSM --schema "Reference ITAM"
 *   npm run ref:capture -- ... --update     # write verified facts back into packages/reference/src/data/atlassian/*.json
 *
 * Options: --jsm-template (default atl.jsm.template.itsm), --assets-template (default atl.assets.template.itam).
 * Reports go to out/ (gitignored). Credentials: env ATL_EMAIL/ATL_API_TOKEN or Keychain atl-<site>-email / -api-token.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AtlassianClient, normaliseSite } from '@snjsm/atlassian';
import { loadSiteAuth } from '@snjsm/atlassian/node';
import { ReferenceFile, referenceArtifacts } from '@snjsm/reference';
import { applyReport, captureSite, compareCapture, parseArgs, renderReport, str } from '../src';

const ROOT = resolve(__dirname, '../../..');
const DATA = join(ROOT, 'packages/reference/src/data/atlassian');

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const siteArg = str(flags.site);
  if (!siteArg) throw new Error('usage: npm run ref:capture -- --site <name> --project <KEY> --schema "<Assets schema name>" [--update]');
  const site = normaliseSite(siteArg.includes('.') ? siteArg : `${siteArg}.atlassian.net`);
  const projectKey = str(flags.project);
  const schemaName = str(flags.schema);
  if (!projectKey && !schemaName) throw new Error('give --project and/or --schema');

  const { auth, source } = loadSiteAuth(site);
  const client = new AtlassianClient({ site, auth, readOnly: true });
  console.log(`site: ${site}\ncredentials: ${source} (${auth.description})\nmode: read-only`);

  const cap = await captureSite(client, { projectKey, schemaName });
  const report = compareCapture(cap, referenceArtifacts(), {
    jsmTemplate: projectKey ? str(flags['jsm-template'], 'atl.jsm.template.itsm') : undefined,
    assetsTemplate: schemaName ? str(flags['assets-template'], 'atl.assets.template.itam') : undefined,
  });

  const out = join(ROOT, 'out');
  mkdirSync(out, { recursive: true });
  const stamp = cap.capturedAt.replace(/[:.]/g, '-');
  writeFileSync(join(out, `capture-${stamp}.json`), JSON.stringify(cap, null, 2));
  writeFileSync(join(out, `compare-${stamp}.json`), JSON.stringify(report, null, 2));
  const md = renderReport(report, cap.unavailable);
  writeFileSync(join(out, `compare-${stamp}.md`), md);
  console.log(`\n${md}\nrequests: ${client.requestCount}\nreports: out/capture-${stamp}.json, out/compare-${stamp}.{json,md}`);

  if (flags.update) {
    const today = cap.capturedAt.slice(0, 10);
    let total = 0;
    for (const f of readdirSync(DATA).filter((x) => x.endsWith('.json'))) {
      const path = join(DATA, f);
      const file = ReferenceFile.parse(JSON.parse(readFileSync(path, 'utf8')));
      const { file: next, changes } = applyReport(file, report, today);
      if (!changes.length) continue;
      writeFileSync(path, JSON.stringify(next, null, 2) + '\n');
      total += changes.length;
      console.log(`\nupdated ${f}:`);
      for (const c of changes) console.log(`  ${c.action.padEnd(26)} ${c.artifactId}  ${c.detail}`);
    }
    console.log(total ? `\n${total} artifact(s) updated. Review the git diff, run npm run validate:reference, and bump CATALOGUE_VERSION.` : '\nno artifacts changed');
  }
}

main().catch((e) => {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
});
