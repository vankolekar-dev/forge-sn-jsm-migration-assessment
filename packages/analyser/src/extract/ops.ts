import type { SnRecord } from '@snjsm/collector';
import { analyseScript, intentOf, scriptRisk } from '../script';
import { isTrue, nameOf } from '../store';
import { csv, domainOf, durationMinutes, num, queryFields, type EvidenceDraft, type ExtractContext, type Extractor } from './common';
import { scriptRelations } from './process';

const PRIORITY = /priority\s*(?:=|is)\s*(\d)|\bP([1-5])\b/i;

/** Response vs resolution: from the SLA name and its stop condition. */
export function slaPurpose(r: SnRecord): 'response' | 'resolution' | 'other' {
  const n = `${r.fields['name'] ?? ''} ${r.fields['stop_condition'] ?? ''}`.toLowerCase();
  if (/respon|acknowledg|first|assign|pick ?up|triage/.test(n)) return 'response';
  if (/resol|fulfil|fix|restor|complet|close|deliver|state=3|state=6|state=7/.test(n)) return 'resolution';
  return 'other';
}

function slaDraft(r: SnRecord, ctx: ExtractContext): EvidenceDraft {
  const s = ctx.store;
  const table = r.fields['collection'] || r.fields['table'] || undefined;
  const schedule = s.ref(r, 'schedule', ['cmn_schedule']);
  const minutes = durationMinutes(r.fields['duration']);
  const uses = s.countFor('usage.task-sla-by-sla', 'sla', r);
  const breaches = s.countFor('usage.task-sla-breached', 'sla', r);
  const start = r.fields['start_condition'] || undefined;
  const p = `${r.fields['name'] ?? ''} ${start ?? ''}`.match(PRIORITY);
  return {
    kind: 'sla-definition',
    domain: domainOf(table) ?? 'ITSM',
    intent: `${slaPurpose(r)} target${minutes !== undefined ? ` of ${fmtMinutes(minutes)}` : ''}${table ? ` on ${table}` : ''}${p ? ` for P${p[1] ?? p[2]}` : ''}`,
    intentConfidence: 'high',
    usage: uses !== undefined ? { count: uses, periodDays: s.snapshot.usageDays } : undefined,
    attributes: {
      table, type: r.fields['type'] || undefined, purpose: slaPurpose(r),
      duration: r.fields['duration'] || undefined, durationMinutes: minutes,
      durationType: r.fields['duration_type'] || undefined,
      relativeDurationWorksOn: r.fields['relative_duration_works_on'] || undefined,
      priority: p ? Number(p[1] ?? p[2]) : undefined,
      schedule: schedule ? nameOf(schedule) : s.display(r, 'schedule') || undefined,
      timezoneSource: r.fields['timezone_source'] || undefined,
      start, pause: r.fields['pause_condition'] || undefined, stop: r.fields['stop_condition'] || undefined, reset: r.fields['reset_condition'] || undefined,
      conditionFields: [...new Set([...queryFields(start), ...queryFields(r.fields['pause_condition']), ...queryFields(r.fields['stop_condition'])].map((q) => q.field))],
      retroactive: isTrue(r.fields['retroactive']) || undefined,
      breaches, breachRate: uses && breaches !== undefined ? Math.round((breaches / uses) * 1000) / 1000 : undefined,
    },
    relations: [{ type: 'uses', target: schedule }],
  };
}

export const fmtMinutes = (m: number) => (m >= 1440 && m % 1440 === 0 ? `${m / 1440} day(s)` : m >= 60 ? `${Math.round((m / 60) * 10) / 10} hour(s)` : `${Math.round(m)} minute(s)`);

function notificationDraft(r: SnRecord, ctx: ExtractContext): EvidenceDraft {
  const s = ctx.store;
  const table = r.fields['collection'] || r.fields['table'] || undefined;
  const event = r.fields['event_name'] || undefined;
  const on = event ? `event ${event}` : ['insert', 'update'].filter((o) => isTrue(r.fields[`action_${o}`]) || (r.fields['action'] ?? '').includes(o)).join('/') || 'record change';
  const recipientsFields = csv(r.fields['recipient_fields']);
  const toCustomer = recipientsFields.some((f) => /caller|requested_for|opened_by|requester|customer|contact/.test(f)) || isTrue(r.fields['event_parm_1']) || /requester|customer|caller/i.test(r.fields['name'] ?? '');
  const ev = event ? s.table('sysevent_register').find((e) => e.fields['event_name'] === event) : undefined;
  const a = analyseScript(r.fields['advanced_condition'], 'server');
  return {
    kind: 'notification',
    domain: domainOf(table),
    intent: `Notifies ${toCustomer ? 'the requester/customer' : 'agents or groups'} on ${on}${table ? ` (${table})` : ''}`,
    attributes: {
      table, trigger: event ? 'event' : 'record', event, operations: on,
      audience: toCustomer ? 'customer' : 'agent',
      recipientFields: recipientsFields, recipientUsers: csv(r.fields['recipient_users']).length || undefined, recipientGroups: csv(r.fields['recipient_groups']).length || undefined,
      subject: r.fields['subject'] || undefined, condition: r.fields['condition'] || undefined,
      template: s.display(r, 'template') || undefined, weight: num(r.fields['weight']),
      sendSelf: isTrue(r.fields['send_self']) || undefined, digest: isTrue(r.fields['digestable']) || undefined,
      channel: r.fields['notification_type'] || 'email',
      advancedCondition: a,
    },
    relations: [{ type: 'triggered-by', target: ev }],
  };
}

export const opsExtractors: Extractor[] = [
  { name: 'sla-definition', tables: ['contract_sla'], record: slaDraft },
  {
    name: 'schedule', tables: ['cmn_schedule'], consumes: ['cmn_schedule_span'],
    record: (r, c) => {
      const spans = c.store.childrenOf('cmn_schedule_span', 'schedule', r);
      const days = [...new Set(spans.flatMap((x) => (x.fields['days_of_week'] ?? '').split('')).filter(Boolean))].sort();
      return {
        kind: 'schedule',
        attributes: {
          timeZone: r.fields['time_zone'] || undefined, type: r.fields['type'] || undefined, spans: spans.length || undefined,
          workingDays: days.length ? days.map((d) => ['', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'][Number(d)] ?? d) : undefined,
          holidays: spans.filter((x) => /exclude|holiday/i.test(`${x.fields['type'] ?? ''} ${x.fields['name'] ?? ''}`)).length || undefined,
          hours: spans.filter((x) => x.fields['start_date_time'] && x.fields['end_date_time'] && !/exclude|holiday/i.test(x.fields['type'] ?? '')).slice(0, 3).map((x) => `${x.fields['start_date_time']!.slice(-6)}–${x.fields['end_date_time']!.slice(-6)}`),
          parent: c.store.display(r, 'parent') || undefined,
        },
        intent: 'Working-hours calendar for SLAs',
      };
    },
  },
  {
    name: 'assignment-rule', tables: ['sysrule_assignment'],
    record: (r, c) => {
      const group = c.store.ref(r, 'group', ['sys_user_group']);
      const table = r.fields['table'] || undefined;
      const sc = analyseScript(r.fields['script'], 'server');
      return {
        kind: 'assignment-rule', domain: domainOf(table),
        intent: `Routes ${table ?? 'work'}${group ? ` to ${nameOf(group)}` : ''}${r.fields['condition'] ? ' when conditions match' : ''}`,
        attributes: { table, group: group ? nameOf(group) : c.store.display(r, 'group') || undefined, user: c.store.display(r, 'user') || undefined, condition: r.fields['condition'] || undefined, conditionFields: queryFields(r.fields['condition']).map((q) => q.field), order: num(r.fields['order'] ?? r.fields['priority']), script: sc },
        relations: [{ type: 'assigns-to', target: group }],
      };
    },
  },
  {
    name: 'approval-rule', tables: ['sysrule_approvals'],
    record: (r, c) => {
      const group = c.store.ref(r, 'approval_group', ['sys_user_group']) ?? c.store.ref(r, 'group', ['sys_user_group']);
      const table = r.fields['table'] || undefined;
      return {
        kind: 'approval-rule', domain: domainOf(table),
        intent: `Requires approval on ${table ?? 'records'}${r.fields['condition'] ? ' when conditions match' : ''}`,
        attributes: { table, approver: c.store.display(r, 'approval_user') || undefined, approvalGroup: group ? nameOf(group) : undefined, condition: r.fields['condition'] || undefined, conditionFields: queryFields(r.fields['condition']).map((q) => q.field), order: num(r.fields['order']) },
        relations: [{ type: 'approves', target: group }],
      };
    },
  },
  { name: 'notification', tables: ['sysevent_email_action'], record: notificationDraft },
  {
    name: 'inbound-email-action', tables: ['sysevent_in_email_action'],
    record: (r, c) => {
      const a = analyseScript(r.fields['script'], 'server');
      const table = r.fields['table'] || undefined;
      return {
        kind: 'inbound-email-action', domain: domainOf(table),
        intent: `${r.fields['type'] === 'reply' ? 'Updates' : 'Creates'} ${table ?? 'records'} from incoming email`,
        attributes: { table, type: r.fields['type'] || undefined, action: r.fields['action'] || undefined, condition: r.fields['condition'] || undefined, stopProcessing: isTrue(r.fields['stop_processing']) || undefined, order: num(r.fields['order']), risk: scriptRisk(a), script: a },
        relations: scriptRelations(a, c),
      };
    },
  },
  {
    name: 'email-account', tables: ['sys_email_account'],
    record: (r) => ({ kind: 'integration', intent: `${r.fields['type'] === 'inbound' ? 'Inbound' : 'Outbound'} email channel`, attributes: { integrationType: 'email', direction: r.fields['type'] || undefined, server: r.fields['server'] || undefined, protocol: r.fields['server_type'] || r.fields['protocol'] || undefined, authentication: r.fields['authentication'] || undefined } }),
  },
];

// ── Data model, security, people ──────────────────────────────────────────

const CUSTOM_NAME = /^(u_|x_)/;

export const dataExtractors: Extractor[] = [
  {
    name: 'custom-table', tables: ['sys_db_object'],
    record: (r, c) => {
      const name = r.fields['name'] ?? '';
      if (!CUSTOM_NAME.test(name)) return undefined;
      const fields = c.store.table('sys_dictionary').filter((d) => d.fields['name'] === name && d.fields['element']);
      return { kind: 'table', name: r.fields['label'] ? `${r.fields['label']} (${name})` : name, domain: domainOf(name) ?? 'CUSTOM', custom: true, attributes: { table: name, extends: c.store.display(r, 'super_class') || undefined, fields: fields.length || undefined, scope: c.store.display(r, 'sys_scope') || undefined } };
    },
  },
  {
    name: 'custom-field', tables: ['sys_dictionary'],
    record: (r) => {
      const el = r.fields['element'] ?? '';
      if (!el || !CUSTOM_NAME.test(el) || CUSTOM_NAME.test(r.fields['name'] ?? '')) return undefined; // custom tables are summarised separately
      return {
        kind: 'dictionary-field', name: `${r.fields['name']}.${el}`, domain: domainOf(r.fields['name']), custom: true,
        summary: r.fields['column_label'] || undefined,
        attributes: { table: r.fields['name'] || undefined, element: el, label: r.fields['column_label'] || undefined, type: r.fields['internal_type__display'] || r.fields['internal_type'] || undefined, reference: r.fields['reference'] || undefined, mandatory: isTrue(r.fields['mandatory']) || undefined, defaultValue: r.fields['default_value'] || undefined, maxLength: num(r.fields['max_length']) },
      };
    },
  },
  {
    name: 'choice-list', tables: [], consumes: ['sys_choice'],
    all: () => [], // choices are summarised in the data-model assessment (they explode as evidence)
  },
  {
    name: 'acl', tables: ['sys_security_acl'], consumes: ['sys_security_acl_role'],
    record: (r, c) => {
      const roles = c.store.childrenOf('sys_security_acl_role', 'sys_security_acl', r).map((x) => c.store.display(x, 'sys_user_role')).filter(Boolean);
      const a = analyseScript(r.fields['script'], 'acl');
      const name = r.fields['name'] ?? '';
      const [table, field] = name.split('.');
      return {
        kind: 'acl', domain: domainOf(table),
        intent: `${r.fields['operation'] || 'access'} on ${name}${roles.length ? ` for ${roles.join(', ')}` : ''}${r.fields['condition'] || a ? ' with conditions' : ''}`,
        attributes: { type: r.fields['type'] || undefined, operation: r.fields['operation'] || undefined, table, field: field && field !== '*' ? field : undefined, fieldLevel: Boolean(field && field !== '*') || undefined, roles: roles.length ? roles : a?.roles, condition: r.fields['condition'] || undefined, scripted: Boolean(a) || undefined, adminOverrides: isTrue(r.fields['admin_overrides']) || undefined, risk: scriptRisk(a), script: a },
        relations: scriptRelations(a, c),
      };
    },
  },
  {
    name: 'role', tables: ['sys_user_role'],
    record: (r) => {
      const name = r.fields['name'] ?? '';
      if (!CUSTOM_NAME.test(name) && !/^x_/.test(r.fields['sys_scope__display'] ?? '')) return undefined;
      return { kind: 'role', custom: true, attributes: { name, elevated: isTrue(r.fields['elevated_privilege']) || undefined, assignableBy: r.fields['assignable_by'] || undefined, containsRoles: r.fields['includes_roles'] || undefined } };
    },
  },
  {
    name: 'group', tables: ['sys_user_group'], consumes: ['sys_group_has_role'],
    record: (r, c) => {
      const s = c.store;
      const roles = s.childrenOf('sys_group_has_role', 'group', r).map((x) => s.display(x, 'role')).filter(Boolean);
      const members = s.countFor('usage.group-members', 'group', r);
      const work = (s.countFor('usage.req-item-by-group', 'assignment_group', r) ?? 0) + (s.countFor('usage.sc-task-by-group', 'assignment_group', r) ?? 0) + (s.countFor('usage.incident-by-group', 'assignment_group', r) ?? 0);
      return {
        kind: 'group',
        usage: s.hasUsage ? { count: work, periodDays: s.snapshot.usageDays } : undefined,
        attributes: { type: s.display(r, 'type') || undefined, manager: s.display(r, 'manager') ? 'set' : undefined, parent: s.display(r, 'parent') || undefined, email: r.fields['email'] ? 'set' : undefined, members, roles, fulfils: roles.some((x) => /itil|catalog|fulfil|agent|sn_/.test(x)) || undefined },
        relations: [{ type: 'references', target: s.ref(r, 'parent', ['sys_user_group']) }],
      };
    },
  },
];

export { intentOf };
