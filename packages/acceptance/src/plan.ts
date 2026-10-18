import {
  type Blueprint, type CheckStep, type DesignElement, type FixtureValue, type ParamValue, PERSONAS,
  namesUsedBy, orderFixtures, placeholderOf, validateChecks, validateFixtures,
} from '@snjsm/model';
import { type BuildState, hashOf, specHashOf } from '@snjsm/builder';
import { getCapability } from '@snjsm/reference';
import type { AcceptancePlan, CriterionStatus, PlannedCriterion, PlannedFixture, TestConfig } from './types';

const BUILT = new Set(['created', 'adopted', 'updated', 'manual-done']);
const EXCLUDED_OUTCOME = new Set(['rejected', 'deferred']);

export interface PlanInput {
  bp: Blueprint;
  state: BuildState | undefined;
  site: string;
  config?: TestConfig;
  /** Personas the runner holds credentials for ("agent" is always the runner itself). */
  actors?: string[];
  outcomeIds?: string[];
  now?: string;
}

/** Why an element is not ready to be tested, or undefined when it is. */
function notReady(el: DesignElement | undefined, id: string, state: BuildState | undefined): string | undefined {
  if (!el) return `${id} is not in the design`;
  const st = state?.elements[id];
  const name = `${el.name} (${id})`;
  if (!st) return `${name} is not built yet`;
  if (st.status === 'failed') return `${name} failed to build: ${st.error ?? 'see the build report'}`;
  if (st.status === 'manual-pending') return `${name} waits for its guided step`;
  if (st.manualPending?.length) return `${name} has guided steps pending: ${st.manualPending.join('; ')}`;
  if (!BUILT.has(st.status)) return `${name} is ${st.status}`;
  if (st.specHash !== specHashOf(el)) return `${name} changed in the design since it was built: plan and apply first`;
  return undefined;
}

/** Design ids a step names directly (request type, fields, SLA). */
function elementsNamedBy(steps: CheckStep[], design: Map<string, DesignElement>): string[] {
  const ids = new Set<string>();
  for (const s of steps) {
    const sp = s.spec as Record<string, unknown>;
    for (const v of [sp.requestType, sp.field, sp.sla]) if (typeof v === 'string' && design.has(v)) ids.add(v);
    if (sp.fields && typeof sp.fields === 'object') for (const k of Object.keys(sp.fields)) if (design.has(k)) ids.add(k);
  }
  // A request type also needs its space (service desk id) to be built.
  for (const id of [...ids]) {
    const el = design.get(id);
    if (el?.type === 'request-type') ids.add(el.spec.spaceId);
  }
  return [...ids];
}

const fill = (v: string, params: Record<string, ParamValue>): string =>
  v.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (params[k] !== undefined && typeof params[k] !== 'object' ? String(params[k]) : m));

/** Resolve {{params}} and below/above against the blueprint's (signed-off) parameter values. */
function resolveFixtureValue(v: FixtureValue, params: Record<string, ParamValue>): { value?: FixtureValue; error?: string } {
  if (typeof v === 'string') return { value: fill(v, params) };
  if (typeof v !== 'object') return { value: v };
  if ('below' in v || 'above' in v) {
    const name = 'below' in v ? v.below : v.above;
    const n = params[name];
    if (typeof n !== 'number') return { error: `parameter ${name} has no numeric value in the blueprint` };
    // Half / double keep clear of the boundary, whatever rounding the site applies.
    return { value: 'below' in v ? Math.floor(n / 2) : Math.ceil(n * 2) };
  }
  return { value: v };
}

/**
 * Offline: decide which acceptance criteria can run now, and fix exactly what a run will do (runHash).
 * Reads the blueprint, build state and catalogue fixtures only; it never calls the site.
 */
export function planAcceptance(input: PlanInput): AcceptancePlan {
  const { bp, state, site, config = {} } = input;
  const actors = new Set(['agent', ...(input.actors ?? [])]);
  const design = new Map(bp.design.map((e) => [e.id, e]));
  const scopeCaps = new Map(bp.capabilities.map((c) => [c.capabilityId, c]));

  // Personas: who has an account id (config or credentials) and who the runner can act as.
  const personas: AcceptancePlan['personas'] = {};
  for (const p of PERSONAS) {
    const accountId = config.personas?.[p]?.accountId;
    personas[p] = { ...(accountId ? { accountId } : {}), canAct: actors.has(p) };
  }
  // The requester defaults to the runner (who raises the request); others need an id or credentials.
  const identifiable = (p: string) => p === 'requester' || p === 'agent' || Boolean(personas[p]?.accountId) || actors.has(p);

  // Fixtures: per capability, with parameters from that capability's outcomes in the blueprint.
  const fixtures: PlannedFixture[] = [];
  const fixtureIds = new Map<string, Set<string>>();
  for (const capId of new Set(bp.outcomes.map((o) => o.capabilityId))) {
    const cap = getCapability(capId);
    const defs = cap?.fixtures ?? [];
    fixtureIds.set(capId, new Set(defs.map((f) => f.id)));
    const params: Record<string, ParamValue> = Object.assign({}, ...bp.outcomes.filter((o) => o.capabilityId === capId).map((o) => o.parameters));
    const issues = validateFixtures(`${capId}.fixtures`, defs, design, new Set(Object.keys(params)));
    for (const f of orderFixtures(defs)) {
      const reasons = issues.filter((i) => i.severity === 'error' && (i.path === `${capId}.fixtures.${f.id}` || i.path === `${capId}.fixtures`)).map((i) => i.message);
      const attributes: Record<string, FixtureValue> = {};
      for (const [attrId, raw] of Object.entries(f.attributes)) {
        const r = resolveFixtureValue(raw, params);
        if (r.error) reasons.push(r.error);
        else attributes[attrId] = r.value!;
        if (typeof raw === 'object' && 'persona' in raw && !identifiable(raw.persona)) reasons.push(`no account id for persona ${raw.persona}: set it in the test config`);
      }
      const existing = config.fixtures?.[f.id]?.objectId;
      if (!existing) {
        for (const id of [f.objectTypeId, ...Object.keys(f.attributes)]) { const why = notReady(design.get(id), id, state); if (why) reasons.push(why); }
        for (const raw of Object.values(f.attributes)) {
          if (typeof raw === 'object' && 'fixture' in raw) {
            const dep = fixtures.find((x) => x.id === raw.fixture && x.capabilityId === capId);
            if (dep?.status === 'unavailable') reasons.push(`needs fixture ${dep.id}, which is unavailable`);
          }
        }
      }
      fixtures.push({
        id: f.id, capabilityId: capId, description: f.description, objectTypeId: f.objectTypeId, attributes,
        status: existing ? 'existing' : reasons.length ? 'unavailable' : 'create',
        ...(existing ? { objectId: existing } : {}),
        reasons: existing ? [] : [...new Set(reasons)],
      });
    }
  }

  // A blueprint carries a frozen copy of its capabilities' criteria (they are part of what is signed off).
  // If the catalogue has moved on, those checks may use an old step format: say so plainly instead of
  // reporting them as invalid, and never swap in the new criteria without a fresh analysis and sign-off.
  const staleCaps = new Map<string, string>();
  for (const c of bp.capabilities) {
    const current = getCapability(c.capabilityId)?.version;
    if (current && c.catalogueVersion !== current) {
      staleCaps.set(c.capabilityId, `the blueprint's criteria come from ${c.capabilityId} v${c.catalogueVersion}, but the catalogue is now v${current}: re-run the analysis and sign off the outcomes again`);
    }
  }

  const criteria: PlannedCriterion[] = [];
  for (const o of bp.outcomes) {
    if (input.outcomeIds?.length && !input.outcomeIds.includes(o.id)) continue;
    const capStatus = scopeCaps.get(o.capabilityId)?.status;
    const deliverers = bp.design.filter((e) => e.deliversOutcomeIds.includes(o.id)).map((e) => e.id);
    for (const ac of o.acceptance) {
      const steps = ac.check ?? [];
      const used = namesUsedBy(steps);
      const capFixtures = fixtureIds.get(o.capabilityId) ?? new Set<string>();
      const usedFixtures = used.placeholders.filter((p) => capFixtures.has(p));
      const usedPersonas = used.placeholders.filter((p) => !capFixtures.has(p));
      const needs = { elements: [...new Set([...deliverers, ...elementsNamedBy(steps, design)])], fixtures: usedFixtures, actors: used.actors, personas: usedPersonas };
      const reasons: string[] = [];
      let status: CriterionStatus;
      if (EXCLUDED_OUTCOME.has(o.status)) { status = 'excluded'; reasons.push(`outcome is ${o.status}`); }
      else if (capStatus === 'out-of-scope') { status = 'excluded'; reasons.push('capability is out of scope'); }
      else if (ac.verification === 'manual' || !steps.length) { status = 'manual'; reasons.push('manual check: a person verifies it in the sandbox'); }
      else if (staleCaps.has(o.capabilityId)) { status = 'blocked'; reasons.push(staleCaps.get(o.capabilityId)!); }
      else {
        for (const i of validateChecks(`${o.id}.${ac.id}`, ac, { design, fixtureIds: capFixtures })) if (i.severity === 'error') reasons.push(`invalid check: ${i.message}`);
        for (const id of needs.elements) { const why = notReady(design.get(id), id, state); if (why) reasons.push(why); }
        for (const f of usedFixtures) {
          const pf = fixtures.find((x) => x.id === f && x.capabilityId === o.capabilityId);
          if (pf?.status === 'unavailable') reasons.push(`test data ${f} unavailable: ${pf.reasons.join('; ')}`);
        }
        for (const a of used.actors) if (a !== 'agent' && a !== 'requester' && !actors.has(a)) reasons.push(`no credentials for persona ${a}: it must act in this test`);
        for (const p of usedPersonas) if (!identifiable(p)) reasons.push(`no account id for persona ${p}: set it in the test config or add its credentials`);
        status = reasons.length ? 'blocked' : 'ready';
      }
      criteria.push({ outcomeId: o.id, capabilityId: o.capabilityId, statement: o.statement, acId: ac.id, given: ac.given, when: ac.when, then: ac.then, status, reasons: [...new Set(reasons)], steps, needs });
    }
  }

  const summary: Record<CriterionStatus, number> = { ready: 0, blocked: 0, manual: 0, excluded: 0 };
  for (const c of criteria) summary[c.status]++;
  // The hash pins what a run will do and where: criteria and their steps, test data, built remotes, personas.
  const remotes = [...new Set(criteria.filter((c) => c.status === 'ready').flatMap((c) => c.needs.elements))].sort().map((id) => [id, state?.elements[id]?.remote?.id ?? null]);
  const runHash = hashOf({
    bp: bp.id, site,
    criteria: criteria.map((c) => [c.acId, c.status, c.steps]),
    fixtures: fixtures.map((f) => [f.id, f.status, f.objectId ?? null, f.attributes]),
    remotes, personas,
  });
  return { blueprintId: bp.id, site, createdAt: input.now ?? new Date().toISOString(), runHash, criteria, fixtures, personas, summary };
}

export { placeholderOf };
