import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { normaliseSite } from '@snjsm/atlassian';
import { Blueprint } from '@snjsm/model';
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
 *  - the state file is locked during apply / confirm / verify, and written after every step.
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
}

export interface ScopeInput { capabilityIds?: string[]; elementIds?: string[] }
export interface BlueprintInput extends ScopeInput { blueprint: string; site?: string }

const MAX_MARKDOWN = 24_000;
const clip = (md: string, file?: string) => (md.length <= MAX_MARKDOWN ? md : `${md.slice(0, MAX_MARKDOWN)}\n\n… truncated${file ? `; full text in ${file}` : ''}`);
const scopeOf = (i: ScopeInput): Scope => ({ ...(i.capabilityIds?.length ? { capabilityIds: i.capabilityIds } : {}), ...(i.elementIds?.length ? { elementIds: i.elementIds } : {}) });
const safeName = (s: string) => s.replace(/[^\w.@-]+/g, '_');
const hostOf = (site: string) => new URL(site).hostname;
export const confirmPhrase = (planHash: string, site: string) => `APPLY ${planHash} TO ${site}`;

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

  async workBreakdown(i: BlueprintInput) {
    const bp = this.loadBlueprint(i.blueprint);
    const site = this.siteFor(bp, i.site);
    const p = await plan({ bp, ...(site && this.loadState(bp, site) ? { state: this.loadState(bp, site)! } : {}), scope: scopeOf(i) });
    return { epics: workBreakdown(bp, p) };
  }
}
