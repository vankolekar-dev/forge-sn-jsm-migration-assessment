import { z } from 'zod';
import { Id } from './common';
import { AcceptanceCriterion } from './outcome';
import { PERSONAS, TestFixture } from './capability';

/**
 * Contracts for the steps of an automated acceptance check.
 *
 * Steps run in order against one test request (created by the first `create-request`).
 * Values may reference test data as "<name>": a fixture id (an Assets object) or a persona
 * ("requester", "requester-manager", "agent"). Field references are design ids of field
 * elements, or Jira system fields ("resolution", "assignee", "reporter", "status", "team").
 * Assertions poll for up to `withinSeconds`, because automation runs asynchronously.
 */
const Within = { withinSeconds: z.number().int().min(0).max(900).optional() };
const Actor = z.string().min(1).describe('persona the step runs as');

export const CheckSpecs = {
  'create-request': z.object({ requestType: Id, fields: z.record(z.string(), z.unknown()).default({}), as: Actor.optional() }).strict(),
  transition: z.object({ to: z.string().min(1), resolution: z.string().optional(), as: Actor.optional() }).strict(),
  approve: z.object({ as: Actor, comment: z.string().optional() }).strict(),
  decline: z.object({ as: Actor, comment: z.string().optional() }).strict(),
  'add-comment': z.object({ body: z.string().min(1), public: z.boolean().default(true), as: Actor.optional() }).strict(),
  wait: z.object({ seconds: z.number().int().min(1).max(900) }).strict(),
  'assert-status': z.object({ status: z.string().min(1), ...Within }).strict(),
  'assert-field': z
    .object({ field: z.string().min(1), equals: z.unknown().optional(), notEmpty: z.boolean().optional(), empty: z.boolean().optional(), ...Within })
    .strict()
    .refine((s) => [s.equals !== undefined, s.notEmpty, s.empty].filter(Boolean).length === 1, 'set exactly one of equals, notEmpty, empty'),
  'assert-assignee': z.object({ equals: z.string().optional(), notEmpty: z.boolean().optional(), ...Within }).strict(),
  'assert-sla': z
    .object({ sla: Id.describe('design id of the SLA'), running: z.boolean().optional(), goal: z.unknown().optional(), ...Within })
    .strict(),
  /** Notifications cannot be read back through a public API: the runner reports these as manual checks. */
  'assert-notification': z.object({ audience: z.string().min(1), event: z.string().min(1) }).strict(),
} as const;

export type CheckKind = keyof typeof CheckSpecs;
export type CheckSpec<K extends CheckKind> = z.output<(typeof CheckSpecs)[K]>;
export type CheckStep = NonNullable<AcceptanceCriterion['check']>[number];

/** Validate and normalise one step's spec. */
export function parseCheck<K extends CheckKind>(kind: K, spec: unknown): CheckSpec<K> {
  return (CheckSpecs[kind] as unknown as z.ZodType<CheckSpec<K>>).parse(spec);
}

const PLACEHOLDER = /^<([a-z0-9][a-z0-9.-]*)>$/;

/** "<model-standard>" → "model-standard"; anything else → undefined. */
export function placeholderOf(v: unknown): string | undefined {
  return typeof v === 'string' ? PLACEHOLDER.exec(v)?.[1] : undefined;
}

/** Every "<name>" placeholder and persona used by a list of steps. */
export function namesUsedBy(steps: CheckStep[]): { placeholders: string[]; actors: string[] } {
  const placeholders = new Set<string>();
  const actors = new Set<string>();
  const walk = (v: unknown): void => {
    const p = placeholderOf(v);
    if (p) placeholders.add(p);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  for (const s of steps) {
    walk(s.spec);
    const as = (s.spec as { as?: unknown }).as;
    if (typeof as === 'string') actors.add(as);
  }
  return { placeholders: [...placeholders], actors: [...actors] };
}

/** Jira fields a check may name directly instead of a design id. */
export const SYSTEM_CHECK_FIELDS = ['summary', 'status', 'resolution', 'assignee', 'reporter', 'labels', 'team'] as const;
const NEEDS_NO_REQUEST = new Set<CheckKind>(['create-request', 'wait']);

export interface CheckContext {
  /** Design elements by id (blueprint or catalogue). */
  design: Map<string, { id: string; type: string }>;
  /** Fixture ids available to the checks. */
  fixtureIds: Set<string>;
  personas?: readonly string[];
}

/**
 * Structural validation of one criterion's steps: specs match their contract, names resolve,
 * and nothing acts on a request before one is created.
 */
export function validateChecks(path: string, ac: AcceptanceCriterion, ctx: CheckContext): { severity: 'error' | 'warning'; path: string; message: string }[] {
  const out: { severity: 'error' | 'warning'; path: string; message: string }[] = [];
  const err = (message: string) => out.push({ severity: 'error', path, message });
  const steps = ac.check ?? [];
  if (ac.verification === 'automated' && !steps.length) err('automated criterion has no check steps');
  const personas = ctx.personas ?? PERSONAS;
  const isType = (id: unknown, type: string) => typeof id === 'string' && ctx.design.get(id)?.type === type;
  let haveRequest = false;
  steps.forEach((s, i) => {
    const at = `step ${i + 1} (${s.kind})`;
    let spec: Record<string, unknown>;
    try {
      spec = parseCheck(s.kind, s.spec) as Record<string, unknown>;
    } catch (e) {
      err(`${at}: ${(e as Error).message.replace(/\s+/g, ' ').slice(0, 300)}`);
      return;
    }
    if (!haveRequest && !NEEDS_NO_REQUEST.has(s.kind)) err(`${at}: no request yet; start the scenario with create-request`);
    if (s.kind === 'create-request') {
      haveRequest = true;
      if (!isType(spec.requestType, 'request-type')) err(`${at}: requestType ${String(spec.requestType)} is not a request-type in the design`);
      for (const f of Object.keys(spec.fields as object)) if (!isType(f, 'field') && !(SYSTEM_CHECK_FIELDS as readonly string[]).includes(f)) err(`${at}: field ${f} is not a field in the design`);
    }
    if (s.kind === 'assert-field' && !isType(spec.field, 'field') && !(SYSTEM_CHECK_FIELDS as readonly string[]).includes(spec.field as string)) err(`${at}: field ${String(spec.field)} is not a design field or a known system field`);
    if (s.kind === 'assert-sla' && !isType(spec.sla, 'sla')) err(`${at}: sla ${String(spec.sla)} is not an SLA in the design`);
  });
  const used = namesUsedBy(steps);
  for (const p of used.placeholders) if (!ctx.fixtureIds.has(p) && !personas.includes(p)) err(`<${p}> is neither a fixture nor a persona`);
  for (const a of used.actors) if (!personas.includes(a)) err(`"as": "${a}" is not a persona (${personas.join(', ')})`);
  return out;
}

/** Fixtures must point at Assets object types/attributes in the design, and at real params, personas and fixtures. */
export function validateFixtures(
  path: string,
  fixtures: TestFixture[],
  design: Map<string, { id: string; type: string; spec: unknown }>,
  params: Set<string>,
  personas: readonly string[] = PERSONAS,
): { severity: 'error' | 'warning'; path: string; message: string }[] {
  const out: { severity: 'error' | 'warning'; path: string; message: string }[] = [];
  const ids = new Set(fixtures.map((f) => f.id));
  if (ids.size !== fixtures.length) out.push({ severity: 'error', path, message: 'duplicate fixture ids' });
  for (const f of fixtures) {
    const err = (message: string) => out.push({ severity: 'error', path: `${path}.${f.id}`, message });
    if (design.get(f.objectTypeId)?.type !== 'assets-object-type') err(`objectTypeId ${f.objectTypeId} is not an Assets object type in the design`);
    for (const [attrId, v] of Object.entries(f.attributes)) {
      const a = design.get(attrId);
      if (a?.type !== 'assets-attribute') { err(`${attrId} is not an Assets attribute in the design`); continue; }
      if ((a.spec as { objectTypeId?: string }).objectTypeId !== f.objectTypeId) err(`${attrId} does not belong to ${f.objectTypeId}`);
      if (typeof v === 'object') {
        if ('below' in v && !params.has(v.below)) err(`below: ${v.below} is not a capability parameter`);
        if ('above' in v && !params.has(v.above)) err(`above: ${v.above} is not a capability parameter`);
        if ('persona' in v && !personas.includes(v.persona)) err(`persona ${v.persona} is unknown`);
        if ('fixture' in v && !ids.has(v.fixture)) err(`fixture ${v.fixture} is unknown`);
      }
    }
  }
  // Reference cycles would make creation order impossible.
  const refs = new Map(fixtures.map((f) => [f.id, Object.values(f.attributes).flatMap((v) => (typeof v === 'object' && 'fixture' in v ? [v.fixture] : []))]));
  const seen = new Set<string>();
  const stack = new Set<string>();
  const visit = (id: string): boolean => {
    if (stack.has(id)) return false;
    if (seen.has(id)) return true;
    stack.add(id);
    const ok = (refs.get(id) ?? []).every(visit);
    stack.delete(id);
    seen.add(id);
    return ok;
  };
  for (const f of fixtures) if (!visit(f.id)) { out.push({ severity: 'error', path: `${path}.${f.id}`, message: 'fixture references form a cycle' }); break; }
  return out;
}

/** Fixtures in creation order (referenced fixtures first). Assumes validateFixtures passed. */
export function orderFixtures(fixtures: TestFixture[]): TestFixture[] {
  const byId = new Map(fixtures.map((f) => [f.id, f]));
  const out: TestFixture[] = [];
  const done = new Set<string>();
  const visit = (f: TestFixture) => {
    if (done.has(f.id)) return;
    done.add(f.id);
    for (const v of Object.values(f.attributes)) if (typeof v === 'object' && 'fixture' in v && byId.has(v.fixture)) visit(byId.get(v.fixture)!);
    out.push(f);
  };
  fixtures.forEach(visit);
  return out;
}
