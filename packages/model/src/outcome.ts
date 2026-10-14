import { z } from 'zod';
import { Confidence, Id, ParamValue, Provenance } from './common';

/** What kind of business result an outcome describes. */
export const OutcomeCategory = z.enum([
  'intake', 'self-service', 'routing', 'approval', 'fulfilment', 'service-level',
  'communication', 'visibility', 'compliance', 'data', 'integration', 'security',
]);
export type OutcomeCategory = z.infer<typeof OutcomeCategory>;

/**
 * Testable acceptance criterion in given/when/then form.
 * `check` lets the verifier run it automatically in a sandbox. Otherwise it is a manual check.
 */
export const AcceptanceCriterion = z.object({
  id: Id,
  given: z.string().min(1),
  when: z.string().min(1),
  then: z.array(z.string().min(1)).min(1),
  verification: z.enum(['automated', 'manual']).default('manual'),
  check: z
    .object({
      kind: z.enum(['create-request', 'transition', 'approve', 'decline', 'wait', 'assert-field', 'assert-status', 'assert-sla', 'assert-notification', 'assert-assignee']),
      spec: z.record(z.string(), z.unknown()).default({}),
    })
    .array()
    .optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const OutcomeStatus = z.enum(['proposed', 'confirmed', 'changed', 'rejected', 'deferred']);
export type OutcomeStatus = z.infer<typeof OutcomeStatus>;

/** A platform-neutral statement of what must be true for the business. This is what the customer signs off. */
export const Outcome = z.object({
  id: Id,
  capabilityId: Id,
  templateId: Id.optional().describe('outcome template in the capability catalogue this was derived from'),
  category: OutcomeCategory,
  statement: z.string().min(10),
  parameters: z.record(z.string(), ParamValue).default({}),
  acceptance: z.array(AcceptanceCriterion).min(1),
  evidenceIds: z.array(Id).default([]),
  derivation: z
    .object({
      method: z.enum(['catalogue-default', 'rules', 'ai', 'human']),
      confidence: Confidence,
      rationale: z.string().optional(),
      provenance: z.array(Provenance).default([]),
    })
    .optional(),
  status: OutcomeStatus.default('proposed'),
  priority: z.enum(['must', 'should', 'could']).default('must'),
  notes: z.string().optional(),
});
export type Outcome = z.infer<typeof Outcome>;
