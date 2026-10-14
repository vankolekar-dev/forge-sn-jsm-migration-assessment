import type { ReferenceFile } from '@snjsm/reference';
import type { CompareReport, Finding } from './compare';

export interface Change {
  artifactId: string;
  action: 'verified' | 'verified-with-corrections' | 'flagged';
  detail: string;
}

/**
 * Apply a comparison to one reference data file. Pure: returns a new file plus a change log.
 * - matched     → verification: verified, captured facts stored under attributes.captured
 * - mismatched  → workflows: statuses replaced from the site, then verified; other kinds stay unverified with notes
 * - missing     → stays unverified, with notes saying what was not found
 * - extra / not-captured → never written (extras need a human curation decision)
 */
export function applyReport(file: ReferenceFile, report: CompareReport, verifiedOn: string): { file: ReferenceFile; changes: Change[] } {
  const findings = new Map<string, Finding>();
  for (const f of report.findings) if (f.artifactId) findings.set(f.artifactId, f);
  const against = `${report.site} (captured ${report.capturedAt})`;
  const changes: Change[] = [];

  const artifacts = file.artifacts.map((a) => {
    const f = findings.get(a.id);
    if (!f || f.result === 'not-captured' || f.result === 'extra') return a;
    const next = structuredClone(a);
    const keepNotes = f.details.length ? f.details.join('; ') : undefined;

    if (f.result === 'matched') {
      if (f.captured) next.attributes = { ...next.attributes, captured: f.captured };
      next.verification = { status: 'verified', verifiedOn, verifiedAgainst: against, ...(keepNotes ? { notes: keepNotes } : {}) };
      changes.push({ artifactId: a.id, action: 'verified', detail: keepNotes ?? 'matches site' });
    } else if (f.result === 'mismatched' && a.kind === 'workflow' && Array.isArray(f.captured?.statuses)) {
      const { statuses, ...rest } = f.captured;
      next.attributes = { ...next.attributes, statuses, captured: rest };
      next.verification = { status: 'verified', verifiedOn, verifiedAgainst: against, notes: `statuses replaced from site: ${f.details.join('; ')}` };
      changes.push({ artifactId: a.id, action: 'verified-with-corrections', detail: f.details.join('; ') });
    } else {
      next.verification = { status: 'unverified', notes: `${f.result} on ${against}: ${f.details.join('; ') || 'no details'}` };
      if (f.captured) next.attributes = { ...next.attributes, captured: f.captured };
      changes.push({ artifactId: a.id, action: 'flagged', detail: `${f.result}: ${f.details.join('; ')}` });
    }
    return next;
  });
  return { file: { ...file, artifacts }, changes };
}
