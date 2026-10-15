import { z } from 'zod';
import { Duration, Id } from './common';

/** Specs for Jira / JSM design elements. Values are desired state, not API payloads. */

export const StatusCategory = z.enum(['TODO', 'IN_PROGRESS', 'DONE']);

export const SpaceSpec = z
  .object({
    name: z.string().min(1),
    mode: z
      .enum(['new', 'existing'])
      .default('new')
      .describe('new: create the space from the template; existing: build into the space with this key (nothing is re-created)'),
    key: z
      .string()
      .regex(/^[A-Z][A-Z0-9]{1,9}$/)
      .optional()
      .describe('new: the wanted key (a free key is chosen from the name when omitted); existing: the key of the space'),
    productType: z.enum(['service_desk', 'software', 'business']).default('service_desk'),
    templateKey: z.string().describe('Atlassian project template key, e.g. the JSM IT service management template'),
    description: z.string().optional(),
  })
  .refine((s) => s.mode !== 'existing' || Boolean(s.key), { message: 'building into an existing space needs its key', path: ['key'] });

export const WorkTypeSpec = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  hierarchyLevel: z.number().int().min(-1).max(1).default(0),
  workflowId: Id.optional(),
});

export const FieldType = z.enum([
  'text', 'paragraph', 'number', 'date', 'datetime', 'select', 'multiselect', 'radio', 'checkbox',
  'cascading-select', 'user', 'multiuser', 'group', 'url', 'labels', 'assets-object', 'team',
]);

export const FieldSpec = z.object({
  name: z.string().min(1),
  fieldType: FieldType,
  description: z.string().optional(),
  systemFieldId: z.string().optional().describe('set when the reference uses a built-in field (summary, description, priority, components…)'),
  options: z.array(z.string()).optional(),
  assets: z
    .object({ objectTypeId: Id, aqlFilter: z.string().optional(), multiple: z.boolean().default(false) })
    .optional()
    .describe('for assets-object fields: the design id of the Assets object type plus an optional AQL scope'),
});

export const FieldUse = z.object({
  fieldId: Id,
  required: z.boolean().default(false),
  label: z.string().optional().describe('portal label, if it differs from the field name'),
  helpText: z.string().optional(),
  defaultValue: z.unknown().optional(),
  hidden: z.boolean().default(false),
});

export const PortalGroupSpec = z.object({ name: z.string().min(1), order: z.number().int().optional() });

export const RequestTypeSpec = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  helpText: z.string().optional(),
  spaceId: Id,
  workTypeId: Id,
  portalGroupIds: z.array(Id).default([]),
  fields: z.array(FieldUse).default([]),
  formId: Id.optional(),
  icon: z.string().optional(),
});

export const FormSpec = z.object({
  name: z.string().min(1),
  sections: z
    .array(
      z.object({
        title: z.string(),
        fields: z.array(FieldUse.extend({ condition: z.string().optional().describe('show when, e.g. "Hardware type = Laptop"') })),
      }),
    )
    .min(1),
});

export const ApproverRule = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('requester-manager'), managerSource: z.enum(['assets-person', 'user-profile', 'field']).default('assets-person') }),
  z.object({ kind: z.literal('group'), groupId: Id }),
  z.object({ kind: z.literal('field'), fieldId: Id }),
  z.object({ kind: z.literal('assets-attribute'), objectFieldId: Id, attribute: z.string() }),
]);

export const WorkflowSpec = z.object({
  name: z.string().min(1),
  statuses: z.array(z.object({ id: Id, name: z.string().min(1), category: StatusCategory })).min(2),
  initialStatusId: Id,
  transitions: z.array(
    z.object({
      id: Id,
      name: z.string().min(1),
      from: z.array(Id).describe('empty = from any status'),
      to: Id,
      conditions: z.array(z.string()).default([]),
      validators: z.array(z.string()).default([]),
      postFunctions: z.array(z.string()).default([]),
    }),
  ),
  approvals: z
    .array(z.object({ atStatusId: Id, approvers: ApproverRule, decision: z.enum(['one', 'all']).default('one'), approveTransitionId: Id, declineTransitionId: Id }))
    .default([]),
});

export const CalendarSpec = z.object({
  name: z.string().min(1),
  timeZone: z.string().default('UTC'),
  workingHours: z.array(z.object({ days: z.array(z.enum(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'])), start: z.string(), end: z.string() })).min(1),
  holidays: z.array(z.object({ name: z.string(), date: z.string(), recurring: z.boolean().default(false) })).default([]),
});

export const SlaSpec = z.object({
  name: z.string().min(1),
  spaceId: Id,
  start: z.array(z.string()).min(1).describe('conditions, e.g. "Issue created", "Entered status: Waiting for support"'),
  pause: z.array(z.string()).default([]),
  stop: z.array(z.string()).min(1),
  goals: z.array(z.object({ jql: z.string().default(''), target: Duration, calendarId: Id.optional() })).min(1),
});

export const QueueSpec = z.object({ name: z.string().min(1), spaceId: Id, jql: z.string().min(1), columns: z.array(z.string()).default([]) });

export const AutomationSpec = z.object({
  name: z.string().min(1),
  scope: z.object({ spaceIds: z.array(Id).default([]), global: z.boolean().default(false) }),
  templateId: z.string().optional().describe('Atlassian automation template this rule is based on'),
  trigger: z.object({ type: z.string().min(1), config: z.record(z.string(), z.unknown()).default({}) }),
  conditions: z.array(z.object({ type: z.string(), config: z.record(z.string(), z.unknown()).default({}) })).default([]),
  actions: z.array(z.object({ type: z.string(), config: z.record(z.string(), z.unknown()).default({}) })).min(1),
});

export const NotificationSpec = z.object({
  name: z.string().min(1),
  spaceId: Id,
  audience: z.enum(['customer', 'agents', 'approvers', 'watchers', 'group']),
  event: z.string().min(1),
  channel: z.enum(['email', 'portal', 'slack', 'teams']).default('email'),
  template: z.string().optional(),
});

export const TeamSpec = z.object({ name: z.string().min(1), purpose: z.string().optional(), kind: z.enum(['atlassian-team', 'group']).default('atlassian-team') });
