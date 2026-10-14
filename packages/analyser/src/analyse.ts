import type { Snapshot } from '@snjsm/collector';
import {
  Blueprint, SCHEMA_VERSION, validateBlueprint, type CapabilitySelection, type DesignElement, type Evidence, type Issue, type Outcome, type ParamValue,
} from '@snjsm/model';
import { CATALOGUE_VERSION, listCapabilities } from '@snjsm/reference';
import { AREA_ASSESSORS } from './assess/areas';
import { assessCmdb } from './assess/cmdb';
import type { AreaAssessment } from './assess/types';
import { cmdbFacts, type CmdbFacts } from './cmdb';
import { detectCapabilities, detectPractices, type CapabilityDetection, type PracticeDetection } from './detect';
import { extractEvidence } from './extract';
import { buildability, fitGap, type Buildability } from './fitgap';
import { deriveCapability } from './outcomes';
import type { ParamResolution } from './params';
import { complexityScore, type ComplexityScore } from './score';
import { RecordStore } from './store';

export interface AnalyseOptions {
  customer: string;
  industry?: string;
  name?: string;
  target?: Blueprint['target'];
  /** Restrict to these catalogue capabilities (default: all). */
  capabilities?: string[];
  /** Force capabilities in scope even when not detected. */
  include?: string[];
  /** Human parameter overrides per capability: { 'itsm.request-hardware': { costThreshold: 1500 } }. */
  overrides?: Record<string, Record<string, ParamValue>>;
  /** Cap on evidence copied into the blueprint (referenced evidence is always kept). Default: all. */
  maxEvidence?: number;
  now?: string;
}

export interface CapabilityAssessment {
  capabilityId: string;
  name: string;
  practice: string;
  detection: CapabilityDetection;
  parameters: ParamResolution[];
  buildability: Buildability;
  outcomeIds: string[];
  designIds: string[];
}

export interface Unknown { topic: string; detail: string; howToResolve: string }

export interface Assessment {
  generatedAt: string;
  source: Snapshot['source'];
  usageDays?: number;
  hasUsage: boolean;
  score: ComplexityScore;
  areas: AreaAssessment[];
  practices: PracticeDetection[];
  capabilities: CapabilityAssessment[];
  cmdb: CmdbFacts;
  unknowns: Unknown[];
  extraction: { evidence: number; relations: number; unextracted: Record<string, number>; warnings: string[] };
  validation: Issue[];
}

export interface AnalysisResult { blueprint: Blueprint; assessment: Assessment }

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'x';

/** Merge design elements shared by several capabilities (e.g. the IT service space). First definition wins. */
function mergeDesign(parts: DesignElement[][]): { design: DesignElement[]; conflicts: string[] } {
  const byId = new Map<string, DesignElement>();
  const conflicts: string[] = [];
  for (const el of parts.flat()) {
    const cur = byId.get(el.id);
    if (!cur) { byId.set(el.id, el); continue; }
    cur.deliversOutcomeIds = [...new Set([...cur.deliversOutcomeIds, ...el.deliversOutcomeIds])];
    if (JSON.stringify(cur.spec) !== JSON.stringify(el.spec)) conflicts.push(`${el.id}: capabilities configure it differently; the first configuration is used`);
  }
  return { design: [...byId.values()], conflicts };
}

function unknownsOf(snapshot: Snapshot, store: RecordStore, cmdb: CmdbFacts, evidence: Evidence[], caps: CapabilityAssessment[], practices: PracticeDetection[], unextracted: Record<string, number>): Unknown[] {
  const out: Unknown[] = [];
  if (!store.hasUsage) out.push({ topic: 'Usage', detail: 'No usage data (request volumes, flow runs, SLA breaches). Unused items cannot be retired with confidence and parameters are not weighted by volume.', howToResolve: 'Run the live collector (read-only, aggregates only).' });
  const unknownOrigin = evidence.filter((e) => e.custom === undefined).length;
  if (unknownOrigin > evidence.length / 2) out.push({ topic: 'Customisation origin', detail: `${unknownOrigin} of ${evidence.length} artifacts have no audit fields, so custom vs vendor is unknown.`, howToResolve: 'Use the live collector, or export with sys_created_by / sys_scope.' });
  if (!cmdb.available) out.push({ topic: 'CMDB', detail: 'No CMDB metadata or counts.', howToResolve: 'Run the live collector (class metadata and counts only).' });
  for (const c of caps) for (const p of c.parameters.filter((x) => x.method === 'catalogue-default')) out.push({ topic: `${c.name}: ${p.name}`, detail: `No evidence; using the catalogue default (${typeof p.value === 'object' ? JSON.stringify(p.value) : String(p.value)}).`, howToResolve: 'Confirm in the outcome workshop.' });
  const gaps = practices.filter((p) => !p.covered && !p.parent);
  if (gaps.length) out.push({ topic: 'Catalogue coverage', detail: `No catalogue capability yet for: ${gaps.map((p) => p.label).join(', ')}.`, howToResolve: 'Add capabilities to the reference catalogue, or scope these practices out explicitly.' });
  const skipped = snapshot.warnings.filter((w) => /skipp|unknown table/i.test(w));
  if (skipped.length) out.push({ topic: 'Skipped tables', detail: skipped.slice(0, 5).join('; '), howToResolve: 'Extend the collector table list if these matter.' });
  const un = Object.entries(unextracted).filter(([, n]) => n > 0);
  if (un.length) out.push({ topic: 'Unextracted records', detail: un.slice(0, 10).map(([t, n]) => `${t} (${n})`).join(', '), howToResolve: 'Add an extractor if these tables carry business behaviour.' });
  return out;
}

/** Snapshot → assessment + Migration Blueprint (outcomes proposed, design from the Atlassian reference). */
export function analyse(snapshot: Snapshot, opts: AnalyseOptions): AnalysisResult {
  const now = opts.now ?? new Date().toISOString();
  const store = new RecordStore(snapshot);
  const extraction = extractEvidence(snapshot, store);
  const evidence = extraction.evidence;
  const byId = new Map(evidence.map((e) => [e.id, e]));
  const hasUsage = store.hasUsage;

  const input = { evidence, store, hasUsage };
  const areas: AreaAssessment[] = AREA_ASSESSORS.map((a) => a(input));
  const cmdb = cmdbFacts(store);
  const ciEvidence = new Map(evidence.filter((e) => e.kind === 'ci-class').map((e) => [String(e.attributes['ciClass']), e.id]));
  areas.splice(areas.findIndex((a) => a.area === 'data-model') + 1, 0, assessCmdb(cmdb, (c) => ciEvidence.get(c)));

  const catalogue = listCapabilities().filter((c) => !opts.capabilities || opts.capabilities.includes(c.id));
  const practices = detectPractices(evidence, catalogue);
  const detections = detectCapabilities(evidence, catalogue, hasUsage);
  for (const id of opts.include ?? []) {
    if (detections.some((d) => d.capabilityId === id) || !catalogue.some((c) => c.id === id)) continue;
    detections.push({ capabilityId: id, score: 0, status: 'proposed', coreEvidenceIds: [], evidenceIds: [], signals: [], notes: ['Included by a person; no ServiceNow evidence detected.'] });
  }

  const outcomes: Outcome[] = [];
  const designParts: DesignElement[][] = [];
  const selections: CapabilitySelection[] = [];
  const capAssessments: CapabilityAssessment[] = [];
  for (const det of detections) {
    const cap = catalogue.find((c) => c.id === det.capabilityId)!;
    const d = deriveCapability({ capability: cap, detection: det, all: evidence, byId, store, hasUsage, overrides: opts.overrides?.[cap.id] });
    const capEvidence = det.evidenceIds.map((id) => byId.get(id)).filter((e): e is Evidence => Boolean(e));
    outcomes.push(...d.outcomes);
    designParts.push(d.design);
    selections.push({
      capabilityId: cap.id, catalogueVersion: cap.version,
      status: opts.include?.includes(cap.id) ? 'in-scope' : det.status,
      detection: { score: det.score, evidenceIds: det.coreEvidenceIds.slice(0, 50) },
      fit: fitGap(cap, d.design, d.outcomes, capEvidence),
    });
    capAssessments.push({ capabilityId: cap.id, name: cap.name, practice: cap.practice, detection: det, parameters: [...d.params.values()], buildability: buildability(d.design), outcomeIds: d.outcomes.map((o) => o.id), designIds: d.design.map((e) => e.id) });
  }
  const { design, conflicts } = mergeDesign(designParts);

  // Evidence in the blueprint: everything referenced, then the rest up to the cap.
  const referenced = new Set<string>([
    ...outcomes.flatMap((o) => o.evidenceIds),
    ...selections.flatMap((s) => [...(s.detection?.evidenceIds ?? []), ...(s.fit?.gaps.flatMap((g) => g.evidenceIds) ?? [])]),
    ...design.flatMap((el) => el.justification?.evidenceIds ?? []),
  ]);
  const max = opts.maxEvidence ?? Infinity;
  const kept = evidence.filter((e, i) => referenced.has(e.id) || i < max);
  const keptIds = new Set(kept.map((e) => e.id));
  const bpEvidence = kept.map((e) => (e.relations.every((r) => keptIds.has(r.targetId)) ? e : { ...e, relations: e.relations.filter((r) => keptIds.has(r.targetId)) }));

  const src = snapshot.source;
  const blueprint = Blueprint.parse({
    schemaVersion: SCHEMA_VERSION,
    id: `bp.${slug(opts.customer)}.${now.slice(0, 10)}`,
    name: opts.name ?? `${opts.customer}: ServiceNow → Jira Service Management`,
    customer: { name: opts.customer, ...(opts.industry ? { industry: opts.industry } : {}) },
    createdAt: now, updatedAt: now,
    referenceLibraryVersion: CATALOGUE_VERSION,
    target: opts.target ?? {},
    sources: [{ id: `src.${slug(src.kind)}.${slug(src.instance ?? src.name)}`, kind: src.kind, name: src.name, addedAt: src.capturedAt, ...(src.instance ? { instance: src.instance } : {}), ...(src.release ? { release: src.release } : {}), stats: snapshot.stats }],
    evidence: bpEvidence,
    capabilities: selections,
    outcomes,
    design,
    decisions: [],
  });
  const validation = [...validateBlueprint(blueprint), ...conflicts.map((m) => ({ severity: 'warning' as const, path: 'design', message: m }))];

  const assessment: Assessment = {
    generatedAt: now, source: src, usageDays: snapshot.usageDays, hasUsage,
    score: complexityScore(evidence, areas, practices, cmdb),
    areas, practices, capabilities: capAssessments, cmdb,
    unknowns: unknownsOf(snapshot, store, cmdb, evidence, capAssessments, practices, extraction.unextracted),
    extraction: { evidence: evidence.length, relations: evidence.reduce((n, e) => n + e.relations.length, 0), unextracted: extraction.unextracted, warnings: extraction.warnings },
    validation,
  };
  return { blueprint, assessment };
}
