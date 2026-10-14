import { z } from 'zod';
import { Id } from './common';

/** Specs for Assets (JSM CMDB) design elements. Desired state only. Data import is out of scope. */

export const AssetsSchemaSpec = z.object({
  name: z.string().min(1),
  key: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/),
  description: z.string().optional(),
  templateKey: z.string().optional().describe('Atlassian Assets schema template this schema starts from'),
  purpose: z.string().optional().describe('ownership / permission boundary this schema represents'),
});

export const AssetsStatusTypeSpec = z.object({
  name: z.string().min(1),
  category: z.enum(['active', 'inactive', 'pending']),
  schemaId: Id.optional().describe('omit for a global status type'),
});

export const AssetsReferenceTypeSpec = z.object({
  name: z.string().min(1).describe('e.g. "Depends on", "Installed on", "Owned by"'),
  description: z.string().optional(),
  color: z.string().optional(),
  schemaId: Id.optional(),
});

export const AssetsObjectTypeSpec = z.object({
  name: z.string().min(1),
  schemaId: Id,
  parentId: Id.optional().describe('design id of the parent object type (inheritance)'),
  abstract: z.boolean().default(false),
  inheritAttributes: z.boolean().default(true),
  description: z.string().optional(),
  icon: z.string().optional(),
});

export const AssetsAttributeType = z.enum([
  'text', 'textarea', 'integer', 'float', 'boolean', 'date', 'datetime', 'url', 'email', 'ipaddress',
  'select', 'reference', 'user', 'group', 'status',
]);

export const AssetsAttributeSpec = z.object({
  name: z.string().min(1),
  objectTypeId: Id,
  attributeType: AssetsAttributeType,
  description: z.string().optional(),
  label: z.boolean().default(false).describe('use as the object label'),
  unique: z.boolean().default(false),
  minCardinality: z.number().int().min(0).default(0),
  maxCardinality: z.number().int().min(-1).default(1).describe('-1 = unlimited'),
  options: z.array(z.string()).optional(),
  regex: z.string().optional(),
  reference: z
    .object({ targetObjectTypeId: Id, referenceTypeId: Id, aqlFilter: z.string().optional() })
    .optional(),
  statusTypeIds: z.array(Id).optional(),
  hidden: z.boolean().default(false),
});
