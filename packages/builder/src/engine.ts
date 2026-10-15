import { dependenciesOf, type Blueprint, type DesignElement } from '@snjsm/model';
import { buildabilityOf } from '@snjsm/reference';
import { handlerFor } from './handlers';
import { isExistingSpace, isProvided, isTemplateProvided } from './handlers/util';
import { hashOf, stableStringify } from './hash';
import {
  BlockedError, type Action, type BuildOptions, type BuildState, type Change, type ElementState, type HandlerContext, type ManualStep,
  type Plan, type PlanStep, type Remote, type SiteApi, type Strategy, type VerifyReport, type VerifyResult, type VerifyStatus,
} from './types';

export interface Scope { capabilityIds?: string[]; elementIds?: string[] }

// ── Scope and strategy ────────────────────────────────────────────────────

/** Capabilities each element serves: through the outcomes it delivers, else through the elements that depend on it. */
export function capabilitiesOf(bp: Blueprint): Map<string, string[]> {
  const outcomeCap = new Map(bp.outcomes.map((o) => [o.id, o.capabilityId]));
  const caps = new Map<string, Set<string>>(bp.design.map((el) => [el.id, new Set(el.deliversOutcomeIds.map((o) => outcomeCap.get(o)).filter((c): c is string => Boolean(c)))]));
  // Propagate to dependencies until stable (shared elements serve every capability that needs them).
  for (let changed = true; changed;) {
    changed = false;
    for (const el of bp.design) for (const d of dependenciesOf(el)) {
      const target = caps.get(d);
      if (!target) continue;
      for (const c of caps.get(el.id) ?? []) if (!target.has(c)) { target.add(c); changed = true; }
    }
  }
  return new Map([...caps].map(([k, v]) => [k, [...v]]));
}

/** Elements in scope plus everything they depend on, in build order. */
export function scopeElements(bp: Blueprint, scope: Scope = {}): DesignElement[] {
  const byId = new Map(bp.design.map((e) => [e.id, e]));
  let roots = bp.design;
  if (scope.capabilityIds?.length || scope.elementIds?.length) {
    const caps = capabilitiesOf(bp);
    roots = bp.design.filter((e) => scope.elementIds?.includes(e.id) || (caps.get(e.id) ?? []).some((c) => scope.capabilityIds?.includes(c)));
    const unknown = (scope.elementIds ?? []).filter((id) => !byId.has(id));
    if (unknown.length) throw new Error(`unknown design elements: ${unknown.join(', ')}`);
  }
  const keep = new Set<string>();
  const visit = (id: string) => {
    if (keep.has(id) || !byId.has(id)) return;
    keep.add(id);
    for (const d of depsOf(byId.get(id)!, bp)) visit(d);
  };
  roots.forEach((r) => visit(r.id));
  return orderElements(bp.design.filter((e) => keep.has(e.id)), bp);
}

export { isProvided, isTemplateProvided };

/** Declared dependencies plus implicit ones: template-provided elements exist only once their space exists. */
export function depsOf(el: DesignElement, bp: Blueprint): string[] {
  const d = dependenciesOf(el);
  return isTemplateProvided(el) ? [...new Set([...d, ...bp.design.filter((x) => x.type === 'space').map((x) => x.id)])] : d;
}

/** Topological order (Kahn), stable by blueprint position. Throws on cycles. */
export function orderElements(els: DesignElement[], bp: Blueprint): DesignElement[] {
  const ids = new Set(els.map((e) => e.id));
  const pos = new Map(bp.design.map((e, i) => [e.id, i]));
  const indeg = new Map(els.map((e) => [e.id, depsOf(e, bp).filter((d) => ids.has(d) && d !== e.id).length]));
  const out: DesignElement[] = [];
  const ready = els.filter((e) => indeg.get(e.id) === 0);
  while (ready.length) {
    ready.sort((a, b) => pos.get(a.id)! - pos.get(b.id)!);
    const e = ready.shift()!;
    out.push(e);
    for (const x of els) if (x.id !== e.id && depsOf(x, bp).includes(e.id)) { const n = indeg.get(x.id)! - 1; indeg.set(x.id, n); if (n === 0) ready.push(x); }
  }
  if (out.length !== els.length) throw new Error(`dependency cycle among: ${els.filter((e) => !out.includes(e)).map((e) => e.id).join(', ')}`);
  return out;
}

export function strategyOf(el: DesignElement): { strategy: Strategy; aspects: string[]; coverage: ReturnType<typeof buildabilityOf>['status'] } {
  const h = handlerFor(el.type);
  const b = buildabilityOf(el);
  const aspects = h.manualAspects?.(el) ?? [];
  const createEntry = b.entries.find((e) => e.operation === 'create');
  const apiCreate = h.canCreate(el) && (createEntry ? createEntry.status === 'api' || createEntry.status === 'partial' : false);
  if (isProvided(el) && h.discover) return { strategy: 'adopt', aspects, coverage: b.status };
  if (apiCreate) return { strategy: aspects.length ? 'create+manual' : 'create', aspects, coverage: b.status };
  return { strategy: 'manual', aspects: [], coverage: b.status };
}

export const specHashOf = (el: DesignElement) => hashOf({ type: el.type, name: el.name, spec: el.spec, dependsOn: el.dependsOn });

// ── Context ───────────────────────────────────────────────────────────────

const READ_ONLY_API: SiteApi = {
  siteUrl: 'offline', readOnly: true,
  jira: () => Promise.reject(new Error('offline')), jsm: () => Promise.reject(new Error('offline')),
  assets: () => Promise.reject(new Error('offline')), call: () => Promise.reject(new Error('offline')), cloudId: () => Promise.reject(new Error('offline')),
};

function makeCtx(api: SiteApi, bp: Blueprint, el: DesignElement, state: BuildState | undefined, run: Map<string, Remote>, cache: Map<string, unknown>, options: BuildOptions): HandlerContext {
  const remoteOf = (id: string) => run.get(id) ?? state?.elements[id]?.remote;
  return {
    api, bp, el, cache, options, remoteOf,
    need: (id) => { const r = remoteOf(id); if (!r) throw new BlockedError(id); return r; },
    ref: (id, pick) => { const r = remoteOf(id); return (r && (pick ? pick(r) : r.id)) ?? `<${id}>`; },
  };
}

export function diff(want: Record<string, unknown>, have: Record<string, unknown>, canUpdate: boolean): Change[] {
  const out: Change[] = [];
  for (const [k, w] of Object.entries(want)) {
    const h = have[k];
    if (k === 'options' && Array.isArray(w)) {
      const missing = w.filter((x) => !((h as unknown[] | undefined) ?? []).includes(x));
      if (missing.length) out.push({ path: k, want: w, have: h, fixable: canUpdate });
      continue; // extra options on the site are left alone (additive only)
    }
    if (typeof w === 'string' && typeof h === 'string' ? w.trim().toLowerCase() !== h.trim().toLowerCase() : stableStringify(w) !== stableStringify(h)) out.push({ path: k, want: w, have: h, fixable: false });
  }
  return out;
}

const DONE: ElementState['status'][] = ['created', 'adopted', 'updated', 'manual-done'];

// ── Plan / dry-run ────────────────────────────────────────────────────────

export interface PlanInput {
  bp: Blueprint;
  state?: BuildState;
  scope?: Scope;
  /** Read-only site access for a dry-run. Without it the plan is offline (from the state file only). */
  api?: SiteApi;
  options?: BuildOptions;
  now?: string;
}

export async function plan(input: PlanInput): Promise<Plan> {
  const { bp, state, scope = {}, options = {} } = input;
  const live = Boolean(input.api);
  const api = input.api ?? READ_ONLY_API;
  if (live && !api.readOnly) throw new Error('dry-run must use a read-only client');
  const elements = scopeElements(bp, scope);
  const caps = capabilitiesOf(bp);
  const run = new Map<string, Remote>();
  const cache = new Map<string, unknown>();
  const warnings: string[] = [];
  const steps: PlanStep[] = [];
  const byId = new Map<string, PlanStep>();

  for (const el of elements) {
    const h = handlerFor(el.type);
    const { strategy, aspects, coverage } = strategyOf(el);
    const st = state?.elements[el.id];
    const specHash = specHashOf(el);
    const ctx = makeCtx(api, bp, el, state, run, cache, options);
    const deps = depsOf(el, bp);
    const s: PlanStep = { designId: el.id, type: el.type, name: el.name, capabilityIds: caps.get(el.id) ?? [], strategy, action: 'noop', reason: '', coverage, specHash, dependsOn: deps };
    const pendingAspects = st?.manualPending ?? (st ? [] : aspects);

    const decide = (action: Action, reason: string) => { s.action = action; s.reason = reason; };
    try {
      if (st && st.remote && live && h.observe) {
        const seen = await h.observe(ctx, st.remote);
        if (!seen) decide(h.canCreate(el) && strategy !== 'manual' ? 'create' : 'manual', `was built (${st.remote.id}) but is no longer on the site`);
        else {
          const ch = h.desired ? diff(h.desired(ctx), seen, Boolean(h.update)) : [];
          if (ch.length) { s.changes = ch; decide(ch.every((c) => c.fixable) ? 'update' : 'manual', `differs from the design: ${ch.map((c) => c.path).join(', ')}`); }
          else if (pendingAspects.length) decide('manual', `guided steps pending: ${pendingAspects.join(', ')}`);
          else decide('noop', 'built and matches the design');
        }
        s.remote = st.remote;
      } else if (st && DONE.includes(st.status) && st.specHash === specHash) {
        s.remote = st.remote;
        if (pendingAspects.length) decide('manual', `guided steps pending: ${pendingAspects.join(', ')}`);
        else decide('noop', st.status === 'manual-done' ? `done by hand${st.by ? ` (${st.by})` : ''}` : 'already built');
      } else if (st && DONE.includes(st.status)) {
        s.remote = st.remote;
        decide(h.update ? 'update' : 'manual', 'the design changed since it was built');
      } else if (st?.status === 'manual-pending') {
        decide('manual', 'guided step not confirmed yet');
      } else {
        let found: Remote | undefined;
        if (live && h.discover) found = await h.discover(ctx);
        if (found) {
          run.set(el.id, found);
          s.remote = found;
          if (h.desired && h.observe) {
            const seen = await h.observe(ctx, found);
            const ch = seen ? diff(h.desired(ctx), seen, Boolean(h.update)) : [];
            if (ch.length) s.changes = ch;
          }
          decide('adopt', `exists on the site (${found.key ?? found.id})${s.changes?.length ? `; differs: ${s.changes.map((c) => c.path).join(', ')}` : ''}`);
        } else if (strategy === 'adopt') {
          const parentPending = deps.some((d) => byId.get(d) && byId.get(d)!.action !== 'noop' && byId.get(d)!.action !== 'adopt');
          if (!live || parentPending) decide('adopt', isExistingSpace(el) ? `existing space ${el.spec.key}: bound on the dry-run` : 'provided by the template: bound after its space exists');
          else if (h.canCreate(el)) { decide('create', 'expected from the template but not found: will create'); warnings.push(`${el.id}: expected from the template but not found`); }
          else { decide('manual', 'expected from the template but not found'); warnings.push(`${el.id}: expected from the template but not found`); }
        } else if (strategy === 'manual') decide('manual', coverage === 'unknown' ? 'API not verified: guided step' : 'no public API: guided step');
        else decide('create', strategy === 'create+manual' ? `API create, then guided steps: ${aspects.join(', ')}` : 'API create');
      }
    } catch (e) {
      if (e instanceof BlockedError) decide(strategy === 'manual' ? 'manual' : strategy === 'adopt' ? 'adopt' : 'create', `after ${e.designId}`);
      else { warnings.push(`${el.id}: ${(e as Error).message}`); decide(strategy === 'manual' ? 'manual' : strategy === 'adopt' ? 'adopt' : 'create', `could not read the site: ${(e as Error).message}`); }
    }

    // Pre-build check against the live site: conflicts block the step (and so its dependents); resolved values
    // (e.g. a free space key) are shown in the plan and are part of the plan hash.
    if (live && h.check && !st && s.action !== 'noop') {
      try {
        const c = await h.check(ctx, s.remote);
        if (c?.resolved && Object.keys(c.resolved).length) s.resolved = c.resolved;
        if (c?.note) s.reason = `${s.reason}; ${c.note}`;
        if (c?.problem) {
          s.action = 'blocked';
          s.reason = c.problem;
          warnings.push(`${el.id}: ${c.problem}`);
          run.delete(el.id);
          delete s.remote;
        }
      } catch (e) {
        if (!(e instanceof BlockedError)) warnings.push(`${el.id}: check failed: ${(e as Error).message}`);
      }
    }

    // Blocked: an API step that needs the id of something a person still has to build.
    if (['create', 'adopt', 'update'].includes(s.action)) {
      const waits = deps.filter((d) => { const p = byId.get(d); return p && (p.action === 'blocked' || (p.action === 'manual' && !p.remote && p.manual?.record === 'remote-id')); });
      if (waits.length) { s.blockedBy = waits; s.reason = `${s.reason}; waits for ${waits.join(', ')}`; s.action = 'blocked'; }
    }
    if (s.action === 'create' || s.action === 'blocked') s.requests = h.preview?.(ctx);
    if (s.action === 'manual' || ((s.action === 'create' || s.action === 'adopt') && pendingAspects.length)) {
      const manualAspects = s.action === 'manual' && !pendingAspects.length && !s.remote ? [] : pendingAspects;
      s.manual = h.manual(ctx, s.changes?.some((c) => !c.fixable) ? [...manualAspects, ...s.changes.filter((c) => !c.fixable).map((c) => `set ${c.path} to ${JSON.stringify(c.want)}`)] : manualAspects);
    }
    steps.push(s);
    byId.set(el.id, s);
  }

  const summary = { noop: 0, adopt: 0, create: 0, update: 0, manual: 0, blocked: 0 } as Record<Action, number>;
  for (const s of steps) summary[s.action]++;
  return {
    blueprintId: bp.id, ...(live ? { site: api.siteUrl } : {}), mode: live ? 'dry-run' : 'offline', createdAt: input.now ?? new Date().toISOString(),
    scope, steps, planHash: planHashOf(steps), summary, warnings,
  };
}

export const planHashOf = (steps: PlanStep[]) => hashOf(steps.map((s) => [s.designId, s.action, s.specHash, s.remote?.id ?? null, s.resolved ?? null]));

// ── Apply ─────────────────────────────────────────────────────────────────

/** Signed off, and nothing in the design was changed after the latest sign-off. */
export function isSignedOff(bp: Blueprint): boolean {
  const signed = bp.decisions.filter((d) => d.subject.kind === 'blueprint' && d.action === 'sign-off').map((d) => d.at).sort().at(-1);
  if (!signed) return false;
  return !bp.decisions.some((d) => d.action === 'change' && d.at > signed);
}

export interface ApplyInput {
  bp: Blueprint;
  state: BuildState;
  /** A write-enabled client for the site pinned in the state. */
  api: SiteApi;
  /** A read-only client for the same site, used to re-run the dry-run before writing. */
  readApi: SiteApi;
  /** planHash of the dry-run a person approved. apply refuses if the fresh dry-run differs. */
  approvedPlanHash: string;
  scope?: Scope;
  options?: BuildOptions;
  /** Allow building before the blueprint is signed off (sandbox demos). */
  allowUnsigned?: boolean;
  by?: string;
  /** Called after every step so a crash never loses progress. */
  persist?: (s: BuildState) => void;
}

export interface ApplyStepResult { designId: string; action: Action; result: 'done' | 'manual' | 'blocked' | 'failed' | 'skipped'; remote?: Remote; detail?: string }
export interface ApplyResult { planHash: string; results: ApplyStepResult[]; summary: Record<ApplyStepResult['result'], number>; manual: ManualStep[] }

export async function apply(input: ApplyInput): Promise<ApplyResult> {
  const { bp, state, api, scope = {}, options = {} } = input;
  if (api.readOnly) throw new Error('apply needs a write-enabled client');
  if (api.siteUrl !== state.site || input.readApi.siteUrl !== state.site) throw new Error(`state is pinned to ${state.site}; refusing to build on ${api.siteUrl}`);
  if (state.blueprintId !== bp.id) throw new Error(`state is for blueprint ${state.blueprintId}, not ${bp.id}`);
  if (!isSignedOff(bp) && !input.allowUnsigned) throw new Error('blueprint is not signed off: record a sign-off decision (or allow unsigned builds for a sandbox)');
  const fresh = await plan({ bp, state, scope, api: input.readApi, options });
  if (fresh.planHash !== input.approvedPlanHash) throw new Error(`the site or design changed since the approved dry-run (approved ${input.approvedPlanHash}, now ${fresh.planHash}). Run dry-run again and review it.`);

  const run = new Map<string, Remote>();
  const cache = new Map<string, unknown>();
  const results: ApplyStepResult[] = [];
  const failed = new Set<string>();
  /** Guided steps whose site id dependents need: those dependents wait. */
  const waiting = new Set<string>();
  const manual: ManualStep[] = [];
  const now = () => new Date().toISOString();
  const save = (id: string, patch: Partial<ElementState> & Pick<ElementState, 'status'>) => {
    const el = bp.design.find((d) => d.id === id)!;
    const prev = state.elements[id];
    state.elements[id] = { ...prev, designId: id, type: el.type, specHash: specHashOf(el), at: now(), ...(input.by ? { by: input.by } : {}), ...patch } as ElementState;
    if (patch.status !== 'failed') delete state.elements[id]!.error;
    input.persist?.(state);
  };

  for (const s of fresh.steps) {
    const el = bp.design.find((d) => d.id === s.designId)!;
    const h = handlerFor(el.type);
    const ctx = makeCtx(api, bp, el, state, run, cache, options);
    const upstream = s.dependsOn.filter((d) => failed.has(d));
    if (upstream.length) { failed.add(s.designId); results.push({ designId: s.designId, action: s.action, result: 'skipped', detail: `dependency failed: ${upstream.join(', ')}` }); continue; }
    const waits = s.dependsOn.filter((d) => waiting.has(d));
    if (waits.length && s.action !== 'manual') { waiting.add(s.designId); results.push({ designId: s.designId, action: s.action, result: 'blocked', detail: `waits for guided step ${waits.join(', ')}` }); continue; }
    try {
      if (s.action === 'noop') { results.push({ designId: s.designId, action: s.action, result: 'done', remote: s.remote, detail: s.reason }); continue; }
      if (s.action === 'blocked') { waiting.add(s.designId); results.push({ designId: s.designId, action: s.action, result: 'blocked', detail: s.reason }); if (s.manual) manual.push(s.manual); continue; }
      if (s.action === 'manual') {
        if (!s.remote) save(s.designId, { status: 'manual-pending' });
        else save(s.designId, { status: state.elements[s.designId]?.status ?? 'adopted', remote: s.remote, manualPending: s.manual ? [s.manual.title] : [] });
        if (s.manual) manual.push(s.manual);
        if (!s.remote && s.manual?.record === 'remote-id') waiting.add(s.designId); // dependents wait for the id
        results.push({ designId: s.designId, action: s.action, result: 'manual', remote: s.remote, detail: s.reason });
        continue;
      }
      let remote: Remote | undefined = s.remote ?? state.elements[s.designId]?.remote;
      let status: ElementState['status'] = 'created';
      if (s.action === 'adopt') {
        remote = remote ?? (await h.discover?.(ctx));
        status = 'adopted';
        if (!remote && h.canCreate(el) && h.create) { remote = await h.create(ctx); status = 'created'; }
        if (!remote) {
          const m = h.manual(ctx, []);
          manual.push(m); save(s.designId, { status: 'manual-pending' }); waiting.add(s.designId);
          results.push({ designId: s.designId, action: s.action, result: 'manual', detail: 'expected from the template but not found' });
          continue;
        }
      } else if (s.action === 'create') {
        if (!h.create) throw new Error(`no API create for ${el.type}`);
        // Create-if-absent: parents built earlier in this run may have brought it along (e.g. an object type's "Name").
        const existing = await h.discover?.(ctx);
        if (existing) { remote = existing; status = 'adopted'; }
        else remote = await h.create(ctx);
      } else if (s.action === 'update') {
        status = 'updated';
      }
      run.set(s.designId, remote!);
      if (s.action === 'adopt' && !s.remote && h.observe && h.desired) {
        // Bound later in this run (its space was just created): compare with the design now.
        const seen = await h.observe(ctx, remote!);
        if (seen) s.changes = diff(h.desired(ctx), seen, Boolean(h.update));
      }
      const fixable = (s.changes ?? []).filter((c) => c.fixable);
      if (fixable.length && h.update) { await h.update(ctx, remote!, fixable); if (status === 'adopted') status = 'updated'; }
      const aspects = [...(state.elements[s.designId]?.manualPending ?? (s.action === 'update' ? [] : strategyOf(el).aspects)), ...(s.changes ?? []).filter((c) => !c.fixable).map((c) => `set ${c.path} to ${JSON.stringify(c.want)}`)];
      save(s.designId, { status, remote, manualPending: aspects });
      if (aspects.length) manual.push(h.manual(ctx, aspects));
      results.push({ designId: s.designId, action: s.action, result: aspects.length ? 'manual' : 'done', remote, detail: aspects.length ? `guided steps: ${aspects.join(', ')}` : s.reason });
    } catch (e) {
      if (e instanceof BlockedError) { waiting.add(s.designId); results.push({ designId: s.designId, action: s.action, result: 'blocked', detail: e.message }); continue; }
      failed.add(s.designId);
      save(s.designId, { status: 'failed', error: (e as Error).message });
      results.push({ designId: s.designId, action: s.action, result: 'failed', detail: (e as Error).message });
    }
  }
  const summary = { done: 0, manual: 0, blocked: 0, failed: 0, skipped: 0 } as ApplyResult['summary'];
  for (const r of results) summary[r.result]++;
  state.runs.push({ id: `run-${state.runs.length + 1}`, op: 'apply', at: now(), planHash: fresh.planHash, summary: Object.entries(summary).map(([k, v]) => `${k} ${v}`).join(', ') });
  input.persist?.(state);
  return { planHash: fresh.planHash, results, summary, manual };
}

// ── Guided steps ──────────────────────────────────────────────────────────

/** Guided steps still waiting for a person, in build order. */
export async function pendingManual(bp: Blueprint, state: BuildState | undefined, scope: Scope = {}): Promise<ManualStep[]> {
  const p = await plan({ bp, state, scope });
  return p.steps.filter((s) => s.manual).map((s) => s.manual!);
}

export interface ConfirmInput { designId: string; by: string; remoteId?: string; remoteKey?: string; note?: string }

/** Record that a person finished a guided step. Steps that dependents need an id for require the id. */
export function confirmManual(bp: Blueprint, state: BuildState, c: ConfirmInput): ElementState {
  const el = bp.design.find((d) => d.id === c.designId);
  if (!el) throw new Error(`unknown design element ${c.designId}`);
  const st = state.elements[c.designId];
  const h = handlerFor(el.type);
  const fakeCtx = makeCtx(READ_ONLY_API, bp, el, state, new Map(), new Map(), {});
  const needsId = !st?.remote && h.manual(fakeCtx, []).record === 'remote-id';
  if (needsId && !c.remoteId) throw new Error(`${c.designId}: record the site id of what was created (other elements need it)`);
  const remote: Remote | undefined = st?.remote ?? (c.remoteId ? { kind: el.type, id: c.remoteId, ...(c.remoteKey ? { key: c.remoteKey } : {}), name: (el.spec as { name?: string }).name ?? el.name } : undefined);
  const next: ElementState = {
    ...st, designId: el.id, type: el.type, specHash: specHashOf(el), at: new Date().toISOString(), by: c.by,
    status: st && st.status !== 'manual-pending' && st.status !== 'failed' ? st.status : 'manual-done', manualPending: [],
    ...(remote ? { remote } : {}), ...(c.note ? { note: c.note } : {}),
  };
  delete next.error;
  state.elements[el.id] = next;
  state.runs.push({ id: `run-${state.runs.length + 1}`, op: 'confirm-manual', at: next.at, summary: `${el.id} confirmed by ${c.by}` });
  return next;
}

// ── Verify ────────────────────────────────────────────────────────────────

/** Build verification: is every element on the site and does it match the design? (Outcome acceptance tests come later.) */
export async function verify(bp: Blueprint, state: BuildState, api: SiteApi, scope: Scope = {}): Promise<VerifyReport> {
  if (!api.readOnly) throw new Error('verify must use a read-only client');
  const cache = new Map<string, unknown>();
  const results: VerifyResult[] = [];
  for (const el of scopeElements(bp, scope)) {
    const st = state.elements[el.id];
    const h = handlerFor(el.type);
    const r = (status: VerifyStatus, detail: string, changes?: Change[]) => results.push({ designId: el.id, type: el.type, name: el.name, status, detail, ...(changes ? { changes } : {}) });
    if (!st) { r('not-built', 'not built yet'); continue; }
    if (st.status === 'failed') { r('error', st.error ?? 'failed'); continue; }
    if (st.status === 'manual-pending' || st.manualPending?.length) { r('pending', `guided steps pending${st.manualPending?.length ? `: ${st.manualPending.join(', ')}` : ''}`); continue; }
    if (st.specHash !== specHashOf(el)) { r('drift', 'the design changed since it was built: run plan'); continue; }
    if (!st.remote || !h.observe) { r('unverifiable', st.status === 'manual-done' ? `confirmed by ${st.by ?? 'a person'} on ${st.at.slice(0, 10)}; no read API to check` : 'no read API to check'); continue; }
    try {
      const ctx = makeCtx(api, bp, el, state, new Map(), cache, {});
      const seen = await h.observe(ctx, st.remote);
      if (!seen) { r('missing', `${st.remote.kind} ${st.remote.id} is no longer on the site`); continue; }
      const ch = h.desired ? diff(h.desired(ctx), seen, false) : [];
      if (ch.length) r('drift', `differs: ${ch.map((c) => `${c.path} (want ${JSON.stringify(c.want)}, have ${JSON.stringify(c.have)})`).join('; ')}`, ch);
      else r('ok', `${st.remote.kind} ${st.remote.key ?? st.remote.id} matches the design`);
    } catch (e) {
      r('error', (e as Error).message);
    }
  }
  const summary = { ok: 0, drift: 0, missing: 0, pending: 0, unverifiable: 0, 'not-built': 0, error: 0 } as Record<VerifyStatus, number>;
  for (const x of results) summary[x.status]++;
  const at = new Date().toISOString();
  for (const x of results) { const st = state.elements[x.designId]; if (st) { st.verifiedAt = at; st.verifyResult = x.status; } }
  state.runs.push({ id: `run-${state.runs.length + 1}`, op: 'verify', at, summary: Object.entries(summary).filter(([, v]) => v).map(([k, v]) => `${k} ${v}`).join(', ') });
  return { site: api.siteUrl, at, results, summary };
}

// ── Work breakdown: one Jira epic per capability ──────────────────────────

export interface WorkItem { summary: string; kind: 'automated' | 'guided'; designIds: string[]; description: string }
export interface EpicPlan { capabilityId: string; summary: string; description: string; items: WorkItem[] }

/** Jira work breakdown for orchestration: per capability, one story for the automated build and one per guided step. */
export function workBreakdown(bp: Blueprint, p: Plan): EpicPlan[] {
  const name = (id: string) => id.replace(/^[a-z]+\./, '').replace(/-/g, ' ');
  const caps = [...new Set(p.steps.flatMap((s) => (s.capabilityIds.length ? s.capabilityIds : ['shared'])))];
  const placed = new Set<string>();
  return caps.map((cap) => {
    // Shared elements go to the first capability that needs them, so each is built once.
    const steps = p.steps.filter((s) => (s.capabilityIds.length ? s.capabilityIds.includes(cap) : cap === 'shared') && !placed.has(s.designId));
    steps.forEach((s) => placed.add(s.designId));
    const auto = steps.filter((s) => ['create', 'adopt', 'update'].includes(s.action));
    const items: WorkItem[] = [];
    if (auto.length) items.push({ summary: `Automated build: ${auto.length} element${auto.length === 1 ? '' : 's'}`, kind: 'automated', designIds: auto.map((s) => s.designId), description: auto.map((s) => `- ${s.action} ${s.type} "${s.name}" (${s.reason})`).join('\n') });
    for (const s of steps.filter((x) => x.manual)) items.push({ summary: `Guided: ${s.manual!.title}`, kind: 'guided', designIds: [s.designId], description: [`Where: ${s.manual!.where}`, ...s.manual!.instructions.map((i) => `- ${i}`), '', 'Check:', ...s.manual!.checks.map((c) => `- ${c}`)].join('\n') });
    const outcomes = bp.outcomes.filter((o) => o.capabilityId === cap);
    return {
      capabilityId: cap, summary: cap === 'shared' ? 'Shared foundations' : `Build capability: ${name(cap)}`,
      description: outcomes.length ? `Delivers:\n${outcomes.map((o) => `- ${o.statement}`).join('\n')}\n\nDone when every acceptance test passes in the sandbox.` : 'Shared elements other capabilities depend on.',
      items,
    };
  }).filter((e) => e.items.length);
}
