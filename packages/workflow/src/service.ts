import { normaliseSite } from '@snjsm/atlassian';
import { Blueprint, PERSONAS } from '@snjsm/model';
import {
  type AcceptancePlan, type Clock, type TestConfig, type TestDataLedger,
  cleanupTestData, planAcceptance, renderAcceptancePlan, renderAcceptanceResult, runAcceptance,
} from '@snjsm/acceptance';
import {
  apply, assertStateMatches, confirmManual, hashOf, isSignedOff, specHashOf, newState, pendingManual, plan,
  renderApply, renderManual, renderPlan, renderVerify, scopeElements, strategyOf, verify, workBreakdown,
  type BuildOptions, type BuildState, type Plan, type Scope, type SiteApi,
} from '@snjsm/builder';
import type { Store } from './store';

/**
 * The build workflow behind the MCP tools, the CLI and the Forge workbench. All safety gates live here, not in an
 * LLM or a UI:
 *  - everything is read and written through a Store (no direct file or network access);
 *  - sign-off needs "SIGN OFF <signHash> FOR <blueprintId>" for exactly the reviewed content, recorded with who and when;
 *  - dry-runs, verify and discovery use read-only clients;
 *  - apply needs the site in an explicit allowlist, a dry-run produced by this workflow, and the exact phrase
 *    "APPLY <planHash> TO <site>" typed by a person; the engine then re-runs the dry-run and refuses if it changed;
 *  - the state is locked during apply / confirm / verify / acceptance, and written after every step;
 *  - acceptance runs create tagged test data, so they are gated like apply: allowlisted site, a plan produced by
 *    this workflow, and "TEST <runHash> ON <site>"; cleanup only removes ledger items that still carry the tag.
 */
export interface ServiceConfig {
  store: Store;
  /** Default site when a call does not name one (else the blueprint's target site). */
  defaultSite?: string;
  /** Sites apply and acceptance runs may write to. Empty = writes disabled. */
  writeSites: string[];
  /** How a person adds a site to writeSites, for refusal messages (e.g. "SNJSM_WRITE_SITES"). */
  writeSitesHint?: string;
  /** Allow apply before the blueprint is signed off (sandboxes only). */
  allowUnsigned: boolean;
  /** Who is recorded in decisions and the state. */
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
export const safeName = (s: string) => s.replace(/[^\w.@-]+/g, '_');
export const hostOf = (site: string) => new URL(site).hostname;
export const confirmPhrase = (planHash: string, site: string) => `APPLY ${planHash} TO ${site}`;
export const testPhrase = (runHash: string, site: string) => `TEST ${runHash} ON ${site}`;
export const cleanupPhrase = (runId: string, site: string) => `CLEANUP ${runId} ON ${site}`;
export const signOffPhrase = (signHash: string, blueprintId: string) => `SIGN OFF ${signHash} FOR ${blueprintId}`;

/** Everything a sign-off approves: outcomes and their criteria, catalogue versions, and the design. Any change gives a new hash. */
export function signOffContent(bp: Blueprint) {
  return {
    id: bp.id,
    capabilities: bp.capabilities.map((c) => [c.capabilityId, c.catalogueVersion, c.status]),
    outcomes: bp.outcomes.map((o) => ({ id: o.id, statement: o.statement, parameters: o.parameters, acceptance: o.acceptance, priority: o.priority, status: o.status })),
    design: bp.design.map((el) => [el.id, specHashOf(el)]),
  };
}

const OPEN_OUTCOME = new Set(['proposed', 'changed']);

function renderSignOff(bp: Blueprint, signHash: string): string {
  const lines = [
    `# Sign-off review: ${bp.name}`,
    '',
    `Blueprint \`${bp.id}\` · signHash \`${signHash}\` · ${bp.outcomes.length} outcomes · ${bp.design.length} design elements`,
    '',
    `Capabilities: ${bp.capabilities.map((c) => `${c.capabilityId} v${c.catalogueVersion} (${c.status})`).join(', ')}`,
    '',
  ];
  for (const o of bp.outcomes) {
    lines.push(`## ${o.category}: ${o.statement}`, '', `\`${o.id}\` · ${o.priority} · now ${o.status}`, '');
    const params = Object.entries(o.parameters);
    if (params.length) lines.push(`Parameters: ${params.map(([k, v]) => `${k} = ${typeof v === 'object' && v && 'value' in v ? `${(v as { value: number }).value} ${(v as { unit: string }).unit}` : JSON.stringify(v)}`).join(', ')}`, '');
    for (const ac of o.acceptance) {
      lines.push(`- **${ac.id.split('.').at(-1)}** (${ac.verification}) Given ${ac.given}; when ${ac.when}; then ${ac.then.join('; ')}.`);
    }
    lines.push('');
  }
  lines.push('---', '', 'Every outcome that is still proposed is confirmed unless it is named as rejected or deferred. A signed-off blueprint is amended by naming outcomes to reject, defer or reinstate.', '', `To sign off, the person accountable for these outcomes types exactly: \`${signOffPhrase(signHash, bp.id)}\``);
  return lines.join('\n');
}

export function parseBlueprint(text: string, name: string): Blueprint {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error(`${name} is not JSON`); }
  const parsed = Blueprint.safeParse(raw);
  if (!parsed.success) throw new Error(`${name} is not a valid Migration Blueprint: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  return parsed.data;
}

function parseState(text: string): BuildState {
  const s = JSON.parse(text) as BuildState;
  if (s.schemaVersion !== '1') throw new Error(`unsupported state file version ${s.schemaVersion}`);
  return s;
}

export class BuildService {
  constructor(readonly cfg: ServiceConfig) {}

  private get store() { return this.cfg.store; }
  private get writeHint() { return this.cfg.writeSitesHint ?? 'SNJSM_WRITE_SITES'; }

  // ── storage ──────────────────────────────────────────────────────────────

  private async write(key: string, text: string): Promise<string> {
    await this.store.write(key, text);
    return key;
  }

  private async readJson<T>(key: string): Promise<T | undefined> {
    const t = await this.store.read(key);
    return t === undefined ? undefined : (JSON.parse(t) as T);
  }

  async loadBlueprint(key: string): Promise<Blueprint> {
    const text = await this.store.read(key);
    if (text === undefined) throw new Error(`blueprint ${key} not found`);
    return parseBlueprint(text, key);
  }

  private async saveBlueprint(key: string, bp: unknown, what: string): Promise<Blueprint> {
    const parsed = Blueprint.safeParse(bp);
    if (!parsed.success) throw new Error(`${what} rejected: ${parsed.error.issues.slice(0, 3).map((x) => `${x.path.join('.')}: ${x.message}`).join('; ')}`);
    await this.store.write(key, JSON.stringify(parsed.data, null, 2));
    return parsed.data;
  }

  siteFor(bp: Blueprint, site?: string): string | undefined {
    const s = site ?? this.cfg.defaultSite ?? bp.target.site;
    return s ? normaliseSite(s) : undefined;
  }

  private needSite(bp: Blueprint, site?: string): string {
    const s = this.siteFor(bp, site);
    if (!s) throw new Error('no site: pass site, set a default site, or set target.site in the blueprint');
    return s;
  }

  writeAllowed(site: string): boolean { return this.cfg.writeSites.includes(site); }

  statePath(bp: Blueprint, site: string): string {
    return `state/${safeName(bp.id)}@${hostOf(site)}.json`;
  }

  private async loadState(bp: Blueprint, site: string): Promise<BuildState | undefined> {
    const t = await this.store.read(this.statePath(bp, site));
    if (t === undefined) return undefined;
    const s = parseState(t);
    assertStateMatches(s, bp.id, site);
    return s;
  }

  private async saveState(key: string, s: BuildState): Promise<void> {
    s.updatedAt = new Date().toISOString();
    await this.store.write(key, JSON.stringify(s, null, 2));
  }

  /** The engine persists synchronously after every step; queue the writes so they land in order and none is lost. */
  private persister(key: string) {
    let chain: Promise<void> = Promise.resolve();
    return {
      persist: (s: BuildState) => { const snap = structuredClone(s); chain = chain.then(() => this.saveState(key, snap)); },
      flush: () => chain,
    };
  }

  /** States of other blueprints pinned to the same site, for carrying identical confirmed guided steps forward. */
  private async priorStates(bp: Blueprint, site: string): Promise<BuildState[]> {
    const suffix = `@${hostOf(site)}.json`;
    const own = this.statePath(bp, site);
    const out: BuildState[] = [];
    for (const key of await this.store.list('state/')) {
      if (!key.endsWith(suffix) || key === own) continue;
      try {
        const t = await this.store.read(key);
        const s = t === undefined ? undefined : parseState(t);
        if (s && s.site === site && s.blueprintId !== bp.id) out.push(s);
      } catch { /* unreadable or other version: ignore */ }
    }
    return out;
  }

  private planFile(bp: Blueprint, site: string | undefined, hash: string, ext: 'json' | 'md') {
    return `plans/${safeName(bp.id)}@${site ? hostOf(site) : 'offline'}-${hash.slice(0, 12)}.${ext}`;
  }

  private stamp() { return new Date().toISOString().replace(/[:.]/g, '-'); }

  // ── blueprint and sign-off ───────────────────────────────────────────────

  async summary(i: { blueprint: string; site?: string }) {
    const bp = await this.loadBlueprint(i.blueprint);
    const byType: Record<string, number> = {};
    const byStrategy: Record<string, number> = {};
    for (const el of bp.design) {
      byType[el.type] = (byType[el.type] ?? 0) + 1;
      const s = strategyOf(el).strategy;
      byStrategy[s] = (byStrategy[s] ?? 0) + 1;
    }
    const site = this.siteFor(bp, i.site);
    const state = site ? await this.loadState(bp, site) : undefined;
    return {
      id: bp.id, name: bp.name, customer: bp.customer.name, signedOff: isSignedOff(bp), site: site ?? null,
      writeAllowed: site ? this.writeAllowed(site) : false,
      capabilities: bp.capabilities.map((c) => ({ id: c.capabilityId, status: (c as { status?: string }).status })),
      outcomes: bp.outcomes.map((o) => ({ id: o.id, capabilityId: o.capabilityId, statement: o.statement })),
      design: { total: bp.design.length, byType, byStrategy },
      spaces: bp.design.flatMap((d) => (d.type === 'space' ? [{ designId: d.id, name: d.spec.name, mode: d.spec.mode, key: d.spec.key ?? null }] : [])),
      built: state ? Object.keys(state.elements).length : 0,
    };
  }

  /**
   * Choose where a space is built: a new space from the template (optionally with a name and key), or an existing
   * space by key. Edits the blueprint and records the change as a decision, so a prior sign-off goes stale.
   */
  async setSpace(i: { blueprint: string; designId?: string; mode: 'new' | 'existing'; key?: string; name?: string; reason?: string }) {
    const bp = await this.loadBlueprint(i.blueprint);
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
    const saved = await this.saveBlueprint(i.blueprint, {
      ...bp, updatedAt: at,
      design: bp.design.map((d) => (d.id === el.id ? { ...d, ...(i.name && d.name === el.spec.name ? { name: spec.name } : {}), spec } : d)),
      decisions: [...bp.decisions, { id: `d.space.${el.id}.${at.replace(/[^0-9]/g, '')}`, at, by: this.cfg.by, subject: { kind: 'design-element' as const, id: el.id }, action: 'change' as const, comment: i.reason ?? `target space: ${i.mode}${key ? ` ${key}` : ''}`, before, after }],
    }, 'change');
    return {
      designId: el.id, before, after, signedOff: isSignedOff(saved),
      next: `${wasSigned ? 'The earlier sign-off no longer covers the design: sign off again before apply. ' : ''}Run build_plan with dryRun to check the space on the site.`,
    };
  }

  /** Offline: what a sign-off would approve, pinned in a signHash a person must quote back. */
  async signOffReview(i: { blueprint: string }) {
    const bp = await this.loadBlueprint(i.blueprint);
    const signHash = hashOf(signOffContent(bp));
    const file = await this.write(`signoff/${safeName(bp.id)}-${signHash.slice(0, 12)}.md`, renderSignOff(bp, signHash));
    return {
      blueprint: bp.id, signHash, signedOff: isSignedOff(bp),
      capabilities: bp.capabilities.map((c) => ({ id: c.capabilityId, catalogueVersion: c.catalogueVersion, status: c.status })),
      outcomes: bp.outcomes.map((o) => ({
        id: o.id, category: o.category, statement: o.statement, priority: o.priority, status: o.status, parameters: o.parameters,
        criteria: o.acceptance.map((ac) => ({ id: ac.id, verification: ac.verification, given: ac.given, when: ac.when, then: ac.then })),
      })),
      designElements: bp.design.length,
      files: { markdown: file },
      phrase: signOffPhrase(signHash, bp.id),
      signOff: `Show these outcomes to the person accountable for them. To sign off they type exactly: ${signOffPhrase(signHash, bp.id)} (open outcomes are confirmed unless named as rejected or deferred).`,
    };
  }

  /** Record a person's sign-off: one decision per outcome, then the blueprint sign-off. Refused if anything changed since the review. */
  async signOff(i: { blueprint: string; signHash: string; confirm: string; reject?: string[]; defer?: string[]; reinstate?: string[]; comment?: string }) {
    const bp = await this.loadBlueprint(i.blueprint);
    const wasSigned = isSignedOff(bp);
    const current = hashOf(signOffContent(bp));
    if (current !== i.signHash) throw new Error(`the blueprint changed since it was reviewed (signHash is now ${current}): run signoff_review again and re-check the outcomes`);
    const phrase = signOffPhrase(current, bp.id);
    if (i.confirm.trim() !== phrase) throw new Error(`to sign off, the person must type exactly: ${phrase}`);

    const ids = new Set(bp.outcomes.map((o) => o.id));
    const reject = new Set(i.reject ?? []);
    const defer = new Set(i.defer ?? []);
    const reinstate = new Set(i.reinstate ?? []);
    for (const id of [...reject, ...defer, ...reinstate]) if (!ids.has(id)) throw new Error(`no outcome ${id} in ${bp.id}`);
    const both = [...reject, ...defer, ...reinstate].filter((id, n, all) => all.indexOf(id) !== n);
    if (both.length) throw new Error(`an outcome can only be rejected, deferred or reinstated once: ${[...new Set(both)].join(', ')}`);

    const at = new Date().toISOString();
    const stamp = at.replace(/[^0-9]/g, '');
    const decisions: Blueprint['decisions'] = [];
    const outcomes = bp.outcomes.map((o) => {
      const to = reject.has(o.id) ? 'rejected' : defer.has(o.id) ? 'deferred' : reinstate.has(o.id) || OPEN_OUTCOME.has(o.status) ? 'confirmed' : o.status;
      if (to === o.status) return o;
      const action = to === 'rejected' ? 'reject' : to === 'deferred' ? 'defer' : 'confirm';
      decisions.push({ id: `d.outcome.${o.id}.${stamp}`, at, by: this.cfg.by, subject: { kind: 'outcome', id: o.id }, action, before: { status: o.status }, after: { status: to } });
      return { ...o, status: to };
    });
    const by = (s: string) => outcomes.filter((o) => o.status === s).map((o) => o.id);
    const result = { confirmed: by('confirmed'), rejected: by('rejected'), deferred: by('deferred') };
    if (wasSigned && !decisions.length) throw new Error(`${bp.id} is already signed off and unchanged since: name outcomes to reject, defer or reinstate to amend it`);
    if (!result.confirmed.length) throw new Error('nothing to sign off: every outcome would be rejected or deferred');
    decisions.push({
      id: `d.sign-off.${bp.id}.${stamp}`, at, by: this.cfg.by, subject: { kind: 'blueprint', id: bp.id }, action: 'sign-off',
      ...(i.comment ? { comment: i.comment } : {}), after: { signHash: current, ...result, ...(wasSigned ? { amends: true } : {}) },
    });

    const saved = await this.saveBlueprint(i.blueprint, { ...bp, updatedAt: at, outcomes, decisions: [...bp.decisions, ...decisions] }, 'sign-off');
    return {
      blueprint: bp.id, signedOff: isSignedOff(saved), by: this.cfg.by, at, signHash: current, ...result,
      next: `Signed off. Any later design change makes the sign-off stale.${result.rejected.length || result.deferred.length ? ' Rejected and deferred outcomes are excluded from acceptance tests; their design elements are still in the blueprint.' : ''} Run build_plan with dryRun before the next apply.`,
    };
  }

  // ── build ────────────────────────────────────────────────────────────────

  async plan(i: BlueprintInput & { dryRun?: boolean }) {
    const bp = await this.loadBlueprint(i.blueprint);
    const site = i.dryRun ? this.needSite(bp, i.site) : this.siteFor(bp, i.site);
    const state = site ? await this.loadState(bp, site) : undefined;
    const p = await plan({
      bp, ...(state ? { state } : {}), scope: scopeOf(i), ...(i.dryRun ? { api: this.cfg.clientFor(site!, true), prior: await this.priorStates(bp, site!) } : {}),
      ...(this.cfg.options ? { options: this.cfg.options } : {}),
    });
    if (site) p.site = site;
    const md = renderPlan(p);
    const jsonFile = await this.write(this.planFile(bp, site, p.planHash, 'json'), JSON.stringify(p, null, 2));
    const mdFile = await this.write(this.planFile(bp, site, p.planHash, 'md'), md);
    const canApply = p.mode === 'dry-run' && Boolean(site && this.writeAllowed(site));
    return {
      planHash: p.planHash, mode: p.mode, site: site ?? null, summary: p.summary, warnings: p.warnings, files: { json: jsonFile, markdown: mdFile },
      carried: p.carried ?? [],
      signedOff: isSignedOff(bp),
      phrase: canApply ? confirmPhrase(p.planHash, site!) : null,
      apply: p.mode !== 'dry-run'
        ? 'offline plan: run a dry-run against the site before apply'
        : canApply
          ? `To build, a person must review this dry-run and type exactly: ${confirmPhrase(p.planHash, site!)}`
          : `apply is disabled for ${site} (not in ${this.writeHint})`,
      markdown: clip(md, mdFile),
    };
  }

  /** The dry-run a person reviewed, or a refusal explaining why apply cannot use it. */
  async reviewedPlan(bp: Blueprint, site: string, planHash: string): Promise<Plan> {
    const prior = await this.readJson<Plan>(this.planFile(bp, site, planHash, 'json'));
    if (!prior) throw new Error(`apply refused: no dry-run with plan ${planHash} for ${site}; run build_plan with dryRun first`);
    if (prior.mode !== 'dry-run' || prior.planHash !== planHash) throw new Error(`apply refused: plan ${planHash} was not a dry-run`);
    return prior;
  }

  /** Every check apply makes before it touches the site, without doing it (for UIs that queue the work). */
  async checkApply(i: BlueprintInput & { planHash: string; confirm: string }) {
    const bp = await this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    if (!this.writeAllowed(site)) throw new Error(`apply refused: ${site} is not in ${this.writeHint} (${this.cfg.writeSites.join(', ') || 'empty: apply disabled'})`);
    if (i.confirm.trim() !== confirmPhrase(i.planHash, site)) throw new Error(`apply refused: confirmation must be exactly "${confirmPhrase(i.planHash, site)}", typed by the person who reviewed the dry-run`);
    await this.reviewedPlan(bp, site, i.planHash);
    if (!isSignedOff(bp) && !this.cfg.allowUnsigned) throw new Error(`apply refused: ${bp.id} is not signed off (or a design change made the sign-off stale)`);
    return { bp, site };
  }

  async apply(i: BlueprintInput & { planHash: string; confirm: string }) {
    const { bp, site } = await this.checkApply(i);
    const statePath = this.statePath(bp, site);
    return this.store.lock(statePath, async () => {
      const state = (await this.loadState(bp, site)) ?? newState(bp.id, site);
      const writer = this.persister(statePath);
      try {
        const res = await apply({
          bp, state, api: this.cfg.clientFor(site, false), readApi: this.cfg.clientFor(site, true), approvedPlanHash: i.planHash, prior: await this.priorStates(bp, site),
          scope: scopeOf(i), allowUnsigned: this.cfg.allowUnsigned, by: this.cfg.by, persist: writer.persist,
          ...(this.cfg.options ? { options: this.cfg.options } : {}),
        });
        await writer.flush();
        await this.saveState(statePath, state);
        const md = renderApply(res);
        const file = await this.write(`runs/${safeName(bp.id)}@${hostOf(site)}-${this.stamp()}.md`, md);
        return {
          planHash: res.planHash, summary: res.summary, report: file, state: statePath,
          failed: res.results.filter((r) => r.result === 'failed').map((r) => ({ designId: r.designId, detail: r.detail })),
          guidedSteps: res.manual.length, markdown: clip(md, file),
        };
      } finally {
        await writer.flush().catch(() => undefined);
      }
    });
  }

  async manualSteps(i: BlueprintInput) {
    const bp = await this.loadBlueprint(i.blueprint);
    const site = this.siteFor(bp, i.site);
    const steps = await pendingManual(bp, site ? await this.loadState(bp, site) : undefined, scopeOf(i));
    const md = steps.length ? steps.map((m, n) => renderManual(m, n + 1)).join('\n\n') : 'No guided steps pending.';
    return {
      count: steps.length,
      steps: steps.map((s) => ({ designId: s.designId, title: s.title, record: s.record, markdown: renderManual(s, 0) })),
      markdown: clip(md),
    };
  }

  async confirmManual(i: { blueprint: string; site?: string; designId: string; remoteId?: string; remoteKey?: string; note?: string }) {
    const bp = await this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    const statePath = this.statePath(bp, site);
    return this.store.lock(statePath, async () => {
      const state = (await this.loadState(bp, site)) ?? newState(bp.id, site);
      const el = confirmManual(bp, state, { designId: i.designId, by: this.cfg.by, ...(i.remoteId ? { remoteId: i.remoteId } : {}), ...(i.remoteKey ? { remoteKey: i.remoteKey } : {}), ...(i.note ? { note: i.note } : {}) });
      await this.saveState(statePath, state);
      return { designId: el.designId, status: el.status, remote: el.remote ?? null, next: 'run build_plan (dry-run) again: elements waiting on this one are now unblocked' };
    });
  }

  async verify(i: BlueprintInput) {
    const bp = await this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    const statePath = this.statePath(bp, site);
    return this.store.lock(statePath, async () => {
      const state = await this.loadState(bp, site);
      if (!state) throw new Error(`nothing built on ${site} yet (no state file)`);
      const report = await verify(bp, state, this.cfg.clientFor(site, true), scopeOf(i));
      await this.saveState(statePath, state);
      const md = renderVerify(report);
      const file = await this.write(`runs/${safeName(bp.id)}@${hostOf(site)}-verify-${report.at.replace(/[:.]/g, '-')}.md`, md);
      return { summary: report.summary, report: file, problems: report.results.filter((r) => !['ok', 'unverifiable'].includes(r.status)).map((r) => ({ designId: r.designId, status: r.status, detail: r.detail })), markdown: clip(md, file) };
    });
  }

  async status(i: { blueprint: string; site?: string }) {
    const bp = await this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    const state = await this.loadState(bp, site);
    const byStatus: Record<string, number> = {};
    for (const e of Object.values(state?.elements ?? {})) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1;
    const inScope = scopeElements(bp).length;
    return {
      site, blueprintId: bp.id, stateFile: this.statePath(bp, site), exists: Boolean(state),
      elements: { inDesign: inScope, recorded: Object.keys(state?.elements ?? {}).length, byStatus },
      failed: Object.values(state?.elements ?? {}).filter((e) => e.status === 'failed').map((e) => ({ designId: e.designId, error: e.error })),
      lastRuns: (state?.runs ?? []).slice(-5),
    };
  }

  // ── acceptance tests ─────────────────────────────────────────────────────

  /** Per-site test config: acceptance/<host>.json (persona account ids, existing objects to use as fixtures). */
  private async testConfig(site: string): Promise<TestConfig> {
    const key = `acceptance/${hostOf(site)}.json`;
    const c = await this.readJson<TestConfig>(key);
    if (c === undefined) return {};
    if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new Error(`${key} must be a JSON object`);
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
    return `tests/${safeName(bp.id)}@${hostOf(site)}-${name}`;
  }

  private async makeAcceptancePlan(bp: Blueprint, site: string, outcomeIds?: string[]): Promise<AcceptancePlan> {
    return planAcceptance({
      bp, state: await this.loadState(bp, site), site, config: await this.testConfig(site),
      actors: Object.keys(this.personaClients(site)), ...(outcomeIds?.length ? { outcomeIds } : {}),
    });
  }

  /** Offline: which acceptance criteria can run now, what blocks the rest, and the phrase to run them. */
  async acceptancePlan(i: { blueprint: string; site?: string; outcomeIds?: string[] }) {
    const bp = await this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    const p = await this.makeAcceptancePlan(bp, site, i.outcomeIds);
    const canRun = this.writeAllowed(site) && p.summary.ready > 0;
    const md = renderAcceptancePlan(p, canRun ? testPhrase(p.runHash, site) : undefined);
    const json = await this.write(this.testFile(bp, site, `plan-${p.runHash.slice(0, 12)}.json`), JSON.stringify({ ...p, outcomeIds: i.outcomeIds ?? [] }, null, 2));
    const mdFile = await this.write(this.testFile(bp, site, `plan-${p.runHash.slice(0, 12)}.md`), md);
    return {
      runHash: p.runHash, site, summary: p.summary, files: { json, markdown: mdFile },
      criteria: p.criteria.map((c) => ({ acId: c.acId, outcomeId: c.outcomeId, status: c.status, reasons: c.reasons })),
      blocked: p.criteria.filter((c) => c.status === 'blocked').map((c) => ({ acId: c.acId, reasons: c.reasons })),
      phrase: canRun ? testPhrase(p.runHash, site) : null,
      run: !p.summary.ready
        ? 'nothing is ready to run: finish the blocking guided steps (build_manual_steps) or add persona credentials, then plan again'
        : canRun
          ? `To run the ${p.summary.ready} ready check(s), a person must review this plan and type exactly: ${testPhrase(p.runHash, site)}`
          : `acceptance runs are disabled for ${site} (not in ${this.writeHint})`,
      markdown: clip(md, mdFile),
    };
  }

  /** Run the ready criteria of a reviewed plan. Gated like apply; refuses if the plan would differ now. */
  async acceptanceRun(i: { blueprint: string; site?: string; runHash: string; confirm: string; keep?: boolean }) {
    const bp = await this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    if (!this.writeAllowed(site)) throw new Error(`acceptance run refused: ${site} is not in ${this.writeHint} (${this.cfg.writeSites.join(', ') || 'empty: writes disabled'})`);
    if (i.confirm.trim() !== testPhrase(i.runHash, site)) throw new Error(`acceptance run refused: confirmation must be exactly "${testPhrase(i.runHash, site)}", typed by the person who reviewed the test plan`);
    const reviewedKey = this.testFile(bp, site, `plan-${i.runHash.slice(0, 12)}.json`);
    const prior = await this.readJson<AcceptancePlan & { outcomeIds?: string[] }>(reviewedKey);
    if (!prior) throw new Error(`acceptance run refused: no test plan ${i.runHash} for ${site}; run acceptance_plan first`);
    if (prior.runHash !== i.runHash) throw new Error(`acceptance run refused: ${reviewedKey} is not plan ${i.runHash}`);
    const statePath = this.statePath(bp, site);
    return this.store.lock(statePath, async () => {
      const state = await this.loadState(bp, site);
      if (!state) throw new Error(`nothing built on ${site} yet (no state file)`);
      const fresh = await this.makeAcceptancePlan(bp, site, prior.outcomeIds);
      if (fresh.runHash !== i.runHash) throw new Error(`acceptance run refused: the test plan changed since it was reviewed (now ${fresh.runHash}); review the new plan`);
      if (!fresh.summary.ready) throw new Error('acceptance run refused: no criteria are ready to run');
      const clock = this.cfg.acceptance?.clock;
      const runId = new Date(clock?.now() ?? Date.now()).toISOString().replace(/\D/g, '').slice(0, 14);
      const ledgerFile = this.testFile(bp, site, `run-${runId}.ledger.json`);
      const res = await runAcceptance({
        plan: fresh, bp, state, api: this.cfg.clientFor(site, false), personas: this.personaClients(site), config: await this.testConfig(site),
        runId, ...(i.keep ? { keep: true } : {}), ...(clock ? { clock } : {}),
        ...(this.cfg.acceptance?.defaultWithinSeconds !== undefined ? { defaultWithinSeconds: this.cfg.acceptance.defaultWithinSeconds } : {}),
        ...(this.cfg.acceptance?.pollSeconds !== undefined ? { pollSeconds: this.cfg.acceptance.pollSeconds } : {}),
      });
      await this.write(ledgerFile, JSON.stringify(res.ledger, null, 2));
      const md = renderAcceptanceResult(res);
      const jsonFile = await this.write(this.testFile(bp, site, `run-${runId}.json`), JSON.stringify(res, null, 2));
      const mdFile = await this.write(this.testFile(bp, site, `run-${runId}.md`), md);
      const s = res.summary;
      state.runs.push({ id: `acceptance-${runId}`, op: 'acceptance', at: res.finishedAt, planHash: res.runHash, summary: `${s.pass} pass, ${s.partial} partial, ${s.fail} fail, ${s.error} error, ${s.blocked} blocked, ${s.manual} manual` });
      await this.saveState(statePath, state);
      const left = res.ledger.cleanup?.leftovers ?? [];
      return {
        runId, runHash: res.runHash, summary: res.summary, files: { json: jsonFile, markdown: mdFile, ledger: ledgerFile },
        outcomes: res.outcomes.map((o) => ({ outcomeId: o.outcomeId, verdict: o.verdict, criteria: o.criteria.map((c) => ({ acId: c.acId, verdict: c.verdict })) })),
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
    const bp = await this.loadBlueprint(i.blueprint);
    const site = this.needSite(bp, i.site);
    if (!this.writeAllowed(site)) throw new Error(`cleanup refused: ${site} is not in ${this.writeHint}`);
    if (!/^\d{14}$/.test(i.runId)) throw new Error(`invalid run id ${i.runId}`);
    if (i.confirm.trim() !== cleanupPhrase(i.runId, site)) throw new Error(`cleanup refused: confirmation must be exactly "${cleanupPhrase(i.runId, site)}"`);
    const file = this.testFile(bp, site, `run-${i.runId}.ledger.json`);
    const ledger = await this.readJson<TestDataLedger>(file);
    if (!ledger) throw new Error(`no test-data ledger for run ${i.runId} on ${site}`);
    if (ledger.site !== site || ledger.blueprintId !== bp.id) throw new Error(`ledger ${file} belongs to ${ledger.blueprintId} on ${ledger.site}`);
    const pending: TestDataLedger = { ...ledger, requests: ledger.requests.filter((r) => !ledger.cleanup?.removed.includes(r.key)), objects: ledger.objects.filter((o) => !ledger.cleanup?.removed.includes(o.key ?? o.id)) };
    const done = await cleanupTestData(this.cfg.clientFor(site, false), pending, this.cfg.acceptance?.clock);
    ledger.cleanup = { at: done!.at, removed: [...new Set([...(ledger.cleanup?.removed ?? []), ...done!.removed])], leftovers: done!.leftovers };
    await this.write(file, JSON.stringify(ledger, null, 2));
    return { runId: i.runId, removed: done!.removed, leftovers: done!.leftovers, ledger: file };
  }

  async workBreakdown(i: BlueprintInput) {
    const bp = await this.loadBlueprint(i.blueprint);
    const site = this.siteFor(bp, i.site);
    const state = site ? await this.loadState(bp, site) : undefined;
    const p = await plan({ bp, ...(state ? { state } : {}), scope: scopeOf(i) });
    return { epics: workBreakdown(bp, p) };
  }

  /** Read a report or review written by this workflow (plans/, runs/, signoff/, tests/), for UIs. */
  async readReport(key: string): Promise<string> {
    if (!/^(plans|runs|signoff|tests)\//.test(key) || !key.endsWith('.md')) throw new Error(`not a report: ${key}`);
    const t = await this.store.read(key);
    if (t === undefined) throw new Error(`report ${key} not found`);
    return t;
  }
}
