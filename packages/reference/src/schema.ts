import { z } from 'zod';
import { Verification } from '@snjsm/model';

/** One Atlassian reference artifact: a template, work type, workflow, request type, SLA, Assets template and so on. */
export const ReferenceArtifact = z.object({
  id: z.string().regex(/^atl\.[a-z0-9.-]+$/),
  kind: z.enum([
    'project-template', 'work-type', 'workflow', 'request-type', 'portal-group', 'sla', 'calendar', 'queue',
    'field', 'notification', 'automation-pattern', 'assets-schema-template', 'assets-object-type', 'team-pattern',
  ]),
  product: z.enum(['jsm', 'jira', 'assets', 'automation', 'platform']),
  name: z.string().min(1),
  description: z.string().optional(),
  partOf: z.string().optional().describe('parent artifact id, e.g. the project template'),
  attributes: z.record(z.string(), z.unknown()).default({}),
  docs: z.string().url().optional(),
  verification: Verification,
});
export type ReferenceArtifact = z.infer<typeof ReferenceArtifact>;

export const ReferenceFile = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  description: z.string(),
  artifacts: z.array(ReferenceArtifact).min(1),
});
export type ReferenceFile = z.infer<typeof ReferenceFile>;
