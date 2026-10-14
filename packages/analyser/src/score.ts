import type { Evidence } from '@snjsm/model';
import type { AreaAssessment } from './assess/types';
import type { CmdbFacts } from './cmdb';
import type { PracticeDetection } from './detect';

export interface ScoreFactor { id: string; label: string; weight: number; value: number; cap: number; points: number }
export interface ComplexityScore { score: number; band: 'low' | 'moderate' | 'high' | 'very high'; factors: ScoreFactor[] }

/** 0..1 on a log scale: the first few items matter most, then it saturates at `cap`. */
const norm = (x: number, cap: number) => (x <= 0 ? 0 : Math.min(1, Math.log1p(x) / Math.log1p(cap)));
const attr = <T = unknown>(e: Evidence, k: string) => e.attributes[k] as T | undefined;
const active = (e: Evidence) => e.usage?.active !== false;

/**
 * Migration complexity (redesign effort), 0–100. Weighted factors with saturating scales so one huge area does not
 * hide the rest. It measures how much has to be redesigned and verified, not how big the instance is.
 */
export function complexityScore(evidence: Evidence[], areas: AreaAssessment[], practices: PracticeDetection[], cmdb: CmdbFacts): ComplexityScore {
  const count = (pred: (e: Evidence) => boolean) => evidence.filter((e) => active(e) && pred(e)).length;
  const scripts = evidence.filter((e) => active(e) && attr<{ lines: number }>(e, 'script'));
  const lines = scripts.reduce((n, e) => n + (attr<{ lines: number }>(e, 'script')?.lines ?? 0), 0);
  const blockers = areas.flatMap((a) => a.findings).filter((f) => f.severity === 'blocker').length;
  const highs = areas.flatMap((a) => a.findings).filter((f) => f.severity === 'high').length;
  const populated = cmdb.classes.filter((c) => c.count > 0).length;
  const uncovered = practices.filter((p) => !p.covered && !p.parent).length;
  const defs: Omit<ScoreFactor, 'points'>[] = [
    { id: 'catalog', label: 'Catalog items & record producers', weight: 14, value: count((e) => e.kind === 'catalog-item' || e.kind === 'record-producer' || e.kind === 'order-guide'), cap: 400 },
    { id: 'process', label: 'Flows & legacy workflows', weight: 12, value: count((e) => e.kind === 'flow' || e.kind === 'subflow' || e.kind === 'legacy-workflow'), cap: 200 },
    { id: 'script-lines', label: 'Lines of custom script', weight: 16, value: lines, cap: 60000 },
    { id: 'high-risk', label: 'High-complexity scripts', weight: 8, value: count((e) => attr(e, 'risk') === 'high'), cap: 60 },
    { id: 'integrations', label: 'Integrations', weight: 12, value: count((e) => e.kind === 'integration' || e.kind === 'mid-server'), cap: 60 },
    { id: 'data-model', label: 'Custom tables & fields', weight: 8, value: count((e) => (e.kind === 'table' || e.kind === 'dictionary-field') && e.custom === true), cap: 400 },
    { id: 'security', label: 'ACLs & roles', weight: 5, value: count((e) => e.kind === 'acl' || e.kind === 'role'), cap: 800 },
    { id: 'cmdb', label: 'Populated CI classes', weight: 10, value: populated, cap: 120 },
    { id: 'practices', label: 'Practices with no catalogue capability yet', weight: 10, value: uncovered, cap: 12 },
    { id: 'risks', label: 'Blocker / high findings', weight: 5, value: blockers * 3 + highs, cap: 20 },
  ];
  const factors = defs.map((d) => ({ ...d, points: Math.round(d.weight * norm(d.value, d.cap) * 10) / 10 }));
  const total = factors.reduce((n, f) => n + f.weight, 0);
  const score = Math.round((factors.reduce((n, f) => n + f.points, 0) / total) * 100);
  const band = score < 25 ? 'low' : score < 50 ? 'moderate' : score < 75 ? 'high' : 'very high';
  return { score, band, factors };
}
