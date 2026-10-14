import { describe, expect, it } from 'vitest';
import { buildOrder } from '@snjsm/model';
import { buildabilityOf, getCapability, getReferenceArtifact, listCapabilities, referenceArtifacts, validateLibrary } from '@snjsm/reference';

describe('reference library', () => {
  it('validates with no errors', () => {
    expect(validateLibrary().filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('never claims verification without a capture', () => {
    for (const a of referenceArtifacts()) {
      if (a.verification.status === 'verified') expect(a.verification.verifiedAgainst).toBeTruthy();
    }
  });

  it('loads the Request hardware capability', () => {
    const cap = getCapability('itsm.request-hardware');
    expect(cap).toBeDefined();
    expect(listCapabilities().map((c) => c.id)).toContain('itsm.request-hardware');
    expect(cap!.outcomes.map((o) => o.category)).toEqual(expect.arrayContaining(['intake', 'approval', 'routing', 'service-level', 'communication']));
  });

  it('catalogue designs contain no extensions and resolve every referenceId', () => {
    for (const cap of listCapabilities()) {
      for (const el of cap.design.elements) {
        expect(el.origin).not.toBe('extension');
        expect(getReferenceArtifact(el.referenceId!)).toBeDefined();
      }
    }
  });

  it('every outcome has acceptance criteria and is delivered by the design', () => {
    const cap = getCapability('itsm.request-hardware')!;
    const ids = new Set(cap.design.elements.map((e) => e.id));
    for (const o of cap.outcomes) {
      expect(o.acceptance.length).toBeGreaterThan(0);
      o.deliveredBy.forEach((d) => expect(ids.has(d)).toBe(true));
    }
  });

  it('produces a buildable order: schema → object types → attributes → fields → request type', () => {
    const order = buildOrder(getCapability('itsm.request-hardware')!.design.elements).map((e) => e.id);
    const at = (id: string) => order.indexOf(id);
    expect(at('as.schema.itam')).toBeLessThan(at('as.ot.hardware-model'));
    expect(at('as.ot.hardware-model')).toBeLessThan(at('fld.hardware-model'));
    expect(at('ref.reports-to')).toBeLessThan(at('as.attr.person-manager'));
    expect(at('wf.service-request-approvals')).toBeLessThan(at('wt.service-request-approvals'));
    expect(at('form.request-hardware')).toBeLessThan(at('rt.request-new-hardware'));
    expect(at('rt.request-new-hardware')).toBeLessThan(at('auto.set-approvers-manager'));
  });

  it('reports buildability per element from the coverage matrix', () => {
    const cap = getCapability('itsm.request-hardware')!;
    const byId = new Map(cap.design.elements.map((e) => [e.id, e]));
    expect(buildabilityOf(byId.get('as.schema.itam')!).status).toBe('api');
    expect(buildabilityOf(byId.get('sla.time-to-resolution')!).status).toBe('ui-only');
    expect(buildabilityOf(byId.get('fld.business-justification')!).status).toBe('api');
    expect(buildabilityOf(byId.get('fld.hardware-model')!).status).toBe('ui-only');
    expect(buildabilityOf(byId.get('wf.service-request-approvals')!).status).toBe('unknown');
  });
});
