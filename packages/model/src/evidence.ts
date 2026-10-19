import { z } from 'zod';
import { Confidence, Domain, Id, Provenance } from './common';

/**
 * Evidence = platform-specific facts about how the current system works.
 * It explains and justifies outcomes. It never defines the target design.
 */
export const EvidenceKind = z.enum([
  // Service catalog & intake
  'catalog-item', 'record-producer', 'catalog-variable', 'variable-set', 'catalog-category', 'order-guide',
  // Process logic
  'flow', 'flow-step', 'subflow', 'legacy-workflow', 'business-rule', 'client-script', 'ui-script', 'ui-policy', 'ui-action',
  'script-include', 'scheduled-job', 'event', 'transform-map',
  // Routing, approvals, service levels, communication
  'assignment-rule', 'approval-rule', 'sla-definition', 'schedule', 'notification', 'inbound-email-action',
  // Data model & security
  'table', 'dictionary-field', 'choice-list', 'acl', 'role', 'group', 'user-criteria',
  // CMDB / assets
  'ci-class', 'ci-attribute', 'ci-relationship-type', 'ci-relationship-stat', 'identification-rule',
  'service', 'service-offering', 'business-application', 'asset-class', 'hardware-model',
  // Experience & knowledge
  'portal', 'portal-widget', 'knowledge-base', 'virtual-agent-topic', 'report', 'dashboard',
  // Integration & platform
  'integration', 'mid-server', 'scoped-app', 'plugin',
  // Unstructured
  'process-step', 'process-diagram', 'screenshot-region', 'document-section',
  'other',
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const Usage = z.object({
  active: z.boolean().optional(),
  count: z.number().int().nonnegative().optional().describe('e.g. requests created in the period'),
  periodDays: z.number().int().positive().optional(),
  lastUsedAt: z.string().optional(),
  fillRate: z.number().min(0).max(1).optional().describe('for fields/attributes: share of records with a value'),
});
export type Usage = z.infer<typeof Usage>;

export const EvidenceRelation = z.object({
  type: z.enum(['contains', 'uses', 'triggers', 'triggered-by', 'references', 'extends', 'approves', 'assigns-to', 'notifies', 'depends-on', 'duplicates']),
  targetId: Id,
});
export type EvidenceRelation = z.infer<typeof EvidenceRelation>;

export const Evidence = z.object({
  id: Id,
  kind: EvidenceKind,
  name: z.string().min(1),
  domain: Domain.optional(),
  summary: z.string().optional().describe('plain-language description of what this artifact does'),
  intent: z.string().optional().describe('business intent extracted by analysis (rules or AI)'),
  intentConfidence: Confidence.optional(),
  provenance: z.array(Provenance).min(1),
  usage: Usage.optional(),
  attributes: z.record(z.string(), z.unknown()).default({}),
  relations: z.array(EvidenceRelation).default([]),
  custom: z.boolean().optional().describe('built by the customer rather than shipped by the vendor'),
});
export type Evidence = z.infer<typeof Evidence>;
