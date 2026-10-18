import type { Blueprint, CoverageStatus, DesignElement, DesignElementType } from '@snjsm/model';

/**
 * The subset of the Atlassian client the engine uses. AtlassianClient satisfies it; tests use an in-memory fake.
 * Writes only happen through this interface, and only when `readOnly` is false.
 */
export interface SiteApi {
  readonly siteUrl: string;
  readonly readOnly: boolean;
  jira<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  jsm<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  assets<T = any>(method: string, path: string, body?: unknown): Promise<T>;
  call<T = any>(method: string, url: string, body?: unknown): Promise<T>;
  cloudId(): Promise<string>;
}

/** Where an element lives on the site once built. */
export interface Remote {
  kind: string;
  id: string;
  key?: string;
  name?: string;
  /** Extra ids handlers need later (e.g. a space's service desk id, a field's context id). */
  extra?: Record<string, string>;
}

/** One property the engine can compare between desired and observed state. */
export interface Change { path: string; want: unknown; have: unknown; fixable: boolean }

/** A request the engine would send. Shown in dry-run, never sent there. */
export interface RequestPreview { method: string; path: string; body?: unknown; note?: string }

/** How the engine intends to build an element before it has looked at the site. */
export type Strategy =
  | 'adopt' // provided by the space template or the platform: find it and bind to it
  | 'create' // create through the public API
  | 'create+manual' // create through the API, then guided steps for aspects with no API
  | 'manual'; // guided manual step, checked afterwards

/** What the engine will actually do, once it has looked at the site (dry-run) or the state file. */
export type Action =
  | 'noop' // already built and unchanged
  | 'adopt' // exists: bind to it
  | 'create'
  | 'update' // exists, spec changed, the change is fixable through the API (additive only)
  | 'manual' // a person does it (or finishes it) with guided instructions
  | 'blocked'; // waits for a dependency (usually a pending manual step)

export interface ManualStep {
  designId: string;
  title: string;
  why: string;
  /** Where to go in the product UI. */
  where: string;
  instructions: string[];
  /** The exact configuration to enter. */
  values: Record<string, unknown>;
  /** How to check it was done right. */
  checks: string[];
  /** What to record afterwards: the remote id (dependents need it) or just a confirmation. */
  record: 'remote-id' | 'confirm';
}

export interface PlanStep {
  designId: string;
  type: DesignElementType;
  name: string;
  capabilityIds: string[];
  strategy: Strategy;
  action: Action;
  reason: string;
  coverage: CoverageStatus;
  specHash: string;
  dependsOn: string[];
  blockedBy?: string[];
  remote?: Remote;
  changes?: Change[];
  requests?: RequestPreview[];
  manual?: ManualStep;
  /** Values the dry-run resolved from the site (e.g. a free space key); part of the plan hash. */
  resolved?: Record<string, string>;
}

export interface Plan {
  blueprintId: string;
  site?: string;
  mode: 'offline' | 'dry-run';
  createdAt: string;
  scope: { capabilityIds?: string[]; elementIds?: string[] };
  steps: PlanStep[];
  /** Hash of (designId, action, specHash) for every step. apply refuses to run a different plan. */
  planHash: string;
  summary: Record<Action, number>;
  warnings: string[];
}

export type ElementStatus = 'created' | 'adopted' | 'updated' | 'manual-pending' | 'manual-done' | 'failed';

export interface ElementState {
  designId: string;
  type: DesignElementType;
  status: ElementStatus;
  remote?: Remote;
  /** Spec hash at the time it was last built or confirmed. A different hash means the design changed. */
  specHash: string;
  /** API-created elements that still need guided steps for some aspects. */
  manualPending?: string[];
  at: string;
  by?: string;
  note?: string;
  error?: string;
  verifiedAt?: string;
  verifyResult?: VerifyStatus;
}

export interface RunRecord { id: string; op: 'apply' | 'confirm-manual' | 'verify' | 'acceptance'; at: string; planHash?: string; summary: string }

export interface BuildState {
  schemaVersion: '1';
  blueprintId: string;
  site: string;
  createdAt: string;
  updatedAt: string;
  elements: Record<string, ElementState>;
  runs: RunRecord[];
}

export type VerifyStatus = 'ok' | 'drift' | 'missing' | 'pending' | 'unverifiable' | 'not-built' | 'error';

export interface VerifyResult { designId: string; type: DesignElementType; name: string; status: VerifyStatus; detail: string; changes?: Change[] }
export interface VerifyReport { site: string; at: string; results: VerifyResult[]; summary: Record<VerifyStatus, number> }

export interface Handler<E extends DesignElement = DesignElement> {
  type: E['type'];
  /** API create exists in this engine for this element (independent of the coverage matrix status). */
  canCreate(el: E): boolean;
  /** Aspects that always need a guided step even after an API create (e.g. request type field layout). */
  manualAspects?(el: E): string[];
  /** Find an existing element by its natural key (name, key) in its parent scope. Read-only. */
  discover?(ctx: HandlerContext<E>): Promise<Remote | undefined>;
  /** Comparable projection of the desired spec (only properties `observe` can read). */
  desired?(ctx: HandlerContext<E>): Record<string, unknown>;
  /** Comparable projection read from the site. Read-only. */
  observe?(ctx: HandlerContext<E>, remote: Remote): Promise<Record<string, unknown> | undefined>;
  /**
   * Live pre-build check, read-only, for elements not built yet: conflicts a person must resolve (returned as a
   * problem, which blocks the step and its dependents) and values resolved from the site (e.g. a free key).
   */
  check?(ctx: HandlerContext<E>, found: Remote | undefined): Promise<CheckResult | undefined>;
  /** Known limits of the target API, checked in every plan mode before a create (e.g. a maximum description length). */
  validate?(el: E): string | undefined;
  /** Requests create would send (dependencies not built yet appear as <design-id>). */
  preview?(ctx: HandlerContext<E>): RequestPreview[];
  create?(ctx: HandlerContext<E>): Promise<Remote>;
  /** Additive updates only: never deletes options, attributes or configuration. */
  update?(ctx: HandlerContext<E>, remote: Remote, changes: Change[]): Promise<void>;
  /** Guided step for the whole element, or for the aspects the API cannot do. */
  manual(ctx: HandlerContext<E>, aspects: string[]): ManualStep;
}

export interface CheckResult {
  problem?: string;
  note?: string;
  resolved?: Record<string, string>;
}

export interface HandlerContext<E extends DesignElement = DesignElement> {
  api: SiteApi;
  bp: Blueprint;
  el: E;
  /** Remote of another design element (from the state file or this run). */
  remoteOf(designId: string): Remote | undefined;
  /** Same, but throws BlockedError when it is not built yet. */
  need(designId: string): Remote;
  /** Placeholder for previews: the remote id when known, else <design-id>. */
  ref(designId: string, pick?: (r: Remote) => string | undefined): string;
  /** Per-run cache for expensive reads (field list, icons...). */
  cache: Map<string, unknown>;
  options: BuildOptions;
}

export interface BuildOptions {
  /** Atlassian account id used as project lead when creating spaces (default: the caller). */
  leadAccountId?: string;
}

export class BlockedError extends Error {
  constructor(readonly designId: string) {
    super(`waiting for ${designId}`);
    this.name = 'BlockedError';
  }
}
