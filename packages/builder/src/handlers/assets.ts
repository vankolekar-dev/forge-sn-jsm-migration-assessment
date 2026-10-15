import type { DesignElement } from '@snjsm/model';
import type { Handler, HandlerContext, Remote } from '../types';
import { cached, invalidate, label, matchByName, nameEq, orMissing, step } from './util';

type E<T extends DesignElement['type']> = Extract<DesignElement, { type: T }>;

// ── Schema ────────────────────────────────────────────────────────────────

type Schema = { id: string; name: string; objectSchemaKey: string; description?: string };
const schemas = (ctx: HandlerContext) => cached(ctx, 'assets:schemas', async () => (await ctx.api.assets<{ values?: Schema[] }>('GET', '/objectschema/list?maxResults=100')).values ?? []);

export const assetsSchema: Handler<E<'assets-schema'>> = {
  type: 'assets-schema',
  canCreate: () => true,
  async discover(ctx) {
    const list = await schemas(ctx);
    const s = list.find((x) => x.objectSchemaKey === ctx.el.spec.key) ?? matchByName(ctx.el, list);
    return s && { kind: 'assets-schema', id: String(s.id), key: s.objectSchemaKey, name: s.name };
  },
  desired: (ctx) => ({ name: ctx.el.spec.name, key: ctx.el.spec.key }),
  async observe(ctx, remote) {
    const s = await orMissing(ctx.api.assets<Schema>('GET', `/objectschema/${remote.id}`));
    return s && { name: s.name, key: s.objectSchemaKey };
  },
  preview: (ctx) => [{ method: 'POST', path: '/objectschema/create', body: { name: ctx.el.spec.name, objectSchemaKey: ctx.el.spec.key, description: ctx.el.spec.description } }],
  async create(ctx) {
    const s = await ctx.api.assets<Schema>('POST', '/objectschema/create', { name: ctx.el.spec.name, objectSchemaKey: ctx.el.spec.key, description: ctx.el.spec.description });
    invalidate(ctx, 'assets:schemas');
    return { kind: 'assets-schema', id: String(s.id), key: s.objectSchemaKey, name: s.name };
  },
  manual: (ctx) => step(ctx, {
    title: `Assets schema "${ctx.el.spec.name}"`, why: 'Schema not found and could not be created', where: 'Assets → Object schemas → Create schema',
    instructions: [`Create an empty schema "${ctx.el.spec.name}" with key ${ctx.el.spec.key}.`], values: { ...ctx.el.spec },
    checks: ['The schema opens in Assets.'], record: 'remote-id',
  }),
};

// ── Status type ───────────────────────────────────────────────────────────

const CATEGORY = { inactive: 0, active: 1, pending: 2 } as const;
type Status = { id: string; name: string; category: number };

export const assetsStatusType: Handler<E<'assets-status-type'>> = {
  type: 'assets-status-type',
  canCreate: () => true,
  async discover(ctx) {
    const sid = ctx.el.spec.schemaId ? ctx.remoteOf(ctx.el.spec.schemaId)?.id : undefined;
    if (ctx.el.spec.schemaId && !sid) return undefined;
    const list = await cached(ctx, `assets:status:${sid ?? 'global'}`, () => ctx.api.assets<Status[]>('GET', `/config/statustype${sid ? `?objectSchemaId=${sid}` : ''}`));
    const s = matchByName(ctx.el, list);
    return s && { kind: 'assets-status-type', id: String(s.id), name: s.name };
  },
  preview: (ctx) => [{ method: 'POST', path: '/config/statustype', body: { name: ctx.el.spec.name, category: CATEGORY[ctx.el.spec.category], ...(ctx.el.spec.schemaId ? { objectSchemaId: ctx.ref(ctx.el.spec.schemaId) } : {}) } }],
  async create(ctx) {
    const s = await ctx.api.assets<Status>('POST', '/config/statustype', { name: ctx.el.spec.name, category: CATEGORY[ctx.el.spec.category], ...(ctx.el.spec.schemaId ? { objectSchemaId: ctx.need(ctx.el.spec.schemaId).id } : {}) });
    invalidate(ctx, 'assets:status:');
    return { kind: 'assets-status-type', id: String(s.id), name: s.name };
  },
  manual: (ctx) => step(ctx, {
    title: `Assets status "${ctx.el.spec.name}"`, why: 'Status type could not be created', where: 'Assets → schema → Configure → Statuses',
    instructions: [`Add status "${ctx.el.spec.name}" (category ${ctx.el.spec.category}).`], values: { ...ctx.el.spec }, checks: ['The status is selectable on status attributes.'], record: 'remote-id',
  }),
};

// ── Reference type (guided; discovered when possible) ─────────────────────

export const assetsReferenceType: Handler<E<'assets-reference-type'>> = {
  type: 'assets-reference-type',
  canCreate: () => false,
  async discover(ctx) {
    const sid = ctx.el.spec.schemaId ? ctx.remoteOf(ctx.el.spec.schemaId)?.id : undefined;
    try {
      const list = await cached(ctx, `assets:reftypes:${sid ?? 'global'}`, () => ctx.api.assets<{ id: string; name: string }[]>('GET', `/config/referencetype${sid ? `?objectSchemaId=${sid}` : ''}`));
      const r = matchByName(ctx.el, Array.isArray(list) ? list : []);
      return r && { kind: 'assets-reference-type', id: String(r.id), name: r.name };
    } catch {
      return undefined; // endpoint not verified: fall back to the guided step
    }
  },
  manual: (ctx) => step(ctx, {
    title: `Assets reference type "${ctx.el.spec.name}"`, why: 'Reference type create is not a verified public API',
    where: 'Assets → schema → Configure → Reference types → Add reference type',
    instructions: [`Add the reference type "${ctx.el.spec.name}"${ctx.el.spec.description ? ` (${ctx.el.spec.description})` : ''}.`, 'Record its id: reference attributes need it.'],
    values: { ...ctx.el.spec }, checks: ['It is selectable when adding a reference attribute.'], record: 'remote-id',
  }),
};

// ── Object type ───────────────────────────────────────────────────────────

type OT = { id: string; name: string; parentObjectTypeId?: string; abstractObjectType?: boolean };
const objectTypes = (ctx: HandlerContext, schemaId: string) => cached(ctx, `assets:ots:${schemaId}`, () => ctx.api.assets<OT[]>('GET', `/objectschema/${schemaId}/objecttypes/flat`));

async function iconId(ctx: HandlerContext, want?: string): Promise<string | undefined> {
  const icons = await cached(ctx, 'assets:icons', async () => { try { return await ctx.api.assets<{ id: string; name: string }[]>('GET', '/icon/global'); } catch { return []; } });
  return (icons.find((i) => nameEq(i.name, want)) ?? icons[0])?.id;
}

export const assetsObjectType: Handler<E<'assets-object-type'>> = {
  type: 'assets-object-type',
  canCreate: () => true,
  async discover(ctx) {
    const sid = ctx.remoteOf(ctx.el.spec.schemaId)?.id;
    if (!sid) return undefined;
    const t = matchByName(ctx.el, await objectTypes(ctx, sid));
    return t && { kind: 'assets-object-type', id: String(t.id), name: t.name };
  },
  desired: (ctx) => ({ name: ctx.el.spec.name, ...(ctx.el.spec.parentId ? { parent: ctx.ref(ctx.el.spec.parentId) } : {}) }),
  async observe(ctx, remote) {
    const t = await orMissing(ctx.api.assets<OT>('GET', `/objecttype/${remote.id}`));
    return t && { name: t.name, ...(ctx.el.spec.parentId ? { parent: String(t.parentObjectTypeId ?? '') } : {}) };
  },
  preview: (ctx) => [{
    method: 'POST', path: '/objecttype/create',
    body: { name: ctx.el.spec.name, description: ctx.el.spec.description, objectSchemaId: ctx.ref(ctx.el.spec.schemaId), ...(ctx.el.spec.parentId ? { parentObjectTypeId: ctx.ref(ctx.el.spec.parentId) } : {}), inherited: ctx.el.spec.inheritAttributes, abstractObjectType: ctx.el.spec.abstract, iconId: '<icon>' },
  }],
  async create(ctx) {
    const s = ctx.el.spec;
    const schema = ctx.need(s.schemaId).id;
    const t = await ctx.api.assets<OT>('POST', '/objecttype/create', {
      name: s.name, description: s.description, objectSchemaId: schema, ...(s.parentId ? { parentObjectTypeId: ctx.need(s.parentId).id } : {}),
      inherited: s.inheritAttributes, abstractObjectType: s.abstract, iconId: await iconId(ctx, s.icon),
    });
    invalidate(ctx, `assets:ots:${schema}`);
    return { kind: 'assets-object-type', id: String(t.id), name: t.name };
  },
  manual: (ctx) => step(ctx, {
    title: `Assets object type "${ctx.el.spec.name}"`, why: 'Object type could not be created', where: `Assets → ${label(ctx, ctx.el.spec.schemaId)} → Create object type`,
    instructions: [`Create "${ctx.el.spec.name}"${ctx.el.spec.parentId ? ` under "${label(ctx, ctx.el.spec.parentId)}"` : ''}.`], values: { ...ctx.el.spec },
    checks: ['The object type shows in the schema tree.'], record: 'remote-id',
  }),
};

// ── Attribute ─────────────────────────────────────────────────────────────

/** Assets attribute type codes: type (0 default, 1 reference, 2 user, 4 group, 7 status) and default type ids. */
const DEFAULT_TYPE: Record<string, number> = { text: 0, integer: 1, boolean: 2, float: 3, date: 4, datetime: 6, url: 7, email: 8, textarea: 9, select: 10, ipaddress: 11 };
const KIND: Record<string, number> = { reference: 1, user: 2, group: 4, status: 7 };
type Attr = { id: string; name: string; options?: string; type?: number };
const attributes = (ctx: HandlerContext, otId: string) => cached(ctx, `assets:attrs:${otId}`, () => ctx.api.assets<Attr[]>('GET', `/objecttype/${otId}/attributes`));

function attrBody(ctx: HandlerContext<E<'assets-attribute'>>, ref: (id: string) => string) {
  const s = ctx.el.spec;
  const kind = KIND[s.attributeType];
  return {
    name: s.name, description: s.description, type: kind ?? 0,
    ...(kind === undefined ? { defaultTypeId: DEFAULT_TYPE[s.attributeType] ?? 0 } : {}),
    ...(s.options?.length ? { options: s.options.join(',') } : {}),
    ...(s.reference ? { typeValue: ref(s.reference.targetObjectTypeId), additionalValue: ref(s.reference.referenceTypeId), ...(s.reference.aqlFilter ? { iql: s.reference.aqlFilter } : {}) } : {}),
    ...(s.statusTypeIds?.length ? { typeValueMulti: s.statusTypeIds.map(ref) } : {}),
    minimumCardinality: s.minCardinality, maximumCardinality: s.maxCardinality, uniqueAttribute: s.unique, label: s.label, hidden: s.hidden,
  };
}

export const assetsAttribute: Handler<E<'assets-attribute'>> = {
  type: 'assets-attribute',
  canCreate: () => true,
  async discover(ctx) {
    const ot = ctx.remoteOf(ctx.el.spec.objectTypeId)?.id;
    if (!ot) return undefined;
    const a = matchByName(ctx.el, await attributes(ctx, ot));
    return a && { kind: 'assets-attribute', id: String(a.id), name: a.name, extra: { objectTypeId: ot } };
  },
  desired: (ctx) => ({ name: ctx.el.spec.name, ...(ctx.el.spec.options?.length ? { options: ctx.el.spec.options } : {}) }),
  async observe(ctx, remote) {
    const ot = remote.extra?.['objectTypeId'] ?? ctx.remoteOf(ctx.el.spec.objectTypeId)?.id;
    const a = ot ? (await attributes(ctx, ot)).find((x) => String(x.id) === remote.id) : undefined;
    return a && { name: a.name, ...(ctx.el.spec.options?.length ? { options: (a.options ?? '').split(',').map((o) => o.trim()).filter(Boolean) } : {}) };
  },
  preview: (ctx) => [{ method: 'POST', path: `/objecttypeattribute/${ctx.ref(ctx.el.spec.objectTypeId)}`, body: attrBody(ctx, (id) => ctx.ref(id)) }],
  async create(ctx): Promise<Remote> {
    const ot = ctx.need(ctx.el.spec.objectTypeId).id;
    const a = await ctx.api.assets<Attr>('POST', `/objecttypeattribute/${ot}`, attrBody(ctx, (id) => ctx.need(id).id));
    invalidate(ctx, `assets:attrs:${ot}`);
    return { kind: 'assets-attribute', id: String(a.id), name: a.name, extra: { objectTypeId: ot } };
  },
  async update(ctx, remote, changes) {
    const opt = changes.find((c) => c.path === 'options');
    if (!opt) return;
    const merged = [...new Set([...((opt.have as string[]) ?? []), ...(opt.want as string[])])];
    const ot = remote.extra?.['objectTypeId'] ?? ctx.need(ctx.el.spec.objectTypeId).id;
    await ctx.api.assets('PUT', `/objecttypeattribute/${ot}/${remote.id}`, { name: ctx.el.spec.name, type: KIND[ctx.el.spec.attributeType] ?? 0, defaultTypeId: DEFAULT_TYPE[ctx.el.spec.attributeType] ?? 0, options: merged.join(',') });
    invalidate(ctx, `assets:attrs:${ot}`);
  },
  manual: (ctx) => {
    const s = ctx.el.spec;
    return step(ctx, {
      title: `Assets attribute "${s.name}" on ${label(ctx, s.objectTypeId)}`, why: 'Attribute could not be created', where: `Assets → object type "${label(ctx, s.objectTypeId)}" → Attributes`,
      instructions: [`Add a ${s.attributeType} attribute "${s.name}".`, ...(s.options?.length ? [`Options: ${s.options.join(', ')}.`] : []), ...(s.reference ? [`References "${label(ctx, s.reference.targetObjectTypeId)}" via "${label(ctx, s.reference.referenceTypeId)}".`] : [])],
      values: { ...s, objectTypeId: label(ctx, s.objectTypeId) }, checks: ['The attribute shows on a test object.'], record: 'remote-id',
    });
  },
};
