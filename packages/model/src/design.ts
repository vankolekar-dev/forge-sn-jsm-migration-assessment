import { z } from 'zod';
import { Id } from './common';
import {
  AutomationSpec, CalendarSpec, FieldSpec, FormSpec, NotificationSpec, PortalGroupSpec, QueueSpec,
  RequestTypeSpec, SlaSpec, SpaceSpec, TeamSpec, WorkflowSpec, WorkTypeSpec,
} from './design-jsm';
import {
  AssetsAttributeSpec, AssetsObjectTypeSpec, AssetsReferenceTypeSpec, AssetsSchemaSpec, AssetsStatusTypeSpec,
} from './design-assets';

/**
 * Where a design element comes from:
 * - reference: used exactly as the Atlassian reference model ships it
 * - reference-configured: a reference element with customer parameters applied (names, thresholds, goals)
 * - extension: not in the reference model. Needs a justification.
 */
export const Origin = z.enum(['reference', 'reference-configured', 'extension']);
export type Origin = z.infer<typeof Origin>;

export const Justification = z.object({
  reason: z.string().min(10),
  outcomeIds: z.array(Id).default([]),
  evidenceIds: z.array(Id).default([]),
  alternativesConsidered: z.array(z.string()).default([]),
});
export type Justification = z.infer<typeof Justification>;

const base = {
  id: Id,
  name: z.string().min(1),
  origin: Origin,
  referenceId: z.string().optional().describe('id of the reference-library artifact this element is based on'),
  justification: Justification.optional(),
  deliversOutcomeIds: z.array(Id).default([]),
  dependsOn: z.array(Id).default([]),
  notes: z.string().optional(),
};

const el = <T extends string, S extends z.ZodTypeAny>(type: T, spec: S) =>
  z.object({ ...base, type: z.literal(type), spec });

export const DesignElement = z.discriminatedUnion('type', [
  el('space', SpaceSpec),
  el('work-type', WorkTypeSpec),
  el('field', FieldSpec),
  el('portal-group', PortalGroupSpec),
  el('request-type', RequestTypeSpec),
  el('form', FormSpec),
  el('workflow', WorkflowSpec),
  el('calendar', CalendarSpec),
  el('sla', SlaSpec),
  el('queue', QueueSpec),
  el('automation', AutomationSpec),
  el('notification', NotificationSpec),
  el('team', TeamSpec),
  el('assets-schema', AssetsSchemaSpec),
  el('assets-status-type', AssetsStatusTypeSpec),
  el('assets-reference-type', AssetsReferenceTypeSpec),
  el('assets-object-type', AssetsObjectTypeSpec),
  el('assets-attribute', AssetsAttributeSpec),
]);
export type DesignElement = z.infer<typeof DesignElement>;
export type DesignElementType = DesignElement['type'];
export const DESIGN_ELEMENT_TYPES = DesignElement.options.map((o) => o.shape.type.value) as DesignElementType[];

/** Spec fields that hold design ids. Used for dependency checks and build ordering. */
export const SPEC_REFERENCE_FIELDS: Partial<Record<DesignElementType, string[]>> = {
  'work-type': ['workflowId'],
  workflow: ['approvals[].approvers.fieldId', 'approvals[].approvers.groupId', 'approvals[].approvers.objectFieldId'],
  'request-type': ['spaceId', 'workTypeId', 'portalGroupIds', 'formId', 'fields[].fieldId'],
  form: ['sections[].fields[].fieldId'],
  sla: ['spaceId', 'goals[].calendarId'],
  queue: ['spaceId'],
  automation: ['scope.spaceIds'],
  notification: ['spaceId'],
  field: ['assets.objectTypeId'],
  'assets-status-type': ['schemaId'],
  'assets-reference-type': ['schemaId'],
  'assets-object-type': ['schemaId', 'parentId'],
  'assets-attribute': ['objectTypeId', 'reference.targetObjectTypeId', 'reference.referenceTypeId', 'statusTypeIds'],
};
