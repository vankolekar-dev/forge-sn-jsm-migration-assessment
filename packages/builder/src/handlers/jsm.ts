import type { DesignElement, Duration } from '@snjsm/model';
import { isUnreachable } from '@snjsm/atlassian';
import type { Handler, HandlerContext } from '../types';
import { cached, label, labelDeep, matchByName, orMissing, serviceDeskOf, step } from './util';

type E<T extends DesignElement['type']> = Extract<DesignElement, { type: T }>;
const dur = (d: Duration) => `${d.value} ${d.unit.replace('-', ' ')}`;
const spaceWhere = (ctx: HandlerContext, spaceId: string | undefined, rest: string) => `Space "${spaceId ? label(ctx, spaceId) : 'IT service desk'}" → ${rest}`;
const firstSpace = (ctx: HandlerContext) => ctx.bp.design.find((d) => d.type === 'space')?.id;

// ── Portal group ──────────────────────────────────────────────────────────

const groups = (ctx: HandlerContext, sd: string) => cached(ctx, `rtgroups:${sd}`, async () => (await ctx.api.jsm<{ values?: { id: string; name: string }[] }>('GET', `/rest/servicedeskapi/servicedesk/${sd}/requesttypegroup?limit=100`)).values ?? []);

export const portalGroup: Handler<E<'portal-group'>> = {
  type: 'portal-group',
  canCreate: () => false,
  async discover(ctx) {
    const sp = firstSpace(ctx);
    if (!sp || !ctx.remoteOf(sp)) return undefined;
    const hit = matchByName(ctx.el, await groups(ctx, serviceDeskOf(ctx, sp)));
    return hit && { kind: 'portal-group', id: String(hit.id), name: hit.name };
  },
  manual: (ctx) => step(ctx, {
    title: `Portal group "${ctx.el.spec.name}"`, why: 'No public API creates portal groups',
    where: spaceWhere(ctx, firstSpace(ctx), 'Space settings → Request types → Portal groups → Add group'),
    instructions: [`Add the portal group "${ctx.el.spec.name}".`], values: { ...ctx.el.spec },
    checks: ['The group shows on the help center portal.'], record: 'remote-id',
  }),
};

// ── Request type ──────────────────────────────────────────────────────────

type RT = { id: string; name: string; description?: string; helpText?: string; issueTypeId?: string; groupIds?: string[] };
const requestTypes = (ctx: HandlerContext, sd: string) => cached(ctx, `rts:${sd}`, async () => (await ctx.api.jsm<{ values?: RT[] }>('GET', `/rest/servicedeskapi/servicedesk/${sd}/requesttype?limit=100`)).values ?? []);

export const requestType: Handler<E<'request-type'>> = {
  type: 'request-type',
  canCreate: () => true,
  manualAspects: (el) => [
    ...(el.spec.fields.length || el.spec.formId ? ['request form (fields, labels, form)'] : []),
    ...(el.spec.portalGroupIds.length ? ['portal groups'] : []),
  ],
  async discover(ctx) {
    if (!ctx.remoteOf(ctx.el.spec.spaceId)) return undefined;
    const hit = matchByName(ctx.el, await requestTypes(ctx, serviceDeskOf(ctx, ctx.el.spec.spaceId)));
    return hit && { kind: 'request-type', id: String(hit.id), name: hit.name };
  },
  desired: (ctx) => ({ name: ctx.el.spec.name, ...(ctx.el.spec.description ? { description: ctx.el.spec.description } : {}) }),
  async observe(ctx, remote) {
    const sd = serviceDeskOf(ctx, ctx.el.spec.spaceId);
    const rt = await orMissing(ctx.api.jsm<RT>('GET', `/rest/servicedeskapi/servicedesk/${sd}/requesttype/${remote.id}`));
    return rt && { name: rt.name, ...(ctx.el.spec.description ? { description: rt.description ?? '' } : {}) };
  },
  preview: (ctx) => [{
    method: 'POST', path: `/rest/servicedeskapi/servicedesk/${ctx.ref(ctx.el.spec.spaceId, (r) => r.extra?.['serviceDeskId'])}/requesttype`,
    body: { issueTypeId: ctx.ref(ctx.el.spec.workTypeId), name: ctx.el.spec.name, description: ctx.el.spec.description ?? '', helpText: ctx.el.spec.helpText ?? '' }, note: 'experimental servicedeskapi endpoint',
  }],
  async create(ctx) {
    const s = ctx.el.spec;
    const sd = serviceDeskOf(ctx, s.spaceId);
    const rt = await ctx.api.jsm<RT>('POST', `/rest/servicedeskapi/servicedesk/${sd}/requesttype`, { issueTypeId: ctx.need(s.workTypeId).id, name: s.name, description: s.description ?? '', helpText: s.helpText ?? '' });
    ctx.cache.delete(`rts:${sd}`);
    return { kind: 'request-type', id: String(rt.id), name: rt.name };
  },
  manual: (ctx, aspects) => {
    const s = ctx.el.spec;
    const ins: string[] = [];
    if (!aspects.length) ins.push(`Create the request type "${s.name}" using work type "${label(ctx, s.workTypeId)}".`);
    if (s.portalGroupIds.length) ins.push(`Portal groups: ${s.portalGroupIds.map((g) => label(ctx, g)).join(', ')}.`);
    if (s.formId) ins.push(`Attach the form "${label(ctx, s.formId)}" (Request form → Forms).`);
    for (const f of s.fields) ins.push(`Field "${label(ctx, f.fieldId)}"${f.label ? ` shown as "${f.label}"` : ''}: ${f.required ? 'required' : 'optional'}${f.hidden ? ', hidden' : ''}${f.helpText ? `; help text "${f.helpText}"` : ''}.`);
    return step(ctx, {
      title: aspects.length ? `Request type "${s.name}": ${aspects.join(', ')}` : `Request type "${s.name}"`,
      why: aspects.length ? 'Request form layout and portal groups have no public API' : 'Request type was not found and could not be created',
      where: spaceWhere(ctx, s.spaceId, `Space settings → Request types → ${s.name}`),
      instructions: ins, values: labelDeep(ctx, { name: s.name, description: s.description, helpText: s.helpText, portalGroups: s.portalGroupIds, form: s.formId, fields: s.fields }) as Record<string, unknown>,
      checks: [`Open the portal, find "${s.name}" in its group, and check the form shows the fields above.`], record: aspects.length ? 'confirm' : 'remote-id',
    });
  },
};

// ── Form (JSM forms) ──────────────────────────────────────────────────────

export const form: Handler<E<'form'>> = {
  type: 'form',
  canCreate: () => false,
  manual: (ctx) => {
    const s = ctx.el.spec;
    return step(ctx, {
      title: `Form "${s.name}"`, why: 'The Forms API is not verified yet',
      where: spaceWhere(ctx, firstSpace(ctx), 'Space settings → Forms → Create form'),
      instructions: [
        `Create the form "${s.name}" with these sections:`,
        ...s.sections.map((sec) => `• ${sec.title}: ${sec.fields.map((f) => `${label(ctx, f.fieldId)}${f.required ? ' (required)' : ''}${f.condition ? ` [show when ${f.condition}]` : ''}`).join('; ')}`),
        'Link each question to its Jira field so answers are reportable.',
      ],
      values: labelDeep(ctx, { name: s.name, sections: s.sections }) as Record<string, unknown>,
      checks: ['Preview the form: conditional questions appear only when their condition is met.'], record: 'confirm',
    });
  },
};

// ── Calendar, SLA, queue, notification (no public config APIs) ───────────

export const calendar: Handler<E<'calendar'>> = {
  type: 'calendar',
  canCreate: () => false,
  manual: (ctx) => {
    const s = ctx.el.spec;
    return step(ctx, {
      title: `SLA calendar "${s.name}"`, why: 'SLA calendars have no public API',
      where: spaceWhere(ctx, firstSpace(ctx), 'Space settings → SLAs → Calendars → Add calendar'),
      instructions: [`Time zone: ${s.timeZone}.`, ...s.workingHours.map((w) => `Working hours: ${w.days.join(', ')} ${w.start}–${w.end}.`), ...(s.holidays.length ? [`Holidays: ${s.holidays.map((h) => `${h.name} ${h.date}${h.recurring ? ' (yearly)' : ''}`).join('; ')}.`] : [])],
      values: { ...s }, checks: ['The calendar is selectable on SLA goals.'], record: 'confirm',
    });
  },
};

export const sla: Handler<E<'sla'>> = {
  type: 'sla',
  canCreate: () => false,
  manual: (ctx) => {
    const s = ctx.el.spec;
    return step(ctx, {
      title: `SLA "${s.name}"`, why: 'SLA configuration has no public API',
      where: spaceWhere(ctx, s.spaceId, 'Space settings → SLAs'),
      instructions: [
        `Open (or create) the SLA "${s.name}".`,
        `Start: ${s.start.join('; ')}.`, ...(s.pause.length ? [`Pause on: ${s.pause.join('; ')}.`] : []), `Stop: ${s.stop.join('; ')}.`,
        ...s.goals.map((g) => `Goal: ${g.jql || 'all remaining work items'} → ${dur(g.target)}${g.calendarId ? ` on calendar "${label(ctx, g.calendarId)}"` : ''}.`),
      ],
      values: labelDeep(ctx, { ...s }) as Record<string, unknown>,
      checks: ['Raise a matching test request: the SLA appears with the expected target and calendar.'], record: 'confirm',
    });
  },
};

type Q = { id: string; name: string; jql: string };
export const queue: Handler<E<'queue'>> = {
  type: 'queue',
  canCreate: () => false,
  async discover(ctx) {
    if (!ctx.remoteOf(ctx.el.spec.spaceId)) return undefined;
    const sd = serviceDeskOf(ctx, ctx.el.spec.spaceId);
    const qs = await cached(ctx, `queues:${sd}`, async () => (await ctx.api.jsm<{ values?: Q[] }>('GET', `/rest/servicedeskapi/servicedesk/${sd}/queue?limit=100`)).values ?? []);
    const hit = matchByName(ctx.el, qs);
    return hit && { kind: 'queue', id: String(hit.id), name: hit.name };
  },
  desired: (ctx) => ({ name: ctx.el.spec.name, jql: ctx.el.spec.jql }),
  async observe(ctx, remote) {
    const sd = serviceDeskOf(ctx, ctx.el.spec.spaceId);
    const q = await orMissing(ctx.api.jsm<Q>('GET', `/rest/servicedeskapi/servicedesk/${sd}/queue/${remote.id}`));
    return q && { name: q.name, jql: q.jql };
  },
  manual: (ctx) => step(ctx, {
    title: `Queue "${ctx.el.spec.name}"`, why: 'Queues cannot be created or edited through the public API',
    where: spaceWhere(ctx, ctx.el.spec.spaceId, 'Queues → Manage queues → Create queue'),
    instructions: [`Name: ${ctx.el.spec.name}.`, `JQL: ${ctx.el.spec.jql}`, ...(ctx.el.spec.columns.length ? [`Columns: ${ctx.el.spec.columns.join(', ')}.`] : [])],
    values: { ...ctx.el.spec, spaceId: label(ctx, ctx.el.spec.spaceId) }, checks: ['The queue lists only matching open requests.'], record: 'confirm',
  }),
};

export const notification: Handler<E<'notification'>> = {
  type: 'notification',
  canCreate: () => false,
  manual: (ctx) => {
    const s = ctx.el.spec;
    return step(ctx, {
      title: `Notification "${s.name}"`, why: 'Customer notification settings have no public API',
      where: spaceWhere(ctx, s.spaceId, 'Space settings → Notifications → Customer notifications'),
      instructions: [`Audience: ${s.audience}. Event: ${s.event}. Channel: ${s.channel}.`, ...(s.template ? [`Template: ${s.template}`] : ['Keep the Atlassian default template.'])],
      values: { ...s, spaceId: label(ctx, s.spaceId) }, checks: ['Trigger the event on a test request and check the message arrives.'], record: 'confirm',
    });
  },
};

// ── Automation (import JSON, then verify via the rule summary API) ────────

const AUTOMATION_SUMMARY = (cloudId: string) => `https://api.atlassian.com/automation/public/jira/${cloudId}/rest/v1/rule/summary`;

export const automation: Handler<E<'automation'>> = {
  type: 'automation',
  canCreate: () => false,
  async discover(ctx) {
    const cloud = await ctx.api.cloudId();
    let r: { data?: { uuid: string; name: string; state?: string }[] };
    try {
      r = await cached(ctx, 'automation:summary', () => ctx.api.call<{ data?: { uuid: string; name: string; state?: string }[] }>('POST', AUTOMATION_SUMMARY(cloud), { limit: 100 }));
    } catch (e) {
      if (isUnreachable(e)) return undefined; // e.g. from a Forge app: cannot tell, so the rule stays a guided step
      throw e;
    }
    const hit = matchByName(ctx.el, r.data ?? []);
    return hit && { kind: 'automation-rule', id: hit.uuid, name: hit.name };
  },
  manual: (ctx) => {
    const s = ctx.el.spec;
    return step(ctx, {
      title: `Automation rule "${s.name}"`, why: 'Automation rule create is not a verified public API; import the rule JSON instead',
      where: 'Settings → System → Automation → ⋯ → Import rules (or Space settings → Automation)',
      instructions: [
        `Create the rule "${s.name}"${s.templateId ? ` from the template "${s.templateId}"` : ''}.`,
        `Trigger: ${s.trigger.type}.`, ...s.conditions.map((c) => `Condition: ${c.type}.`), ...s.actions.map((a) => `Action: ${a.type}.`),
        `Scope: ${s.scope.global ? 'global' : s.scope.spaceIds.map((x) => label(ctx, x)).join(', ')}. Turn it on after a test run.`,
      ],
      values: { rule: labelDeep(ctx, s, 'label') },
      checks: ['The audit log shows a successful run on a test request.'], record: 'remote-id',
    });
  },
};
