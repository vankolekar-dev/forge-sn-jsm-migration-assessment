import { type Blueprint, type CheckStep, type DesignElement, type Duration, parseCheck, placeholderOf } from '@snjsm/model';
import type { BuildState, SiteApi } from '@snjsm/builder';
import {
  type AcceptancePlan, type AcceptanceResult, type Clock, type CriterionResult, type OutcomeResult, type PlannedCriterion,
  type StepOutcome, type TestConfig, type TestDataLedger, type Verdict, TEST_TAG, realClock, tagOf,
} from './types';

export interface RunInput {
  plan: AcceptancePlan;
  bp: Blueprint;
  state: BuildState;
  /** The runner's own (agent) client; must be write-enabled. */
  api: SiteApi;
  /** Clients for personas the runner can act as (from their own credentials). */
  personas?: Partial<Record<string, SiteApi>>;
  config?: TestConfig;
  runId: string;
  /** Keep test data on the site for inspection (cleanup later from the ledger). */
  keep?: boolean;
  clock?: Clock;
  /** Default wait for assertions, and polling interval. */
  defaultWithinSeconds?: number;
  pollSeconds?: number;
  log?: (line: string) => void;
}

type Obj = Record<string, any>;
class StepFailure extends Error {}

/** Comparable tokens of a Jira / Assets value: ids, keys, names, account ids. */
function tokensOf(v: unknown): string[] {
  if (v === null || v === undefined || v === '') return [];
  if (typeof v !== 'object') return [String(v).toLowerCase()];
  const o = v as Obj;
  return ['accountId', 'name', 'value', 'key', 'objectKey', 'objectId', 'id', 'displayName', 'label', 'title']
    .filter((k) => typeof o[k] === 'string' || typeof o[k] === 'number')
    .map((k) => String(o[k]).toLowerCase());
}
const itemsOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === null || v === undefined || v === '' ? [] : [v]);
const show = (v: unknown) => { const s = JSON.stringify(v); return s === undefined ? 'nothing' : s.length > 160 ? `${s.slice(0, 157)}...` : s; };

const UNIT_MS: Record<Duration['unit'], number> = { minutes: 60_000, hours: 3_600_000, 'business-hours': 3_600_000, days: 86_400_000, 'business-days': 0 };

/**
 * Run the plan's ready criteria against the sandbox. Every request and object it creates is tagged with the
 * run id and recorded in the ledger; cleanup removes only ledger items that still carry the tag.
 */
export async function runAcceptance(input: RunInput): Promise<AcceptanceResult> {
  const { plan, bp, state, api, runId } = input;
  if (api.readOnly) throw new Error('acceptance runs create test requests: use a write-enabled client');
  const clock = input.clock ?? realClock;
  const defaultWithin = input.defaultWithinSeconds ?? 30;
  const pollMs = (input.pollSeconds ?? 3) * 1000;
  const log = input.log ?? (() => {});
  const design = new Map(bp.design.map((e) => [e.id, e]));
  const tag = tagOf(runId);
  const startedAt = new Date(clock.now()).toISOString();
  const ledger: TestDataLedger = { runId, tag, site: plan.site, blueprintId: bp.id, requests: [], objects: [] };
  const warnings: string[] = [];
  const remote = (id: string) => state.elements[id]?.remote;
  const remoteId = (id: string) => remote(id)?.id ?? (() => { throw new StepFailure(`${id} has no remote id in the build state`); })();

  // ---- Identities ----
  const accountIds = new Map<string, string>();
  const me = await api.jira<{ accountId: string }>('GET', '/rest/api/3/myself');
  accountIds.set('agent', me.accountId);
  for (const [p, info] of Object.entries(plan.personas)) {
    if (info.accountId) accountIds.set(p, info.accountId);
    else if (input.personas?.[p]) accountIds.set(p, (await input.personas[p]!.jira<{ accountId: string }>('GET', '/rest/api/3/myself')).accountId);
  }
  if (!accountIds.has('requester')) accountIds.set('requester', me.accountId);
  const clientFor = (p: string | undefined): SiteApi => {
    if (!p || p === 'agent') return api;
    const c = input.personas?.[p];
    if (!c) throw new StepFailure(`no credentials for persona ${p}`);
    return c;
  };

  // ---- Test data (Assets objects) ----
  let workspaceId: string | undefined;
  const workspace = async () => (workspaceId ??= (await api.jsm<{ values?: { workspaceId: string }[] }>('GET', '/rest/servicedeskapi/assets/workspace')).values?.[0]?.workspaceId ?? 'unknown');
  const objects = new Map<string, { id: string; key?: string; label?: string }>();
  const fixtureResults: AcceptanceResult['fixtures'] = [];
  const statusIds = new Map<string, string>();
  const statusId = async (name: string, schemaId: string | undefined) => {
    if (!statusIds.size) {
      const all = await api.assets<Obj[]>('GET', `/config/statustype${schemaId ? `?objectSchemaId=${schemaId}` : ''}`);
      for (const s of all ?? []) statusIds.set(String(s.name).toLowerCase(), String(s.id));
    }
    return statusIds.get(name.toLowerCase()) ?? (() => { throw new Error(`Assets status "${name}" not found`); })();
  };
  const needed = new Set(plan.criteria.filter((c) => c.status === 'ready').map((c) => c.capabilityId));
  for (const f of plan.fixtures.filter((x) => needed.has(x.capabilityId))) {
    if (f.status === 'unavailable') { fixtureResults.push({ id: f.id, result: 'unavailable', detail: f.reasons.join('; ') }); continue; }
    try {
      if (f.status === 'existing') {
        const o = await api.assets<Obj>('GET', `/object/${f.objectId}`);
        objects.set(f.id, { id: String(o.id), key: o.objectKey, label: o.label });
        fixtureResults.push({ id: f.id, result: 'existing', objectKey: o.objectKey });
        continue;
      }
      const schemaId = state.elements[bp.design.find((e) => e.type === 'assets-schema')?.id ?? '']?.remote?.id;
      const attributes = [];
      for (const [attrId, v] of Object.entries(f.attributes)) {
        const el = design.get(attrId) as Extract<DesignElement, { type: 'assets-attribute' }>;
        let value: string;
        if (typeof v === 'object' && 'persona' in v) value = accountIds.get(v.persona) ?? (() => { throw new Error(`no account id for persona ${v.persona}`); })();
        else if (typeof v === 'object' && 'fixture' in v) { const o = objects.get(v.fixture); if (!o) throw new Error(`fixture ${v.fixture} was not created`); value = o.key ?? o.id; }
        else if (typeof v === 'object' && 'status' in v) value = await statusId(v.status, schemaId);
        else if (typeof v === 'object') throw new Error(`unresolved value ${show(v)}`);
        // The object's name carries the tag, so cleanup can prove it created the object.
        else value = el.spec.name === 'Name' && typeof v === 'string' ? `${tag} ${v}` : String(v);
        attributes.push({ objectTypeAttributeId: remoteId(attrId), objectAttributeValues: [{ value }] });
      }
      const o = await api.assets<Obj>('POST', '/object/create', { objectTypeId: remoteId(f.objectTypeId), attributes });
      ledger.objects.push({ id: String(o.id), key: o.objectKey, fixtureId: f.id });
      objects.set(f.id, { id: String(o.id), key: o.objectKey, label: o.label });
      fixtureResults.push({ id: f.id, result: 'created', objectKey: o.objectKey });
      log(`test data ${f.id}: ${o.objectKey ?? o.id}`);
    } catch (e) {
      fixtureResults.push({ id: f.id, result: 'failed', detail: (e as Error).message });
    }
  }

  // Assets field values are workspace-qualified; resolve it once so assertions can compare them.
  if (objects.size) await workspace();

  // ---- Field and value resolution ----
  let teamFieldId: string | undefined;
  const fieldIdOf = async (ref: string): Promise<string> => {
    if (design.has(ref)) return remoteId(ref);
    if (ref !== 'team') return ref;
    if (!teamFieldId) {
      const fields = await api.jira<Obj[]>('GET', '/rest/api/3/field');
      teamFieldId = fields.find((f) => String(f.schema?.custom ?? '').endsWith(':atlassian-team'))?.id;
      if (!teamFieldId) throw new StepFailure('the site has no Team field');
    }
    return teamFieldId;
  };
  /** Expected value → list of items, each a set of acceptable tokens. */
  const expectedItems = (v: unknown): string[][] => {
    const p = placeholderOf(v);
    if (p && objects.has(p)) { const o = objects.get(p)!; return [[o.id, o.key, o.label, `${workspaceId}:${o.id}`].filter(Boolean).map((t) => String(t).toLowerCase())]; }
    if (p && accountIds.has(p)) return [[accountIds.get(p)!.toLowerCase()]];
    if (p) throw new StepFailure(`<${p}> is not available in this run`);
    return itemsOf(v).map((x) => tokensOf(x));
  };
  const inputValue = async (fieldRef: string, v: unknown): Promise<unknown> => {
    const p = placeholderOf(v);
    const el = design.get(fieldRef) as Extract<DesignElement, { type: 'field' }> | undefined;
    const type = el?.type === 'field' ? el.spec.fieldType : undefined;
    if (p && objects.has(p)) {
      // Assets object fields take the workspace-qualified object id (assumed REST contract; unverified).
      const o = objects.get(p)!;
      const ws = await workspace();
      return [{ workspaceId: ws, id: `${ws}:${o.id}`, objectId: o.id }];
    }
    if (p && accountIds.has(p)) return type === 'multiuser' ? [{ accountId: accountIds.get(p) }] : { accountId: accountIds.get(p) };
    if (p) throw new StepFailure(`<${p}> is not available in this run`);
    return v;
  };

  const issueFields = async (key: string, fieldIds: string[]) =>
    (await api.jira<{ fields: Obj }>('GET', `/rest/api/3/issue/${key}?fields=${fieldIds.map(encodeURIComponent).join(',')}`)).fields ?? {};

  /** Poll until check() passes or the wait runs out; the last failure explains why. */
  const poll = async (withinSeconds: number | undefined, check: () => Promise<string | undefined>): Promise<string> => {
    const deadline = clock.now() + (withinSeconds ?? defaultWithin) * 1000;
    for (;;) {
      const failure = await check();
      if (failure === undefined) return 'ok';
      if (clock.now() >= deadline) { const w = withinSeconds ?? defaultWithin; throw new StepFailure(w ? `${failure} (waited ${w}s)` : failure); }
      await clock.sleep(pollMs);
    }
  };

  const workflowPath = (from: string, to: string): string[] | undefined => {
    // Shortest status path in the design workflows, avoiding approval decisions (people make those).
    const edges: [string, string][] = [];
    for (const wf of bp.design.filter((e): e is Extract<DesignElement, { type: 'workflow' }> => e.type === 'workflow')) {
      const name = new Map(wf.spec.statuses.map((s) => [s.id, s.name.toLowerCase()]));
      const approvalTs = new Set(wf.spec.approvals.flatMap((a) => [a.approveTransitionId, a.declineTransitionId]));
      for (const t of wf.spec.transitions) {
        if (approvalTs.has(t.id)) continue;
        const froms = t.from.length ? t.from.map((f) => name.get(f)!) : [...name.values()];
        for (const f of froms) edges.push([f, name.get(t.to)!]);
      }
    }
    const prev = new Map<string, string>([[from, '']]);
    const queue = [from];
    while (queue.length) {
      const s = queue.shift()!;
      if (s === to) break;
      for (const [a, b] of edges) if (a === s && !prev.has(b)) { prev.set(b, s); queue.push(b); }
    }
    if (!prev.has(to)) return undefined;
    const path: string[] = [];
    for (let s = to; s !== from; s = prev.get(s)!) path.unshift(s);
    return path;
  };

  // ---- Steps ----
  interface Ctx { key?: string; id?: string; c: PlannedCriterion }
  const run: Record<string, (ctx: Ctx, spec: any) => Promise<string>> = {
    'create-request': async (ctx, spec) => {
      const rt = design.get(spec.requestType) as Extract<DesignElement, { type: 'request-type' }>;
      const sdId = remote(rt.spec.spaceId)?.extra?.['serviceDeskId'];
      if (!sdId) throw new StepFailure(`no service desk id recorded for ${rt.spec.spaceId}`);
      const values: Obj = {};
      for (const [ref, v] of Object.entries(spec.fields as Obj)) values[await fieldIdOf(ref)] = await inputValue(ref, v);
      values['summary'] = `${tag} ${typeof values['summary'] === 'string' ? values['summary'] : `${ctx.c.acId}: ${ctx.c.when}`}`.slice(0, 250);
      const as = spec.as ?? 'requester';
      const own = as !== 'agent' ? input.personas?.[as] : undefined;
      const onBehalf = !own && accountIds.get(as) !== accountIds.get('agent') ? { raiseOnBehalfOf: accountIds.get(as) } : {};
      const r = await (own ?? api).jsm<Obj>('POST', '/rest/servicedeskapi/request', { serviceDeskId: sdId, requestTypeId: remoteId(rt.id), requestFieldValues: values, ...onBehalf });
      ctx.key = r.issueKey;
      ctx.id = String(r.issueId);
      ledger.requests.push({ key: r.issueKey, id: String(r.issueId), acId: ctx.c.acId });
      try {
        await api.jira('PUT', `/rest/api/3/issue/${r.issueKey}`, { update: { labels: [{ add: TEST_TAG }, { add: `${TEST_TAG}-${runId}` }] } });
      } catch (e) {
        warnings.push(`could not label ${r.issueKey} (${(e as Error).message}); its summary still carries the tag`);
      }
      return `created ${r.issueKey}${own ? ` as ${as}` : onBehalf.raiseOnBehalfOf ? ` on behalf of ${as}` : ''}`;
    },
    'assert-status': async (ctx, spec) => {
      let seen = '';
      await poll(spec.withinSeconds, async () => {
        seen = (await issueFields(ctx.key!, ['status'])).status?.name ?? '';
        return seen.toLowerCase() === String(spec.status).toLowerCase() ? undefined : `status is "${seen}", want "${spec.status}"`;
      });
      return `status is ${seen}`;
    },
    'assert-field': async (ctx, spec) => {
      const id = await fieldIdOf(spec.field);
      const want = spec.equals !== undefined ? expectedItems(spec.equals) : undefined;
      let have: unknown;
      await poll(spec.withinSeconds, async () => {
        have = (await issueFields(ctx.key!, [id]))[id];
        const items = itemsOf(have);
        if (spec.empty) return items.length ? `${spec.field} is ${show(have)}, want empty` : undefined;
        if (spec.notEmpty) return items.length ? undefined : `${spec.field} is empty`;
        const ok = items.length === want!.length && want!.every((w) => items.some((i) => tokensOf(i).some((t) => w.includes(t))));
        return ok ? undefined : `${spec.field} is ${show(have)}, want ${show(spec.equals)}`;
      });
      return `${spec.field} = ${show(have)}`;
    },
    'assert-assignee': async (ctx, spec) => {
      const want = spec.equals !== undefined ? expectedItems(spec.equals) : undefined;
      let have: unknown;
      await poll(spec.withinSeconds, async () => {
        have = (await issueFields(ctx.key!, ['assignee'])).assignee;
        if (!want) return have ? undefined : 'no assignee';
        return have && want.every((w) => tokensOf(have).some((t) => w.includes(t))) ? undefined : `assignee is ${show(have)}, want ${show(spec.equals)}`;
      });
      return `assignee ${show(have)}`;
    },
    'assert-sla': async (ctx, spec) => {
      const el = design.get(spec.sla) as Extract<DesignElement, { type: 'sla' }>;
      const goalMs = spec.goal !== undefined ? goalMillis(spec.goal, el) : undefined;
      let seen: Obj | undefined;
      await poll(spec.withinSeconds, async () => {
        const r = await api.jsm<{ values?: Obj[] }>('GET', `/rest/servicedeskapi/request/${ctx.key}/sla`);
        seen = r.values?.find((v) => String(v.name).toLowerCase() === el.spec.name.toLowerCase());
        if (!seen) return `SLA "${el.spec.name}" is not on the request`;
        const cycle = seen.ongoingCycle as Obj | undefined;
        if (spec.running === true && (!cycle || cycle.paused)) return `SLA "${el.spec.name}" is not running`;
        if (spec.running === false && cycle && !cycle.paused) return `SLA "${el.spec.name}" is running`;
        if (goalMs !== undefined) {
          const have = cycle?.goalDuration?.millis ?? seen.completedCycles?.at(-1)?.goalDuration?.millis;
          if (have !== goalMs) return `SLA "${el.spec.name}" goal is ${have === undefined ? 'unknown' : `${have / 3_600_000}h`}, want ${goalMs / 3_600_000}h`;
        }
        return undefined;
      });
      return `SLA ${el.spec.name}${spec.running !== undefined ? (spec.running ? ' running' : ' stopped') : ''}${goalMs !== undefined ? `, goal ${goalMs / 3_600_000}h` : ''}`;
    },
    transition: async (ctx, spec) => {
      const target = String(spec.to).toLowerCase();
      const done: string[] = [];
      for (let hop = 0; hop < 10; hop++) {
        const current = String((await issueFields(ctx.key!, ['status'])).status?.name ?? '').toLowerCase();
        if (current === target) return done.length ? `moved via ${done.join(' → ')}` : `already ${spec.to}`;
        const live = (await clientFor(spec.as).jira<{ transitions: Obj[] }>('GET', `/rest/api/3/issue/${ctx.key}/transitions`)).transitions ?? [];
        const next = live.find((t) => String(t.to?.name).toLowerCase() === target) ? target : workflowPath(current, target)?.[0];
        const t = next && live.find((x) => String(x.to?.name).toLowerCase() === next);
        if (!t) throw new StepFailure(`no transition from "${current}" towards "${spec.to}" (available: ${live.map((x) => `${x.name} → ${x.to?.name}`).join(', ') || 'none'})`);
        const fields = next === target && spec.resolution ? { fields: { resolution: { name: spec.resolution } } } : {};
        await clientFor(spec.as).jira('POST', `/rest/api/3/issue/${ctx.key}/transitions`, { transition: { id: t.id }, ...fields });
        done.push(String(t.name));
      }
      throw new StepFailure(`gave up after 10 transitions towards "${spec.to}"`);
    },
    approve: (ctx, spec) => decide(ctx, spec, 'approve'),
    decline: (ctx, spec) => decide(ctx, spec, 'decline'),
    'add-comment': async (ctx, spec) => {
      await clientFor(spec.as).jsm('POST', `/rest/servicedeskapi/request/${ctx.key}/comment`, { body: spec.body, public: spec.public });
      return `commented${spec.as ? ` as ${spec.as}` : ''}`;
    },
    wait: async (_ctx, spec) => { await clock.sleep(spec.seconds * 1000); return `waited ${spec.seconds}s`; },
  };
  const decide = async (ctx: Ctx, spec: { as: string; comment?: string }, decision: 'approve' | 'decline') => {
    const c = clientFor(spec.as);
    const who = accountIds.get(spec.as);
    let approval: Obj | undefined;
    await poll(undefined, async () => {
      const r = await c.jsm<{ values?: Obj[] }>('GET', `/rest/servicedeskapi/request/${ctx.key}/approval`);
      approval = r.values?.find((a) => a.finalDecision === 'pending' && (a.canAnswerApproval === true || (a.approvers ?? []).some((x: Obj) => x.approver?.accountId === who)));
      return approval ? undefined : `no pending approval ${spec.as} can answer`;
    });
    if (spec.comment) await c.jsm('POST', `/rest/servicedeskapi/request/${ctx.key}/comment`, { body: spec.comment, public: true });
    await c.jsm('POST', `/rest/servicedeskapi/request/${ctx.key}/approval/${approval!.id}`, { decision });
    return `${decision}d as ${spec.as}`;
  };
  const goalMillis = (goal: unknown, el: Extract<DesignElement, { type: 'sla' }>): number => {
    const g = goal as Duration;
    if (!g || typeof g !== 'object' || typeof g.value !== 'number') throw new StepFailure(`goal ${show(goal)} is not a duration`);
    if (g.unit !== 'business-days') return g.value * UNIT_MS[g.unit];
    // Business days are working days of the goal's calendar: value × working hours per day.
    const calId = el.spec.goals.find((x) => x.calendarId)?.calendarId;
    const cal = calId ? design.get(calId) : undefined;
    if (cal?.type !== 'calendar') throw new StepFailure(`SLA ${el.id} has no calendar to convert business days`);
    const [h] = cal.spec.workingHours;
    const mins = (s: string) => { const [a, b] = s.split(':').map(Number); return a! * 60 + (b ?? 0); };
    return g.value * (mins(h!.end) - mins(h!.start)) * 60_000;
  };

  // ---- Criteria ----
  const manualChecks: AcceptanceResult['manualChecks'] = [];
  const criterionResults: CriterionResult[] = [];
  const unavailable = new Set(fixtureResults.filter((f) => f.result === 'failed').map((f) => f.id));
  for (const c of plan.criteria) {
    if (c.status !== 'ready') {
      criterionResults.push({ outcomeId: c.outcomeId, acId: c.acId, verdict: c.status === 'manual' ? 'manual' : c.status === 'excluded' ? 'excluded' : 'blocked', steps: [], detail: c.reasons.join('; ') });
      if (c.status === 'manual') manualChecks.push({ acId: c.acId, check: `Given ${c.given}, when ${c.when}, then ${c.then.join('; ')}` });
      continue;
    }
    const missing = c.needs.fixtures.filter((f) => unavailable.has(f));
    if (missing.length) {
      criterionResults.push({ outcomeId: c.outcomeId, acId: c.acId, verdict: 'error', steps: [], detail: `test data could not be created: ${missing.join(', ')}` });
      continue;
    }
    log(`running ${c.acId}`);
    const ctx: Ctx = { c };
    const steps: StepOutcome[] = [];
    let stopped = false;
    for (const [index, step] of c.steps.entries()) {
      const out = (result: StepOutcome['result'], detail: string) => steps.push({ index: index + 1, kind: step.kind, result, detail });
      if (stopped) { out('not-run', 'an earlier step did not pass'); continue; }
      if (step.kind === 'assert-notification') {
        const s = step.spec as { audience: string; event: string };
        const check = `${ctx.key ?? 'the request'}: the ${s.audience} received the "${s.event}" notification`;
        manualChecks.push({ acId: c.acId, check });
        out('manual', `check by hand: ${check}`);
        continue;
      }
      try {
        out('pass', await run[step.kind]!(ctx, parseCheck(step.kind, step.spec)));
      } catch (e) {
        stopped = true;
        out(e instanceof StepFailure ? 'fail' : 'error', (e as Error).message);
      }
    }
    criterionResults.push({ outcomeId: c.outcomeId, acId: c.acId, verdict: criterionVerdict(steps), ...(ctx.key ? { request: ctx.key } : {}), steps });
  }

  const outcomes: OutcomeResult[] = [];
  for (const o of bp.outcomes) {
    const cs = criterionResults.filter((r) => r.outcomeId === o.id);
    if (cs.length) outcomes.push({ outcomeId: o.id, statement: o.statement, verdict: outcomeVerdict(cs.map((r) => r.verdict)), criteria: cs });
  }
  const summary = { pass: 0, fail: 0, error: 0, partial: 0, manual: 0, blocked: 0, excluded: 0 } as Record<Verdict, number>;
  for (const o of outcomes) summary[o.verdict]++;

  const result: AcceptanceResult = {
    runId, runHash: plan.runHash, site: plan.site, blueprintId: bp.id, startedAt, finishedAt: '', outcomes, summary,
    manualChecks, fixtures: fixtureResults, ledger, warnings,
  };
  if (!input.keep) await cleanupTestData(api, ledger, clock);
  result.finishedAt = new Date(clock.now()).toISOString();
  return result;
}

/** A criterion passes when every automated step passed; notifications left for a person make it partial. */
export function criterionVerdict(steps: StepOutcome[]): Verdict {
  if (steps.some((s) => s.result === 'fail')) return 'fail';
  if (steps.some((s) => s.result === 'error')) return 'error';
  if (steps.some((s) => s.result === 'manual')) return steps.some((s) => s.result === 'pass') ? 'partial' : 'manual';
  return 'pass';
}

/** Outcome parity needs every criterion to pass; anything not yet proven keeps the outcome short of pass. */
export function outcomeVerdict(vs: Verdict[]): Verdict {
  for (const v of ['fail', 'error'] as const) if (vs.includes(v)) return v;
  const live = vs.filter((v) => v !== 'excluded');
  if (!live.length) return 'excluded';
  if (live.every((v) => v === 'pass')) return 'pass';
  if (live.some((v) => v === 'pass' || v === 'partial')) return 'partial';
  if (live.every((v) => v === 'manual')) return 'manual';
  return 'blocked';
}

/**
 * Remove a run's test data: requests first, then Assets objects (newest first, so references go before their
 * targets). Only items that still carry the run's tag are deleted; anything else is reported as a leftover.
 */
export async function cleanupTestData(api: SiteApi, ledger: TestDataLedger, clock: Clock = realClock): Promise<TestDataLedger['cleanup']> {
  if (api.readOnly) throw new Error('cleanup needs a write-enabled client');
  const removed: string[] = [];
  const leftovers: { ref: string; error: string }[] = [];
  const gone = (e: unknown) => (e as { status?: number }).status === 404;
  for (const r of ledger.requests) {
    try {
      const i = await api.jira<{ fields?: { summary?: string } }>('GET', `/rest/api/3/issue/${r.key}?fields=summary`);
      if (!String(i.fields?.summary ?? '').startsWith(ledger.tag)) { leftovers.push({ ref: r.key, error: 'summary no longer carries the test tag; not deleted' }); continue; }
      await api.jira('DELETE', `/rest/api/3/issue/${r.key}`);
      removed.push(r.key);
    } catch (e) {
      if (gone(e)) removed.push(r.key);
      else leftovers.push({ ref: r.key, error: (e as Error).message });
    }
  }
  for (const o of [...ledger.objects].reverse()) {
    const ref = o.key ?? o.id;
    try {
      const obj = await api.assets<{ label?: string }>('GET', `/object/${o.id}`);
      if (!String(obj.label ?? '').startsWith(ledger.tag)) { leftovers.push({ ref, error: 'name no longer carries the test tag; not deleted' }); continue; }
      await api.assets('DELETE', `/object/${o.id}`);
      removed.push(ref);
    } catch (e) {
      if (gone(e)) removed.push(ref);
      else leftovers.push({ ref, error: (e as Error).message });
    }
  }
  ledger.cleanup = { at: new Date(clock.now()).toISOString(), removed, leftovers };
  return ledger.cleanup;
}

export type { CheckStep };
