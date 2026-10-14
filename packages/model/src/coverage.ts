import { z } from 'zod';
import { Confidence, Verification } from './common';

/**
 * API coverage matrix: for each design element type and operation, can the build engine do it through a
 * public API, or does it need a guided manual step? The Phase 0 spike verifies these entries against a real site.
 */
export const CoverageStatus = z.enum(['api', 'partial', 'ui-only', 'unknown']);
export type CoverageStatus = z.infer<typeof CoverageStatus>;

export const CoverageEntry = z.object({
  elementType: z.string(),
  operation: z.enum(['create', 'update', 'read', 'delete', 'configure']),
  aspect: z.string().optional().describe('sub-capability, e.g. "field layout" for request types'),
  status: CoverageStatus,
  confidence: Confidence,
  api: z.string().optional().describe('method + path'),
  notes: z.string().optional(),
  fallback: z.enum(['guided-manual', 'solution-composer', 'import-json', 'none']).optional(),
  verification: Verification,
});
export type CoverageEntry = z.infer<typeof CoverageEntry>;

export const CoverageMatrix = z.object({
  version: z.string(),
  product: z.string(),
  entries: z.array(CoverageEntry).min(1),
});
export type CoverageMatrix = z.infer<typeof CoverageMatrix>;
