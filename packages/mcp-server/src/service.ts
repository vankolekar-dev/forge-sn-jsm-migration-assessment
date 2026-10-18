import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { normaliseSite } from '@snjsm/atlassian';
import { Blueprint, PERSONAS } from '@snjsm/model';
import {
  type AcceptancePlan, type Clock, type TestConfig, type TestDataLedger,
  cleanupTestData, planAcceptance, renderAcceptancePlan, renderAcceptanceResult, runAcceptance,
} from '@snjsm/acceptance';
import {
  apply, assertStateMatches, confirmManual, isSignedOff, newState, pendingManual, plan, readState, renderApply, renderManual,
  renderPlan, renderVerify, scopeElements, strategyOf, verify, withLock, workBreakdown, writeState,
  type BuildOptions, type BuildState, type Plan, type Scope, type SiteApi,
} from '@snjsm/builder';

/**
 * The build service behind the MCP tools and the CLI. All safety gates live here, not in the LLM:
 *  - files are read and written only inside the work directory;
 *  - dry-runs, verify and discovery use read-only clients;
 *  - apply needs the site in an explicit allowlist, a dry-run produced by this service, and the exact phrase
 *    "APPLY <planHash> TO <site>" typed by a person; the engine then re-runs the dry-run and refuses if it changed;
 *  - the state file is locked during apply / confirm / verify, and written after every step;
 *  - acceptance runs create tagged test data, so they are gated like apply: allowlisted site, a plan produced by
 *    this service, and "TEST <runHash> ON <site>"; cleanup only removes ledger items that still carry the tag.
 */
export interface ServiceConfig {
  /** Absolute work directory (blueprints, plans, state). */
  workdir: string;
  /** Default site when a tool call does not name one (else the blueprint's target site). */
  defaultSite?: string;
  /** Sites apply may write to. Empty = apply disabled. */
  writeSites: string[];
  /** Allow apply before the blueprint is signed off (sandboxes only). */
  allowUnsigned: boolean;
  /** Who is recorded in the state file. */
  by: string;
  options?: BuildOptions;
  clientFor(site: string, readOnly: boolean): SiteApi;
  /** A write client acting as a test persona (its own credentials), or undefined when none are configured. */
  personaClientFor?(site: string, persona: string): SiteApi | undefined;
  acceptance?: { clock?: Clock; defaultWithinSeconds?: number; pollSeconds?: number };
}

export interface ScopeInput { capabilityIds?: string[]; elementIds?: string[] }
export interface BlueprintInput extends ScopeInput { blueprint: string; site?: string }

const MAX_MARKDOWN = 24_000;
const clip = (md: string, file?: string) => (md.length <= MAX_MARKDOWN ? md : `${md.slice(0, MAX_MARKDOWN)}\n\n… truncated${file ? `; full text in ${file}` : ''}`);
const scopeOf = (i: ScopeInput): Scope => ({ ...(i.capabilityIds?.length ? { capabilityIds: i.capabilityIds } : {}), ...(i.elementIds?.length ? { elementIds: i.elementIds } : {}) });
const safeName = (s: string) => s.replace(/[^\w.@-]+/g, '_');
const hostOf = (site: string) => new URL(site).hostname;
export const confirmPhrase = (planHash: string, site: string) => `APPLY ${planHash} TO ${site}`;
export const testPhrase = (runHash: string, site: string) => `TEST ${runHash} ON ${site}`;
export const cleanupPhrase = (runId: string, site: string) => `CLEANUP ${runId} ON ${site}`;

export function configFromEnv(env: NodeJS.ProcessEnv, clientFor: ServiceConfig['clientFor'], cwd = process.cwd()): ServiceConfig {
  const list = (v?: string) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean).map(normaliseSite);
  return {
    workdir: resolve(cwd, env.SNJSM_WORKDIR || 'out'),
    ...(env.SNJSM_SITE ? { defaultSite: normaliseSite(env.SNJSM_SITE) } : {}),
    writeSites: list(env.SNJSM_WRITE_SITES),
    allowUnsigned: env.SNJSM_ALLOW_UNSIGNED === '1',
    by: env.SNJSM_BY || env.USER || 'unknown',
    ...(env.SNJSM_LEAD_ACCOUNT_ID ? { options: { leadAccountId: env.SNJSM_LEAD_ACCOUNT_ID } } : {}),
    clientFor,
  };
}

export class BuildService {
  constructor(readonly cfg: ServiceConfig) {}

  // ── files ────────────────────────────────────────────────────────────────

  /** Resolve a path inside the work directory; anything outside it (.., absolute elsewhere, symlinks out) is refused. */
  path(p: string): string {
    const root = existsSync(this.cfg.workdir) ? realpathSync(this.cfg.workdir) : this.cfg.workdir;
    const abs = resolve(root, p);
    const real = existsSync(abs) ? realpathSync(abs) : abs;
    const rel = relative(root, real);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`path ${p} is outside the work directory ${this.cfg.workdir}`);
    return real;
  }

  private write(rel: string, text: string): string {
    const abs = this.path(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    return relative(this.path('.'), abs);
  }

  loadBlueprint(p: string): Blueprint {
    const abs = this.path(p);
    if (!existsSync(abs)) throw new Error(`blueprint ${p} not found in ${this.cfg.workdir}`);
    const parsed = Blueprint.safeParse(JSON.parse(readFileSync(abs, 'utf8')));
    if (!parsed.success) throw new Error(`${p} is not a valid Migration Blueprint: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    return parsed.data;
  }

  siteFor(bp: Blueprint, site?: string): string | undefined {
    const s = site ?? this.cfg.defaultSite ?? bp.target.site;
    return s ? normaliseSite(s) : undefined;
  }

  private needSite(bp: Blueprint, site?: string): string {
    const s = this.siteFor(bp, site);
    if (!s) throw new Error('no site: pass site, set SNJSM_SITE, or set target.site in the blueprint');
    return s;
  }

  statePath(bp: Blueprint, site: string): string {
    return this.path(join('state', `${safeName(bp.id)}@${hostOf(site)}.json`));
  }

  private loadState(bp: Blueprint, site: string): BuildState | undefined {
    const s = readState(this.statePath(bp, site));
    if (s) assertStateMatches(s, bp.id, site);
    return s;
  }

  private planFile(bp: Blueprint, site: string | undefined, hash: string, ext: 'json' | 'md') {
    return join('plans', `${safeName(bp.id)}@${site ? hostOf(site) : 'offline'}-${hash.slice(0, 12)}.${ext}`);
  }

  // ── tools ────────────────────────────────────────────────────────────────

  summary(i: { blueprint: string; site?: string }) {
    const bp = this.loadBlueprint(i.blueprint);
    const byType: Record<string, number> = {};
    const byStrategy: Record<string, number> = {};
    for (const el of bp.design) {
      byType[el.type] = (byType[el.type] ?? 0) + 1;
      const s = strategyOf(el).strategy;
      byStrategy[s] = (byStrategy[s] ?? 0) + 1;
    }
    const site = this.siteFor(bp, i.site);
    const state = site ? this.loadState(bp, site) : undefined;
    return {
      id: bp.id, name: bp.name, customer: bp.customer.name, signedOff: isSignedOff(bp), site: site ?? null,
      writeAllowed: site ? this.cfg.writeSites.includes(site) : false,
      capabilities: bp.capabilities.map((c) => ({ id: c.capabilityId, status: (c as { status?: string }).status })),
      outcomes: bp.outcomes.map((o) => ({ id: o.id, capabilityId: o.capabilityId, statement: o.statement })),
      design: { total: bp.design.length, byType, byStrategy },
      spaces: bp.design.flatMap((d) => (d.type === 'space' ? [{ designId: d.id, name: d.spec.name, mode: d.spec.mode, key: d.spec.key ?? null }] : [])),
      built: state ? Object.keys(state.elements).length : 0,
    };
  }

  /**
   * Choose where a space is built: a new space from the template (optionally with a name and key), or an existing
   * space by key. Edits the blueprint file and records the change as a decision, so a prior sign-off goes stale.
   */
  setSpace(i: { blueprint: string; designId?: string; mode: 'new' | 'existing'; key?: string; name?: string; reason?: string }) {
    const bp = this.loadBlueprint(i.blueprint);
    const spaces = bp.design.filter((d) => d.type === 'space');
    const el = i.designId ? spaces.find((d) => d.id === i.designId) : spaces.length === 1 ? spaces[0] : undefined;
    if (!el || el.type !== 'space') throw new Error(i.designId ? `no space element ${i.designId}` : `the blueprint has ${spaces.length} spaces: pass designId (${spaces.map((s) => s.id).join(', ')})`);
    const key = i.key?.trim().toUpperCase();
    if (i.mode === 'existing' && !key) throw new Error('building into an existing space needs its key');
    if (key && !/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new Error(`invalid space key ${key}`);
    const before = { mode: el.spec.mode, key: el.spec.key ?? null, name: el.spec.name };
    const spec = { ...el.spec, mode: i.mode, ...(i.name ? { name: i.name.trim() } : {}) };
    if (key) spec.key = key; else delete spec.key;
    const after = { mode: spec.mode, key: spec.key ?? null, name: spec.name };
    const wasSigned = isSignedOff(bp);
    const at = new Date().toISOString();
    const next = {
      ...bp, updatedAt: at,
      design: bp.design.map((d) => (d.id === el.id ? { ...d, ...(i.name && d.name === el.spec.name ? { name: spec.name } : {}), spec } : d)),
      decisions: [...bp.decisions, { id: `d.space.${el.id}.${at.replace(/[^0-9]/g, '')}`, at, by: this.cfg.by, subject: { kind: 'design-element' as const, id: el.id }, action: 'change' as const, comment: i.reason ?? `target space: ${i.mode}${key ? ` ${key}` : ''}`, before, after }],
    };
    const parsed = Blueprint.safeParse(next);
    if (!parsed.success) throw new Error(`change rejected: ${parsed.error.issues.slice(0, 3).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    writeFileSync(this.path(i.blueprint), JSON.stringify(parsed.data, null, 2));
    return {
      designId: el.id, before, after, signedOff: isSignedOff(parsed.data),
      next: `${wasSigned ? 'The earlier sign-off no longer covers the design: sign off again before apply. ' : ''}Run build_plan with dryRun to check the space on the site.`,
    };
  }

  async plan(i: BlueprintInput & { dryRun?: boolean }) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = i.dryRun ? this.needSite(bp, i.site) : this.siteFor(bp, i.site);
    const state = site ? this.loadState(bp, site) : undefined;
    const p = await plan({ bp, ...(state ? { state } : {}), scope: scopeOf(i), ...(i.dryRun ? { api: this.cfg.clientFor(site!, true) } : {}), ...(this.cfg.options ? { options: this.cfg.options } : {}) });
    if (site) p.site = site;
    const md = renderPlan(p);
    const jsonFile = this.write(this.planFile(bp, site, p.planHash, 'json'), JSON.stringify(p, null, 2));
    const mdFile = this.write(this.planFile(bp, site, p.planHash, 'md'), md);
    const canApply = p.mode === 'dry-run' && Boolean(site && this.cfg.writeSites.includes(site));
    return {
      planHash: p.planHash, mode: p.mode, site: site ?? null, summary: p.summary, warnings: p.warnings, files: { json: jsonFile, markdown: mdFile },
      signedOff: isSignedOff(bp),
      apply: p.mode !== 'dry-run'
        ? 'offline plan: run a dry-run against the site before apply'
        : canApply
          ? `To build, a person must review this dry-run and type exactly: ${confirmPhrase(p.planHash, site!)}`
          : `apply is disabled for ${site} (not in SNJSM_WRITE_SITES)`,
      markdown: clip(md, mdFile),
    };
  }

  async apply(i: BlueprintInput & { planHash: string; confirm: string }) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    if (!this.cfg.writeSites.includes(site)) throw new Error(`apply refused: ${site} is not in SNJSM_WRITE_SITES (${this.cfg.writeSites.join(', ') || 'empty: apply disabled'})`);
    if (i.confirm.trim() !== confirmPhrase(i.planHash, site)) throw new Error(`apply refused: confirmation must be exactly "${confirmPhrase(i.planHash, site)}", typed by the person who reviewed the dry-run`);
    const reviewed = this.path(this.planFile(bp, site, i.planHash, 'json'));
    if (!existsSync(reviewed)) throw new Error(`apply refused: no dry-run with plan ${i.planHash} for ${site}; run build_plan with dryRun first`);
    const prior = JSON.parse(readFileSync(reviewed, 'utf8')) as Plan;
    if (prior.mode !== 'dry-run' || prior.planHash !== i.planHash) throw new Error(`apply refused: plan ${i.planHash} was not a dry-run`);
    const statePath = this.statePath(bp, site);
    return withLock(statePath, async () => {
      const state = this.loadState(bp, site) ?? newState(bp.id, site);
      const res = await apply({
        bp, state, api: this.cfg.clientFor(site, false), readApi: this.cfg.clientFor(site, true), approvedPlanHash: i.planHash,
        scope: scopeOf(i), allowUnsigned: this.cfg.allowUnsigned, by: this.cfg.by, persist: (s) => writeState(statePath, s),
        ...(this.cfg.options ? { options: this.cfg.options } : {}),
      });
      writeState(statePath, state);
      const md = renderApply(res);
      const file = this.write(join('runs', `${safeName(bp.id)}@${hostOf(site)}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`), md);
      return {
        planHash: res.planHash, summary: res.summary, report: file, state: relative(this.path('.'), statePath),
        failed: res.results.filter((r) => r.result === 'failed').map((r) => ({ designId: r.designId, detail: r.detail })),
        guidedSteps: res.manual.length, markdown: clip(md, file),
      };
    });
  }

  async manualSteps(i: BlueprintInput) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = this.siteFor(bp, i.site);
    const steps = await pendingManual(bp, site ? this.loadState(bp, site) : undefined, scopeOf(i));
    const md = steps.length ? steps.map((m, n) => renderManual(m, n + 1)).join('\n\n') : 'No guided steps pending.';
    return { count: steps.length, steps: steps.map((s) => ({ designId: s.designId, title: s.title, record: s.record })), markdown: clip(md) };
  }

  async confirmManual(i: { blueprint: string; site?: string; designId: string; remoteId?: string; remoteKey?: string; note?: string }) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    const statePath = this.statePath(bp, site);
    return withLock(statePath, async () => {
      const state = this.loadState(bp, site) ?? newState(bp.id, site);
      const el = confirmManual(bp, state, { designId: i.designId, by: this.cfg.by, ...(i.remoteId ? { remoteId: i.remoteId } : {}), ...(i.remoteKey ? { remoteKey: i.remoteKey } : {}), ...(i.note ? { note: i.note } : {}) });
      writeState(statePath, state);
      return { designId: el.designId, status: el.status, remote: el.remote ?? null, next: 'run build_plan (dry-run) again: elements waiting on this one are now unblocked' };
    });
  }

  async verify(i: BlueprintInput) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    const statePath = this.statePath(bp, site);
    return withLock(statePath, async () => {
      const state = this.loadState(bp, site);
      if (!state) throw new Error(`nothing built on ${site} yet (no state file)`);
      const report = await verify(bp, state, this.cfg.clientFor(site, true), scopeOf(i));
      writeState(statePath, state);
      const md = renderVerify(report);
      const file = this.write(join('runs', `${safeName(bp.id)}@${hostOf(site)}-verify-${report.at.replace(/[:.]/g, '-')}.md`), md);
      return { summary: report.summary, report: file, problems: report.results.filter((r) => !['ok', 'unverifiable'].includes(r.status)).map((r) => ({ designId: r.designId, status: r.status, detail: r.detail })), markdown: clip(md, file) };
    });
  }

  status(i: { blueprint: string; site?: string }) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    const state = this.loadState(bp, site);
    const byStatus: Record<string, number> = {};
    for (const e of Object.values(state?.elements ?? {})) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    const inScope = scopeElements(bp).length;
    return {
      site, blueprintId: bp.id, stateFile: relative(this.path('.'), this.statePath(bp, site)), exists: Boolean(state),
      elements: { inDesign: inScope, recorded: Object.keys(state?.elements ?? {}).length, byStatus },
      failed: Object.values(state?.elements ?? {}).filter((e) => e.status === 'failed').map((e) => ({ designId: e.designId, error: e.error })),
      lastRuns: (state?.runs ?? []).slice(-5),
    };
  }

  // ── acceptance tests ─────────────────────────────────────────────────────

  /** Per-site test config: acceptance/<host>.json (persona account ids, existing objects to use as fixtures). */
  private testConfig(site: string): TestConfig {
    const abs = this.path(join('acceptance', `${hostOf(site)}.json`));
    if (!existsSync(abs)) return {};
    const c = JSON.parse(readFileSync(abs, 'utf8')) as TestConfig;
    if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new Error(`${abs} must be a JSON object`);
    return c;
  }

  private personaClients(site: string): Record<string, SiteApi> {
    const out: Record<string, SiteApi> = {};
    for (const p of PERSONAS) {
      if (p === 'agent') continue;
      const c = this.cfg.personaClientFor?.(site, p);
      if (c) out[p] = c;
    }
    return out;
  }

  private testFile(bp: Blueprint, site: string, name: string) {
    return join('tests', `${safeName(bp.id)}@${hostOf(site)}-${name}`);
  }

  private makeAcceptancePlan(bp: Blueprint, site: string, outcomeIds?: string[]): AcceptancePlan {
    return planAcceptance({
      bp, state: this.loadState(bp, site), site, config: this.testConfig(site),
      actors: Object.keys(this.personaClients(site)), ...(outcomeIds?.length ? { outcomeIds } : {}),
    });
  }

  /** Offline: which acceptance criteria can run now, what blocks the rest, and the phrase to run them. */
  acceptancePlan(i: { blueprint: string; site?: string; outcomeIds?: string[] }) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    const p = this.makeAcceptancePlan(bp, site, i.outcomeIds);
    const canRun = this.cfg.writeSites.includes(site) && p.summary.ready > 0;
    const md = renderAcceptancePlan(p, canRun ? testPhrase(p.runHash, site) : undefined);
    const json = this.write(this.testFile(bp, site, `plan-${p.runHash.slice(0, 12)}.json`), JSON.stringify({ ...p, outcomeIds: i.outcomeIds ?? [] }, null, 2));
    const mdFile = this.write(this.testFile(bp, site, `plan-${p.runHash.slice(0, 12)}.md`), md);
    return {
      runHash: p.runHash, site, summary: p.summary, files: { json, markdown: mdFile },
      blocked: p.criteria.filter((c) => c.status === 'blocked').map((c) => ({ acId: c.acId, reasons: c.reasons })),
      run: !p.summary.ready
        ? 'nothing is ready to run: finish the blocking guided steps (build_manual_steps) or add persona credentials, then plan again'
        : canRun
          ? `To run the ${p.summary.ready} ready check(s), a person must review this plan and type exactly: ${testPhrase(p.runHash, site)}`
          : `acceptance runs are disabled for ${site} (not in SNJSM_WRITE_SITES)`,
      markdown: clip(md, mdFile),
    };
  }

  /** Run the ready criteria of a reviewed plan. Gated like apply; refuses if the plan would differ now. */
  async acceptanceRun(i: { blueprint: string; site?: string; runHash: string; confirm: string; keep?: boolean }) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    if (!this.cfg.writeSites.includes(site)) throw new Error(`acceptance run refused: ${site} is not in SNJSM_WRITE_SITES (${this.cfg.writeSites.join(', ') || 'empty: writes disabled'})`);
    if (i.confirm.trim() !== testPhrase(i.runHash, site)) throw new Error(`acceptance run refused: confirmation must be exactly "${testPhrase(i.runHash, site)}", typed by the person who reviewed the test plan`);
    const reviewed = this.path(this.testFile(bp, site, `plan-${i.runHash.slice(0, 12)}.json`));
    if (!existsSync(reviewed)) throw new Error(`acceptance run refused: no test plan ${i.runHash} for ${site}; run acceptance_plan first`);
    const prior = JSON.parse(readFileSync(reviewed, 'utf8')) as AcceptancePlan & { outcomeIds?: string[] };
    if (prior.runHash !== i.runHash) throw new Error(`acceptance run refused: ${reviewed} is not plan ${i.runHash}`);
    const statePath = this.statePath(bp, site);
    return withLock(statePath, async () => {
      const state = this.loadState(bp, site);
      if (!state) throw new Error(`nothing built on ${site} yet (no state file)`);
      const fresh = this.makeAcceptancePlan(bp, site, prior.outcomeIds);
      if (fresh.runHash !== i.runHash) throw new Error(`acceptance run refused: the test plan changed since it was reviewed (now ${fresh.runHash}); review the new plan`);
      if (!fresh.summary.ready) throw new Error('acceptance run refused: no criteria are ready to run');
      const clock = this.cfg.acceptance?.clock;
      const runId = new Date(clock?.now() ?? Date.now()).toISOString().replace(/\D/g, '').slice(0, 14);
      const ledgerFile = this.testFile(bp, site, `run-${runId}.ledger.json`);
      const res = await runAcceptance({
        plan: fresh, bp, state, api: this.cfg.clientFor(site, false), personas: this.personaClients(site), config: this.testConfig(site),
        runId, ...(i.keep ? { keep: true } : {}), ...(clock ? { clock } : {}),
        ...(this.cfg.acceptance?.defaultWithinSeconds !== undefined ? { defaultWithinSeconds: this.cfg.acceptance.defaultWithinSeconds } : {}),
        ...(this.cfg.acceptance?.pollSeconds !== undefined ? { pollSeconds: this.cfg.acceptance.pollSeconds } : {}),
      });
      this.write(ledgerFile, JSON.stringify(res.ledger, null, 2));
      const md = renderAcceptanceResult(res);
      const jsonFile = this.write(this.testFile(bp, site, `run-${runId}.json`), JSON.stringify(res, null, 2));
      const mdFile = this.write(this.testFile(bp, site, `run-${runId}.md`), md);
      const s = res.summary;
      state.runs.push({ id: `acceptance-${runId}`, op: 'acceptance', at: res.finishedAt, planHash: res.runHash, summary: `${s.pass} pass, ${s.partial} partial, ${s.fail} fail, ${s.error} error, ${s.blocked} blocked, ${s.manual} manual` });
      writeState(statePath, state);
      const left = res.ledger.cleanup?.leftovers ?? [];
      return {
        runId, runHash: res.runHash, summary: res.summary, files: { json: jsonFile, markdown: mdFile, ledger: ledgerFile },
        failed: res.outcomes.flatMap((o) => o.criteria).filter((c) => c.verdict === 'fail' || c.verdict === 'error').map((c) => ({ acId: c.acId, request: c.request ?? null, detail: c.steps.find((x) => x.result === 'fail' || x.result === 'error')?.detail ?? c.detail ?? '' })),
        manualChecks: res.manualChecks,
        testData: res.ledger.cleanup
          ? left.length ? `${left.length} item(s) left over; after checking them, clean up with: ${cleanupPhrase(runId, site)}` : 'removed'
          : `kept for inspection; remove with acceptance_cleanup and: ${cleanupPhrase(runId, site)}`,
        markdown: clip(md, mdFile),
      };
    });
  }

  /** Remove a run's remaining test data (only items that still carry the run's tag). */
  async acceptanceCleanup(i: { blueprint: string; site?: string; runId: string; confirm: string }) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    if (!this.cfg.writeSites.includes(site)) throw new Error(`cleanup refused: ${site} is not in SNJSM_WRITE_SITES`);
    if (!/^\d{14}$/.test(i.runId)) throw new Error(`invalid run id ${i.runId}`);
    if (i.confirm.trim() !== cleanupPhrase(i.runId, site)) throw new Error(`cleanup refused: confirmation must be exactly "${cleanupPhrase(i.runId, site)}"`);
    const file = this.testFile(bp, site, `run-${i.runId}.ledger.json`);
    const abs = this.path(file);
    if (!existsSync(abs)) throw new Error(`no test-data ledger for run ${i.runId} on ${site}`);
    const ledger = JSON.parse(readFileSync(abs, 'utf8')) as TestDataLedger;
    if (ledger.site !== site || ledger.blueprintId !== bp.id) throw new Error(`ledger ${file} belongs to ${ledger.blueprintId} on ${ledger.site}`);
    const pending: TestDataLedger = { ...ledger, requests: ledger.requests.filter((r) => !ledger.cleanup?.removed.includes(r.key)), objects: ledger.objects.filter((o) => !ledger.cleanup?.removed.includes(o.key ?? o.id)) };
    const done = await cleanupTestData(this.cfg.clientFor(site, false), pending, this.cfg.acceptance?.clock);
    ledger.cleanup = { at: done!.at, removed: [...new Set([...(ledger.cleanup?.removed ?? []), ...done!.removed])], leftovers: done!.leftovers };
    this.write(file, JSON.stringify(ledger, null, 2));
    return { runId: i.runId, removed: done!.removed, leftovers: done!.leftovers, ledger: file };
  }

  async workBreakdown(i: BlueprintInput) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = this.siteFor(bp, i.site);
    const p = await plan({ bp, ...(site && this.loadState(bp, site) ? { state: this.loadState(bp, site)! } : {}), scope: scopeOf(i) });
    return { epics: workBreakdown(bp, p) };
  }
}
