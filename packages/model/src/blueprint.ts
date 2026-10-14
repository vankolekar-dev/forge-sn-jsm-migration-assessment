import { z } from 'zod';
import { Id, SourceKind } from './common';
import { Evidence } from './evidence';
import { Outcome } from './outcome';
import { DesignElement } from './design';

export const SCHEMA_VERSION = '1.0.0';

export const SourceRef = z.object({
  id: Id,
  kind: SourceKind,
  name: z.string(),
  addedAt: z.string(),
  instance: z.string().optional().describe('ServiceNow instance host for live sources'),
  release: z.string().optional(),
  stats: z.record(z.string(), z.number()).default({}),
});
export type SourceRef = z.infer<typeof SourceRef>;

export const GapResolution = z.enum(['extension', 'marketplace-app', 'forge-app', 'integration', 'process-change', 'out-of-scope', 'unresolved']);

/** How far a capability's design is from the Atlassian standard. */
export const FitGap = z.object({
  score: z.number().min(0).max(100).describe('100 = delivered entirely by reference elements'),
  counts: z.object({ reference: z.number().int(), configured: z.number().int(), extension: z.number().int() }),
  gaps: z
    .array(z.object({ outcomeId: Id.optional(), description: z.string(), resolution: GapResolution, evidenceIds: z.array(Id).default([]) }))
    .default([]),
});
export type FitGap = z.infer<typeof FitGap>;

export const CapabilitySelection = z.object({
  capabilityId: Id,
  catalogueVersion: z.string(),
  status: z.enum(['detected', 'proposed', 'in-scope', 'out-of-scope']),
  detection: z.object({ score: z.number().min(0).max(1), evidenceIds: z.array(Id).default([]) }).optional(),
  fit: FitGap.optional(),
});
export type CapabilitySelection = z.infer<typeof CapabilitySelection>;

/** Audit log of human decisions: sign-offs, overrides, scope changes. */
export const Decision = z.object({
  id: Id,
  at: z.string(),
  by: z.string().describe('Atlassian account id or name'),
  subject: z.object({ kind: z.enum(['outcome', 'capability', 'design-element', 'blueprint']), id: Id }),
  action: z.enum(['confirm', 'reject', 'change', 'defer', 'include', 'exclude', 'sign-off', 'comment']),
  comment: z.string().optional(),
  before: z.unknown().optional(),
  after: z.unknown().optional(),
});
export type Decision = z.infer<typeof Decision>;

/** The Migration Blueprint: the single file passed between collector, analyser, workbench and build pack. */
export const Blueprint = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: Id,
  name: z.string().min(1),
  customer: z.object({ name: z.string().min(1), industry: z.string().optional() }),
  createdAt: z.string(),
  updatedAt: z.string(),
  referenceLibraryVersion: z.string(),
  target: z
    .object({ site: z.string().optional(), edition: z.enum(['free', 'standard', 'premium', 'enterprise']).optional() })
    .default({}),
  sources: z.array(SourceRef).default([]),
  evidence: z.array(Evidence).default([]),
  capabilities: z.array(CapabilitySelection).default([]),
  outcomes: z.array(Outcome).default([]),
  design: z.array(DesignElement).default([]),
  decisions: z.array(Decision).default([]),
});
export type Blueprint = z.infer<typeof Blueprint>;
