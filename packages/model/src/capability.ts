import { z } from 'zod';
import { Domain, Id, ParamDef, Verification } from './common';
import { AcceptanceCriterion, OutcomeCategory } from './outcome';
import { DesignElement } from './design';

/** How the analyser recognises that a ServiceNow instance implements this capability. */
export const EvidenceSignal = z.object({
  description: z.string(),
  tables: z.array(z.string()).default([]),
  keywords: z.array(z.string()).default([]).describe('matched case-insensitively against names, categories and descriptions'),
  evidenceKinds: z.array(z.string()).default([]),
  weight: z.number().min(0).max(1).default(0.5),
});
export type EvidenceSignal = z.infer<typeof EvidenceSignal>;

/** A reusable outcome with {{param}} placeholders that the analyser fills in from evidence. */
export const OutcomeTemplate = z.object({
  id: Id,
  category: OutcomeCategory,
  statement: z.string().min(10),
  parameters: z.array(ParamDef).default([]),
  acceptance: z.array(AcceptanceCriterion).min(1),
  deliveredBy: z.array(Id).min(1).describe('design element ids in the reference design that deliver this outcome'),
  evidenceHints: z.array(z.string()).default([]).describe('what ServiceNow evidence sets or overrides the parameters'),
});
export type OutcomeTemplate = z.infer<typeof OutcomeTemplate>;

/** Reference design for a capability: Atlassian-native elements that deliver its outcomes. */
export const ReferenceDesign = z.object({
  id: Id,
  description: z.string(),
  basedOn: z.array(z.string()).describe('reference-library artifact ids this design reuses (templates, schemas)'),
  elements: z.array(DesignElement).min(1),
});
export type ReferenceDesign = z.infer<typeof ReferenceDesign>;

/** One entry in the reusable capability catalogue. */
export const Capability = z.object({
  id: Id,
  domain: Domain,
  practice: z.string().describe('ITSM practice, e.g. service-request, incident, change, problem, asset'),
  name: z.string().min(1),
  description: z.string().min(10),
  dependsOn: z.array(Id).default([]),
  outcomes: z.array(OutcomeTemplate).min(1),
  design: ReferenceDesign,
  signals: z.array(EvidenceSignal).min(1),
  verification: Verification,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type Capability = z.infer<typeof Capability>;
