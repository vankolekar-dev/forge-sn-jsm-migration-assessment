import { describe, expect, it } from 'vitest';
import { DESIGN_ELEMENT_TYPES, EvidenceKind } from '@snjsm/model';
import { READINESS_LABEL, READINESS_ORDER, SN_TO_JSM, coverageFor, createReadiness } from '@snjsm/reference';

describe('ServiceNow → JSM build-list mapping', () => {
  it('answers every evidence kind, and nothing else', () => {
    expect(Object.keys(SN_TO_JSM).sort()).toEqual([...EvidenceKind.options].sort());
  });

  it('gives either a design element type or a reason there is none', () => {
    for (const [kind, m] of Object.entries(SN_TO_JSM)) {
      expect(m.jsm.trim(), kind).not.toBe('');
      if (m.target) {
        expect(DESIGN_ELEMENT_TYPES, kind).toContain(m.target);
        expect(m.readiness, kind).toBeUndefined();
      } else {
        expect(['outside-builder', 'no-equivalent', 'not-needed'], kind).toContain(m.readiness);
      }
    }
  });

  it('marks script-only kinds for redesign rather than copying', () => {
    for (const k of ['business-rule', 'client-script', 'script-include', 'ui-script', 'scoped-app'] as const) expect(SN_TO_JSM[k].redesign, k).toBe(true);
  });

  it('takes readiness from the weakest create entry in the coverage matrix', () => {
    for (const type of DESIGN_ELEMENT_TYPES) {
      const creates = coverageFor(type).filter((e) => e.operation === 'create').map((e) => e.status);
      const r = createReadiness(type);
      if (!creates.length) expect(r).toBe('unknown');
      else {
        expect(creates).toContain(r);
        expect(creates.every((s) => READINESS_ORDER.indexOf(s) <= READINESS_ORDER.indexOf(r))).toBe(true);
      }
    }
    expect(createReadiness('space')).toBe('api');
    expect(createReadiness('sla')).toBe('ui-only');
  });

  it('labels every readiness', () => {
    expect(Object.keys(READINESS_LABEL).sort()).toEqual([...READINESS_ORDER].sort());
  });
});
