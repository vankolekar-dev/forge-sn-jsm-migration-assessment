import type { CheckStep, FixtureValue, Persona } from '@snjsm/model';

/**
 * Per-site test configuration (acceptance/<host>.json in the work dir). Nothing in it is secret: persona
 * credentials live in the Keychain / environment, never in files.
 */
export interface TestConfig {
  /** Account ids for personas. "requester" defaults to the runner's own account (it raises requests). */
  personas?: Partial<Record<Persona, { accountId?: string }>>;
  /** Use existing Assets objects instead of creating a fixture: fixture id → object id. */
  fixtures?: Record<string, { objectId: string }>;
}

export type CriterionStatus = 'ready' | 'blocked' | 'manual' | 'excluded';

export interface PlannedCriterion {
  outcomeId: string;
  capabilityId: string;
  statement: string;
  acId: string;
  given: string;
  when: string;
  then: string[];
  status: CriterionStatus;
  /** Why it is blocked / excluded / manual. */
  reasons: string[];
  steps: CheckStep[];
  needs: { elements: string[]; fixtures: string[]; actors: string[]; personas: string[] };
}

export interface PlannedFixture {
  id: string;
  capabilityId: string;
  description: string;
  objectTypeId: string;
  /** Attribute design id → value, with {{params}} filled and below/above resolved to numbers. */
  attributes: Record<string, FixtureValue>;
  /** create: the runner creates it; existing: configured to use an existing object; unavailable: cannot be created. */
  status: 'create' | 'existing' | 'unavailable';
  objectId?: string;
  reasons: string[];
}

export interface AcceptancePlan {
  blueprintId: string;
  site: string;
  createdAt: string;
  runHash: string;
  criteria: PlannedCriterion[];
  fixtures: PlannedFixture[];
  /** Persona → known account id (from config) and whether the runner can act as it (has credentials). */
  personas: Record<string, { accountId?: string; canAct: boolean }>;
  summary: Record<CriterionStatus, number>;
}

export type StepResult = 'pass' | 'fail' | 'error' | 'manual' | 'not-run';
export type Verdict = 'pass' | 'fail' | 'error' | 'partial' | 'manual' | 'blocked' | 'excluded';

export interface StepOutcome { index: number; kind: string; result: StepResult; detail: string }

export interface CriterionResult {
  outcomeId: string;
  acId: string;
  verdict: Verdict;
  request?: string;
  steps: StepOutcome[];
  detail?: string;
}

export interface OutcomeResult { outcomeId: string; statement: string; verdict: Verdict; criteria: CriterionResult[] }

/** Everything the run created on the site, so it can be removed (or inspected) afterwards. */
export interface TestDataLedger {
  runId: string;
  tag: string;
  site: string;
  blueprintId: string;
  requests: { key: string; id: string; acId: string }[];
  objects: { id: string; key?: string; fixtureId: string }[];
  cleanup?: { at: string; removed: string[]; leftovers: { ref: string; error: string }[] };
}

export interface AcceptanceResult {
  runId: string;
  runHash: string;
  site: string;
  blueprintId: string;
  startedAt: string;
  finishedAt: string;
  outcomes: OutcomeResult[];
  summary: Record<Verdict, number>;
  manualChecks: { acId: string; check: string }[];
  fixtures: { id: string; result: 'created' | 'existing' | 'unavailable' | 'failed'; objectKey?: string; detail?: string }[];
  ledger: TestDataLedger;
  warnings: string[];
}

/** Injectable time, so tests do not sleep. */
export interface Clock { now(): number; sleep(ms: number): Promise<void> }
export const realClock: Clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) };

/** Tag every test request and object carries: cleanup only ever removes items that still carry it. */
export const TEST_TAG = 'snjsm-test';
export const tagOf = (runId: string) => `[${TEST_TAG} ${runId}]`;
