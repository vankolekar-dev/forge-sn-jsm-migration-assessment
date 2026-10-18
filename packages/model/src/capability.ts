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

/**
 * A value for one attribute of a test fixture:
 * - a literal (strings may contain {{param}});
 * - { below | above: param }: a number safely under / over a numeric capability parameter (half / double);
 * - { persona }: the Atlassian account id of a test persona (user attributes);
 * - { fixture }: another fixture's object (reference attributes);
 * - { status }: an Assets status by name (status attributes).
 */
export const FixtureValue = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.object({ below: z.string() }).strict(),
  z.object({ above: z.string() }).strict(),
  z.object({ persona: z.string() }).strict(),
  z.object({ fixture: Id }).strict(),
  z.object({ status: z.string() }).strict(),
]);
export type FixtureValue = z.infer<typeof FixtureValue>;

/**
 * Synthetic test data the acceptance runner creates in the sandbox (tagged, and cleaned up afterwards).
 * Acceptance checks refer to it as "<fixture-id>". Attribute keys are design ids of assets-attribute elements.
 */
export const TestFixture = z.object({
  id: Id,
  description: z.string().min(1),
  kind: z.literal('assets-object'),
  objectTypeId: Id.describe('design id of the Assets object type'),
  attributes: z.record(Id, FixtureValue),
});
export type TestFixture = z.infer<typeof TestFixture>;

/** Test personas acceptance checks can act as or compare with ("<requester>", "as": "requester-manager"). */
export const PERSONAS = ['requester', 'requester-manager', 'agent'] as const;
export type Persona = (typeof PERSONAS)[number];

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
  fixtures: z.array(TestFixture).default([]).describe('synthetic test data for the acceptance checks'),
  verification: Verification,
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
});
export type Capability = z.infer<typeof Capability>;
