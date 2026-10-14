import {
  Capability, CoverageEntry, CoverageMatrix, CoverageStatus, DesignElement, Issue, validateCapability,
} from '@snjsm/model';
import { ReferenceArtifact, ReferenceFile } from './schema';
import jsmItsm from './data/atlassian/jsm-itsm.json';
import assets from './data/atlassian/assets.json';
import automation from './data/atlassian/automation.json';
import coverageJson from './data/coverage/jsm-cloud.json';
import rhCapability from './data/capabilities/itsm.request-hardware/capability.json';
import rhDesignJsm from './data/capabilities/itsm.request-hardware/design-jsm.json';
import rhDesignOps from './data/capabilities/itsm.request-hardware/design-ops.json';
import rhDesignAssets from './data/capabilities/itsm.request-hardware/design-assets.json';

export * from './schema';

/** Catalogue version: bump when any reference data, capability or coverage entry changes. */
export const CATALOGUE_VERSION = '0.1.0';

const REFERENCE_FILES = { 'jsm-itsm': jsmItsm, assets, automation } as const;

/** Raw capability sources. Each capability = metadata/outcomes + design parts. */
const CAPABILITY_SOURCES: { meta: unknown; design: unknown[][] }[] = [
  { meta: rhCapability, design: [rhDesignJsm, rhDesignOps, rhDesignAssets] },
];

let cache: { artifacts: Map<string, ReferenceArtifact>; capabilities: Map<string, Capability>; coverage: CoverageMatrix } | undefined;

function load() {
  if (cache) return cache;
  const artifacts = new Map<string, ReferenceArtifact>();
  for (const [name, raw] of Object.entries(REFERENCE_FILES)) {
    const file = ReferenceFile.parse(raw);
    for (const a of file.artifacts) {
      if (artifacts.has(a.id)) throw new Error(`duplicate reference artifact ${a.id} (in ${name})`);
      artifacts.set(a.id, a);
    }
  }
  const capabilities = new Map<string, Capability>();
  for (const src of CAPABILITY_SOURCES) {
    const meta = src.meta as Record<string, unknown>;
    const design = meta.design as Record<string, unknown> | undefined;
    const cap = Capability.parse({
      ...meta,
      design: {
        id: `${meta.id as string}.design`,
        description: `Atlassian reference design for ${meta.name as string}`,
        basedOn: [],
        ...design,
        elements: src.design.flat(),
      },
    });
    cap.design.basedOn = [...new Set(cap.design.elements.map((e) => e.referenceId).filter((r): r is string => Boolean(r)))];
    if (capabilities.has(cap.id)) throw new Error(`duplicate capability ${cap.id}`);
    capabilities.set(cap.id, cap);
  }
  cache = { artifacts, capabilities, coverage: CoverageMatrix.parse(coverageJson) };
  return cache;
}

export const referenceArtifacts = (): ReferenceArtifact[] => [...load().artifacts.values()];
export const getReferenceArtifact = (id: string): ReferenceArtifact | undefined => load().artifacts.get(id);
export const listCapabilities = (): Capability[] => [...load().capabilities.values()];
export const getCapability = (id: string): Capability | undefined => load().capabilities.get(id);
export const coverageMatrix = (): CoverageMatrix => load().coverage;

/** Coverage entries for one element type (create first, then configure aspects). */
export function coverageFor(type: DesignElement['type']): CoverageEntry[] {
  return load().coverage.entries.filter((e) => e.elementType === type);
}

/** Configure-aspects only count when the element actually uses that aspect. */
function aspectApplies(el: DesignElement, e: CoverageEntry): boolean {
  if (el.type === 'field') return el.spec.fieldType === 'assets-object';
  if (el.type === 'workflow' && e.aspect === 'approval step') return el.spec.approvals.length > 0;
  return true;
}

const RANK: Record<CoverageStatus, number> = { api: 0, partial: 1, unknown: 2, 'ui-only': 3 };

/**
 * How buildable an element is: the worst status across its create and configure entries.
 * Example: a request type is "ui-only" overall if its field layout is UI-only, even though creation has an API.
 */
export function buildabilityOf(el: DesignElement): { status: CoverageStatus; entries: CoverageEntry[] } {
  const entries = coverageFor(el.type).filter((e) => e.operation === 'create' || e.operation === 'configure');
  const relevant = entries.filter((e) => e.operation === 'create' || aspectApplies(el, e));
  if (!relevant.length) return { status: 'unknown', entries: [] };
  const status = relevant.reduce<CoverageStatus>((w, e) => (RANK[e.status] > RANK[w] ? e.status : w), 'api');
  return { status, entries: relevant };
}

const PLACEHOLDER = /\{\{(\w+)\}\}/g;

/** Validate the whole library: schemas, capability integrity, referenceIds and design placeholders. */
export function validateLibrary(): Issue[] {
  const { artifacts, capabilities } = load();
  const issues: Issue[] = [];
  for (const a of artifacts.values()) {
    if (a.partOf && !artifacts.has(a.partOf)) issues.push({ severity: 'error', path: a.id, message: `partOf unknown artifact ${a.partOf}` });
  }
  for (const cap of capabilities.values()) {
    issues.push(...validateCapability(cap, new Set(cap.dependsOn)));
    for (const dep of cap.dependsOn) if (!capabilities.has(dep)) issues.push({ severity: 'error', path: cap.id, message: `dependsOn unknown capability ${dep}` });
    const params = new Set(cap.outcomes.flatMap((o) => o.parameters.map((p) => p.name)));
    for (const el of cap.design.elements) {
      if (el.referenceId && !artifacts.has(el.referenceId)) issues.push({ severity: 'error', path: `${cap.id}.design.${el.id}`, message: `referenceId ${el.referenceId} is not in the reference library` });
      for (const m of JSON.stringify(el.spec).matchAll(PLACEHOLDER)) {
        const name = m[1]!;
        // {{reporter.*}} / {{lookupObjects.*}} smart values are not matched by \w+ and are left to automation.
        if (!params.has(name)) issues.push({ severity: 'error', path: `${cap.id}.design.${el.id}`, message: `placeholder {{${name}}} is not a capability parameter` });
      }
    }
    for (const o of cap.outcomes) {
      for (const ac of o.acceptance) {
        for (const m of JSON.stringify(ac).matchAll(PLACEHOLDER)) {
          if (!params.has(m[1]!)) issues.push({ severity: 'error', path: `${cap.id}.outcomes.${o.id}.${ac.id}`, message: `placeholder {{${m[1]}}} is not a capability parameter` });
        }
      }
    }
  }
  return issues;
}
