import { Blueprint } from './blueprint';
import { Capability } from './capability';
import { DesignElement, SPEC_REFERENCE_FIELDS } from './design';

export interface Issue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

/** Collect values at a path like "fields[].fieldId" or "reference.targetObjectTypeId". */
export function valuesAtPath(obj: unknown, path: string): string[] {
  const parts = path.split('.');
  let current: unknown[] = [obj];
  for (const part of parts) {
    const isArray = part.endsWith('[]');
    const key = isArray ? part.slice(0, -2) : part;
    const next: unknown[] = [];
    for (const c of current) {
      if (c === null || typeof c !== 'object') continue;
      const v = (c as Record<string, unknown>)[key];
      if (v === undefined || v === null) continue;
      if (isArray && Array.isArray(v)) next.push(...v);
      else next.push(v);
    }
    current = next;
  }
  return current.flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v): v is string => typeof v === 'string');
}

/** All design ids an element depends on: explicit dependsOn plus ids referenced in its spec. */
export function dependenciesOf(el: DesignElement): string[] {
  const fromSpec = (SPEC_REFERENCE_FIELDS[el.type] ?? []).flatMap((p) => valuesAtPath(el.spec, p));
  return [...new Set([...el.dependsOn, ...fromSpec])];
}

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) (seen.has(id) ? dup : seen).add(id);
  return [...dup];
}

/**
 * Validate design elements on their own: unique ids, resolvable dependencies, extensions are justified,
 * and there are no dependency cycles. `external` holds ids that exist outside this set (e.g. other capabilities).
 */
export function validateDesign(elements: DesignElement[], external: Set<string> = new Set()): Issue[] {
  const issues: Issue[] = [];
  const ids = new Set(elements.map((e) => e.id));
  for (const d of duplicates(elements.map((e) => e.id))) issues.push({ severity: 'error', path: `design.${d}`, message: 'duplicate design element id' });
  elements.forEach((el) => {
    const path = `design.${el.id}`;
    for (const dep of dependenciesOf(el)) {
      if (!ids.has(dep) && !external.has(dep)) issues.push({ severity: 'error', path, message: `depends on unknown element "${dep}"` });
    }
    if (el.origin === 'extension' && !el.justification) {
      issues.push({ severity: 'error', path, message: 'extension elements must have a justification' });
    }
    if (el.origin !== 'extension' && !el.referenceId) {
      issues.push({ severity: 'warning', path, message: `${el.origin} element has no referenceId` });
    }
  });
  try {
    buildOrder(elements, external);
  } catch (e) {
    issues.push({ severity: 'error', path: 'design', message: (e as Error).message });
  }
  return issues;
}

/** Topological order (dependencies first). Ties are broken by type, then by original position, so output is stable. */
export function buildOrder(elements: DesignElement[], external: Set<string> = new Set()): DesignElement[] {
  const TYPE_RANK: Record<string, number> = {
    'assets-schema': 0, 'assets-status-type': 1, 'assets-reference-type': 2, 'assets-object-type': 3, 'assets-attribute': 4,
    team: 5, calendar: 6, space: 7, workflow: 8, 'work-type': 9, field: 10, form: 11, 'portal-group': 12,
    'request-type': 13, sla: 14, queue: 15, notification: 16, automation: 17,
  };
  const byId = new Map(elements.map((e) => [e.id, e]));
  const indeg = new Map<string, number>();
  const out = new Map<string, string[]>();
  for (const el of elements) {
    const deps = dependenciesOf(el).filter((d) => byId.has(d) && !external.has(d));
    indeg.set(el.id, deps.length);
    for (const d of deps) out.set(d, [...(out.get(d) ?? []), el.id]);
  }
  const pos = new Map(elements.map((e, i) => [e.id, i]));
  const cmp = (a: string, b: string) =>
    (TYPE_RANK[byId.get(a)!.type] ?? 99) - (TYPE_RANK[byId.get(b)!.type] ?? 99) || pos.get(a)! - pos.get(b)!;
  const ready = elements.filter((e) => indeg.get(e.id) === 0).map((e) => e.id).sort(cmp);
  const order: DesignElement[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(byId.get(id)!);
    for (const n of out.get(id) ?? []) {
      indeg.set(n, indeg.get(n)! - 1);
      if (indeg.get(n) === 0) {
        ready.push(n);
        ready.sort(cmp);
      }
    }
  }
  if (order.length !== elements.length) {
    const stuck = elements.filter((e) => !order.includes(e)).map((e) => e.id);
    throw new Error(`dependency cycle among: ${stuck.join(', ')}`);
  }
  return order;
}

/** Validate a catalogue capability: design integrity plus outcome → design traceability. */
export function validateCapability(cap: Capability, external: Set<string> = new Set()): Issue[] {
  const issues = validateDesign(cap.design.elements, external).map((i) => ({ ...i, path: `${cap.id}.${i.path}` }));
  const ids = new Set(cap.design.elements.map((e) => e.id));
  for (const d of duplicates(cap.outcomes.map((o) => o.id))) issues.push({ severity: 'error', path: `${cap.id}.outcomes`, message: `duplicate outcome id ${d}` });
  for (const o of cap.outcomes) {
    for (const ref of o.deliveredBy) {
      if (!ids.has(ref)) issues.push({ severity: 'error', path: `${cap.id}.outcomes.${o.id}`, message: `deliveredBy unknown element "${ref}"` });
    }
    const placeholders = [...o.statement.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
    const params = new Set(o.parameters.map((p) => p.name));
    for (const ph of placeholders) {
      if (!params.has(ph!)) issues.push({ severity: 'error', path: `${cap.id}.outcomes.${o.id}`, message: `placeholder {{${ph}}} has no parameter definition` });
    }
  }
  // An element is "used" if it delivers an outcome, if a used element depends on it, or if it is an Assets
  // attribute / object type that belongs to a used element. Seed with outcome deliverers only.
  const byId = new Map(cap.design.elements.map((e) => [e.id, e]));
  const used = new Set(cap.outcomes.flatMap((o) => o.deliveredBy));
  let grew = true;
  while (grew) {
    grew = false;
    for (const el of cap.design.elements) {
      const deps = dependenciesOf(el);
      if (used.has(el.id)) {
        for (const d of deps) if (byId.has(d) && !used.has(d)) { used.add(d); grew = true; }
      } else if ((el.type === 'assets-attribute' || el.type === 'assets-object-type') && deps.some((d) => used.has(d))) {
        used.add(el.id);
        grew = true;
      }
    }
  }
  for (const el of cap.design.elements) {
    if (!used.has(el.id)) {
      issues.push({ severity: 'warning', path: `${cap.id}.design.${el.id}`, message: 'element delivers no outcome and nothing depends on it' });
    }
  }
  return issues;
}

/** Validate a full blueprint: schema-level references between evidence, outcomes, capabilities and design. */
export function validateBlueprint(bp: Blueprint): Issue[] {
  const issues = validateDesign(bp.design);
  const evidence = new Set(bp.evidence.map((e) => e.id));
  const outcomes = new Set(bp.outcomes.map((o) => o.id));
  const caps = new Set(bp.capabilities.map((c) => c.capabilityId));
  for (const d of duplicates(bp.evidence.map((e) => e.id))) issues.push({ severity: 'error', path: 'evidence', message: `duplicate evidence id ${d}` });
  for (const d of duplicates(bp.outcomes.map((o) => o.id))) issues.push({ severity: 'error', path: 'outcomes', message: `duplicate outcome id ${d}` });
  for (const e of bp.evidence) {
    for (const r of e.relations) if (!evidence.has(r.targetId)) issues.push({ severity: 'warning', path: `evidence.${e.id}`, message: `relation to unknown evidence "${r.targetId}"` });
  }
  for (const o of bp.outcomes) {
    if (!caps.has(o.capabilityId)) issues.push({ severity: 'error', path: `outcomes.${o.id}`, message: `unknown capability "${o.capabilityId}"` });
    for (const ev of o.evidenceIds) if (!evidence.has(ev)) issues.push({ severity: 'error', path: `outcomes.${o.id}`, message: `unknown evidence "${ev}"` });
  }
  for (const el of bp.design) {
    for (const oid of el.deliversOutcomeIds) if (!outcomes.has(oid)) issues.push({ severity: 'error', path: `design.${el.id}`, message: `delivers unknown outcome "${oid}"` });
    for (const ev of el.justification?.evidenceIds ?? []) if (!evidence.has(ev)) issues.push({ severity: 'error', path: `design.${el.id}`, message: `justification cites unknown evidence "${ev}"` });
    for (const oid of el.justification?.outcomeIds ?? []) if (!outcomes.has(oid)) issues.push({ severity: 'error', path: `design.${el.id}`, message: `justification cites unknown outcome "${oid}"` });
  }
  const confirmed = bp.outcomes.filter((o) => o.status === 'confirmed' || o.status === 'changed');
  for (const o of confirmed) {
    if (!bp.design.some((el) => el.deliversOutcomeIds.includes(o.id))) issues.push({ severity: 'warning', path: `outcomes.${o.id}`, message: 'confirmed outcome is not delivered by any design element' });
  }
  return issues;
}
