/**
 * Assess a ServiceNow estate and produce a Migration Blueprint. READ-ONLY against ServiceNow.
 *
 *   npm run analyse -- --xml export1.xml --xml export2.xml --customer "Acme"
 *   npm run analyse -- --instance dev317128.service-now.com --customer "Acme" [--usage-days 365]
 *   npm run analyse -- --snapshot out/acme/snapshot.json --customer "Acme"
 *
 * Options:
 *   --out <dir>             output folder (default out/<customer-slug>)
 *   --name <text>           blueprint name
 *   --industry <text>
 *   --site <host>           target Atlassian site;  --edition free|standard|premium|enterprise
 *   --capability <id>       restrict to catalogue capability (repeatable);  --include <id> force in scope (repeatable)
 *   --set cap.param=value   parameter override (repeatable), e.g. --set itsm.request-hardware.costThreshold=1500
 *   --max-evidence <n>      cap evidence copied into the blueprint (referenced evidence is always kept)
 *
 * Writes snapshot.json, blueprint.json, assessment.json and assessment.md. --xml and --instance can be combined.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import {
  ClientCredentialsProvider, ServiceNowClient, collectLive, mergeSnapshots, nodeFetch, normaliseInstanceUrl, snapshotFromXml, type Snapshot,
} from '@snjsm/collector';
import { loadClientCredentials } from '@snjsm/collector/node';
import type { ParamValue } from '@snjsm/model';
import { analyse, renderReport, summaryLine } from '../src';

const ROOT = resolve(__dirname, '../../..');

/** --flag value parser that keeps repeated flags. */
function args(argv: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const v = inline ?? (argv[i + 1] && !argv[i + 1]!.startsWith('--') ? argv[++i]! : 'true');
    (out[k] ??= []).push(v);
  }
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'customer';

function parseValue(v: string): ParamValue {
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true' || v === 'false') return v === 'true';
  const d = v.match(/^(\d+(?:\.\d+)?)\s*(minutes|hours|business-hours|days|business-days)$/);
  if (d) return { value: Number(d[1]), unit: d[2] as 'hours' };
  if (v.includes(',')) return v.split(',').map((s) => s.trim());
  return v;
}

async function main() {
  const a = args(process.argv.slice(2));
  const customer = a['customer']?.[0];
  if (!customer || (!a['xml'] && !a['instance'] && !a['snapshot'])) {
    throw new Error('usage: npm run analyse -- (--xml <file> ... | --instance <host> | --snapshot <json>) --customer "<name>" [--out <dir>]');
  }
  const snaps: Snapshot[] = [];
  for (const s of a['snapshot'] ?? []) snaps.push(JSON.parse(readFileSync(s, 'utf8')) as Snapshot);
  if (a['xml']) {
    const files = a['xml'].map((f) => ({ name: basename(f), xml: readFileSync(f, 'utf8') }));
    const snap = snapshotFromXml(files);
    console.log(`xml: ${snap.records.length} records from ${files.length} file(s)`);
    snaps.push(snap);
  }
  for (const host of a['instance'] ?? []) {
    const instanceUrl = normaliseInstanceUrl(host);
    const creds = loadClientCredentials(instanceUrl);
    console.log(`instance: ${instanceUrl} (credentials: ${creds.source})`);
    const auth = new ClientCredentialsProvider(instanceUrl, creds.clientId, creds.clientSecret, nodeFetch);
    const client = new ServiceNowClient({ instanceUrl, auth, maxRequestsPerSecond: Number(a['rps']?.[0] ?? 4) });
    const snap = await collectLive(client, { usageDays: Number(a['usage-days']?.[0] ?? 365), onProgress: (m) => console.log(`  ${m}`) });
    console.log(`live: ${snap.records.length} records, ${snap.aggregates.length} aggregates`);
    snaps.push(snap);
  }
  const snapshot = mergeSnapshots(snaps);

  const overrides: Record<string, Record<string, ParamValue>> = {};
  for (const s of a['set'] ?? []) {
    const m = s.match(/^(.+)\.([a-zA-Z][a-zA-Z0-9]*)=(.*)$/);
    if (!m) throw new Error(`--set expects capability.param=value, got "${s}"`);
    (overrides[m[1]!] ??= {})[m[2]!] = parseValue(m[3]!);
  }
  const edition = a['edition']?.[0] as 'premium' | undefined;
  const result = analyse(snapshot, {
    customer, industry: a['industry']?.[0], name: a['name']?.[0],
    target: { ...(a['site'] ? { site: a['site'][0] } : {}), ...(edition ? { edition } : {}) },
    capabilities: a['capability'], include: a['include'], overrides,
    maxEvidence: a['max-evidence'] ? Number(a['max-evidence'][0]) : undefined,
  });

  const out = resolve(a['out']?.[0] ?? join(ROOT, 'out', slug(customer)));
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'snapshot.json'), JSON.stringify(snapshot));
  writeFileSync(join(out, 'blueprint.json'), JSON.stringify(result.blueprint, null, 2));
  writeFileSync(join(out, 'assessment.json'), JSON.stringify(result.assessment, null, 2));
  writeFileSync(join(out, 'assessment.md'), renderReport(result));
  const errors = result.assessment.validation.filter((i) => i.severity === 'error');
  console.log(summaryLine(result.blueprint, result.assessment.score.score));
  console.log(`validation: ${errors.length} errors, ${result.assessment.validation.length - errors.length} warnings`);
  for (const e of errors.slice(0, 10)) console.log(`  error ${e.path}: ${e.message}`);
  console.log(`wrote ${out}/{snapshot,blueprint,assessment}.json and assessment.md`);
  if (errors.length) process.exitCode = 2;
}

main().catch((e) => {
  console.error(`FAILED: ${(e as Error).message}`);
  process.exit(1);
});
