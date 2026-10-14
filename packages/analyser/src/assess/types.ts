export type Severity = 'info' | 'low' | 'medium' | 'high' | 'blocker';
export type Effort = 'S' | 'M' | 'L' | 'XL';

export type AreaId =
  | 'inventory' | 'catalog' | 'process' | 'customisation' | 'routing' | 'service-levels' | 'communication'
  | 'data-model' | 'security' | 'cmdb' | 'integrations' | 'experience' | 'knowledge' | 'reporting' | 'platform';

export interface AssessmentFinding {
  id: string;
  area: AreaId;
  severity: Severity;
  title: string;
  detail: string;
  /** The Atlassian-native way to deliver the outcome (redesign, not replicate). */
  approach?: string;
  recommendation?: string;
  effort?: Effort;
  evidenceIds: string[];
}

export interface AreaAssessment {
  area: AreaId;
  title: string;
  summary: string;
  metrics: Record<string, number | string | boolean>;
  findings: AssessmentFinding[];
  /** Area-specific structured output (e.g. the CMDB rationalisation plan). */
  details?: unknown;
}

let seq = 0;
export const findingId = (area: AreaId, slug: string) => `${area}.${slug}`.toLowerCase().replace(/[^a-z0-9._:-]+/g, '-') || `${area}.${++seq}`;

export const sample = (ids: string[], n = 25) => ids.slice(0, n);
export const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : 0);
