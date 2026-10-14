import { z } from 'zod';

/** Stable identifier: lowercase letters, digits, dot, dash, underscore, colon. */
export const Id = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/, 'ids must be lowercase and contain only a-z 0-9 . _ : -');
export type Id = z.infer<typeof Id>;

export const Confidence = z.enum(['high', 'medium', 'low']);
export type Confidence = z.infer<typeof Confidence>;

export const Domain = z.enum(['ITSM', 'ITOM', 'ITAM', 'ITBM', 'HR', 'CSM', 'FACILITIES', 'SECOPS', 'GRC', 'CUSTOM']);
export type Domain = z.infer<typeof Domain>;

export const SourceKind = z.enum([
  'servicenow-live',
  'servicenow-xml',
  'screenshot',
  'document',
  'diagram',
  'interview',
  'reference',
  'manual',
]);
export type SourceKind = z.infer<typeof SourceKind>;

/** Where a fact came from. Every evidence item and AI-derived statement must carry at least one. */
export const Provenance = z.object({
  source: SourceKind,
  sourceId: z.string().optional(),
  table: z.string().optional(),
  sysId: z.string().optional(),
  url: z.string().optional(),
  locator: z.string().optional().describe('page/section/shape/region within a document, diagram or screenshot'),
  excerpt: z.string().max(2000).optional(),
  capturedAt: z.string().optional(),
});
export type Provenance = z.infer<typeof Provenance>;

/** Verification status for reference artifacts. Only artifacts captured from a real site may be "verified". */
export const Verification = z.object({
  status: z.enum(['verified', 'unverified', 'deprecated']),
  verifiedOn: z.string().optional(),
  verifiedAgainst: z.string().optional().describe('site / template version the artifact was captured from'),
  notes: z.string().optional(),
});
export type Verification = z.infer<typeof Verification>;

export const Duration = z.object({
  value: z.number().positive(),
  unit: z.enum(['minutes', 'hours', 'business-hours', 'days', 'business-days']),
});
export type Duration = z.infer<typeof Duration>;

export const ParamValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), Duration]);
export type ParamValue = z.infer<typeof ParamValue>;

export const ParamDef = z.object({
  name: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
  type: z.enum(['string', 'number', 'boolean', 'string-list', 'duration', 'choice']),
  description: z.string(),
  default: ParamValue.optional(),
  choices: z.array(z.string()).optional(),
  required: z.boolean().default(false),
});
export type ParamDef = z.infer<typeof ParamDef>;
