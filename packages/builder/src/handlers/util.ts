import type { DesignElement } from '@snjsm/model';
import { getReferenceArtifact } from '@snjsm/reference';
import type { HandlerContext, ManualStep } from '../types';

export const norm = (s: string | undefined) => (s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
/**
 * Name match for site items. Template-created work types can carry a "[System] " prefix on the site
 * ("[System] Service request with approvals"), seen on a live site 2026-10-15; the design keeps the plain name.
 */
const bare = (s: string | undefined) => norm(s).replace(/^\[system\]\s*/, '');
export const nameEq = (a: string | undefined, b: string | undefined) => bare(a) === bare(b);

/** A space design element that targets an existing space instead of creating one. */
export const isExistingSpace = (el: DesignElement): el is Extract<DesignElement, { type: 'space' }> =>
  el.type === 'space' && el.spec.mode === 'existing';

const specName = (el: DesignElement) => (el.spec as { name?: string }).name ?? el.name;

/** Names an element may already have on the site: its own name, and the reference artifact's name if unchanged. */
export function candidateNames(el: DesignElement): string[] {
  const names = [specName(el), el.name];
  const art = el.referenceId ? getReferenceArtifact(el.referenceId) : undefined;
  if (art && art.kind === el.type && el.origin === 'reference') names.push(art.name);
  return [...new Set(names.filter(Boolean).map((n) => n.trim()))];
}

/**
 * The space template creates this element: same kind, the artifact is part of a project template, and the design
 * keeps its name. A configured element with a new name (e.g. a "Hardware requests" queue modelled on the template's
 * "Service requests") is a new element, not the template's.
 */
/** The template an element's reference artifact is part of: a space template or an Assets schema template. */
export function templateOf(el: DesignElement): 'project-template' | 'assets-schema-template' | undefined {
  const art = el.referenceId ? getReferenceArtifact(el.referenceId) : undefined;
  if (!art?.partOf) return undefined;
  const kind = getReferenceArtifact(art.partOf)?.kind;
  return kind === 'project-template' || kind === 'assets-schema-template' ? kind : undefined;
}

/** Template attributes recorded on a reference object type ("attributes.attributes": [{ name, type }]). */
const templateAttributes = (art: { attributes?: unknown }) =>
  ((art.attributes as { attributes?: { name: string }[] } | undefined)?.attributes ?? []).map((a) => a.name);

/**
 * Made by a template when its container is created: a space template's work types, workflows, portal groups,
 * queues and request types; an Assets schema template's object types and their attributes. Only while the design
 * keeps the template's name.
 */
export function isTemplateProvided(el: DesignElement): boolean {
  const art = el.referenceId ? getReferenceArtifact(el.referenceId) : undefined;
  if (!art?.partOf || !templateOf(el)) return false;
  if (el.type === 'assets-attribute' && art.kind === 'assets-object-type') return templateAttributes(art).some((n) => nameEq(n, el.spec.name));
  return art.kind === el.type && nameEq(specName(el), art.name);
}

/** An Assets schema that starts from a template: there is no public API to create one from a template. */
export const isTemplateSchema = (el: DesignElement): boolean => el.type === 'assets-schema' && Boolean(el.spec.templateKey);

/** Provided by the space template or by the platform (built-in and managed fields, default notifications). */
export function isProvided(el: DesignElement): boolean {
  if (el.type === 'field' && (el.spec.systemFieldId || el.spec.fieldType === 'team')) return true;
  if (isExistingSpace(el)) return true;
  if (isTemplateProvided(el)) return true;
  const art = el.referenceId ? getReferenceArtifact(el.referenceId) : undefined;
  return Boolean(art && art.kind === el.type && !art.partOf && el.origin === 'reference' && ['field', 'notification'].includes(el.type));
}

export function matchByName<T extends { name?: string }>(el: DesignElement, items: T[]): T | undefined {
  for (const n of candidateNames(el)) {
    const hit = items.find((i) => nameEq(i.name, n));
    if (hit) return hit;
  }
  return undefined;
}

/** undefined on 404 (not found), rethrow anything else. */
export async function orMissing<T>(p: Promise<T>): Promise<T | undefined> {
  try {
    return await p;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return undefined;
    throw e;
  }
}

export async function cached<T>(ctx: HandlerContext, key: string, fn: () => Promise<T>): Promise<T> {
  if (!ctx.cache.has(key)) ctx.cache.set(key, await fn());
  return ctx.cache.get(key) as T;
}

export const invalidate = (ctx: HandlerContext, prefix: string) => {
  for (const k of [...ctx.cache.keys()]) if (k.startsWith(prefix)) ctx.cache.delete(k);
};

/** Human label for another design element in guided steps: its name (and site id when known). */
export function label(ctx: HandlerContext, designId: string): string {
  const el = ctx.bp.design.find((d) => d.id === designId);
  const r = ctx.remoteOf(designId);
  const name = (el?.spec as { name?: string } | undefined)?.name ?? el?.name ?? designId;
  return r ? `${name} (${r.key ?? r.id})` : name;
}

/** Replace design ids anywhere in a value with their labels (for guided steps and import JSON). */
export function labelDeep(ctx: HandlerContext, v: unknown, pick: 'label' | 'id' = 'label'): unknown {
  const ids = new Set(ctx.bp.design.map((d) => d.id));
  const sub = (x: unknown): unknown => {
    if (typeof x === 'string' && ids.has(x)) return pick === 'id' ? ctx.remoteOf(x)?.id ?? `<${x}>` : label(ctx, x);
    if (Array.isArray(x)) return x.map(sub);
    if (x && typeof x === 'object') return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, sub(y)]));
    return x;
  };
  return sub(v);
}

export function step(ctx: HandlerContext, s: Omit<ManualStep, 'designId'>): ManualStep {
  return { designId: ctx.el.id, ...s };
}

/** Space-scoped elements need the space's service desk id. */
export function serviceDeskOf(ctx: HandlerContext, spaceId: string): string {
  const r = ctx.need(spaceId);
  const sd = r.extra?.['serviceDeskId'];
  if (!sd) throw new Error(`space ${spaceId} has no service desk id recorded`);
  return sd;
}

/** Derive a space / schema key from a name: initials, or the first letters. */
export function keyFrom(name: string, max = 10): string {
  const words = name.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  let k = words.length > 1 ? words.map((w) => w[0]).join('') : (words[0] ?? 'X');
  if (k.length < 2) k = (words[0] ?? 'XX').slice(0, 3);
  if (!/^[A-Z]/.test(k)) k = `X${k}`;
  return k.slice(0, max);
}
