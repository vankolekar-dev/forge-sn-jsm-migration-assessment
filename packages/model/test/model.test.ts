import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Blueprint, DesignElement, SCHEMA_VERSION, buildOrder, dependenciesOf, validateBlueprint, validateDesign } from '@snjsm/model';

const el = (o: Record<string, unknown>) => DesignElement.parse({ origin: 'reference', referenceId: 'atl.x', ...o });

const schema = el({ id: 'as.schema', type: 'assets-schema', name: 'S', spec: { name: 'S', key: 'ITAM' } });
const person = el({ id: 'as.ot.person', type: 'assets-object-type', name: 'Person', spec: { name: 'Person', schemaId: 'as.schema' } });
const refType = el({ id: 'ref.reports-to', type: 'assets-reference-type', name: 'Reports to', spec: { name: 'Reports to', schemaId: 'as.schema' } });
const manager = el({
  id: 'as.attr.manager', type: 'assets-attribute', name: 'Manager',
  spec: { name: 'Manager', objectTypeId: 'as.ot.person', attributeType: 'reference', reference: { targetObjectTypeId: 'as.ot.person', referenceTypeId: 'ref.reports-to' } },
});

describe('design elements', () => {
  it('extracts dependencies from nested spec paths', () => {
    expect(dependenciesOf(manager).sort()).toEqual(['as.ot.person', 'ref.reports-to']);
  });

  it('orders dependencies first, regardless of input order', () => {
    const order = buildOrder([manager, person, refType, schema]).map((e) => e.id);
    expect(order.indexOf('as.schema')).toBeLessThan(order.indexOf('as.ot.person'));
    expect(order.indexOf('as.ot.person')).toBeLessThan(order.indexOf('as.attr.manager'));
    expect(order.indexOf('ref.reports-to')).toBeLessThan(order.indexOf('as.attr.manager'));
  });

  it('detects cycles and unknown dependencies', () => {
    const a = el({ id: 'a', type: 'team', name: 'A', dependsOn: ['b'], spec: { name: 'A' } });
    const b = el({ id: 'b', type: 'team', name: 'B', dependsOn: ['a'], spec: { name: 'B' } });
    expect(() => buildOrder([a, b])).toThrow(/cycle/);
    const issues = validateDesign([person]);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('as.schema'))).toBe(true);
  });

  it('requires a justification for extensions', () => {
    const ext = el({ id: 'x', type: 'team', name: 'X', origin: 'extension', referenceId: undefined, spec: { name: 'X' } });
    expect(validateDesign([ext]).some((i) => i.message.includes('justification'))).toBe(true);
    const ok = el({ ...ext, justification: { reason: 'Regulatory segregation of duties required', evidenceIds: [] } });
    expect(validateDesign([ok]).filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('rejects malformed ids and unknown element types', () => {
    expect(() => el({ id: 'Bad Id', type: 'team', name: 'X', spec: { name: 'X' } })).toThrow();
    expect(() => el({ id: 'x', type: 'not-a-type', name: 'X', spec: {} })).toThrow();
  });
});

describe('blueprint', () => {
  const now = new Date().toISOString();
  const base = {
    schemaVersion: SCHEMA_VERSION, id: 'bp.acme', name: 'Acme', customer: { name: 'Acme' }, createdAt: now, updatedAt: now,
    referenceLibraryVersion: '0.1.0',
  };

  it('parses a minimal blueprint with defaults', () => {
    const bp = Blueprint.parse(base);
    expect(bp.evidence).toEqual([]);
    expect(validateBlueprint(bp)).toEqual([]);
  });

  it('flags broken traceability between outcomes, evidence and design', () => {
    const bp = Blueprint.parse({
      ...base,
      capabilities: [{ capabilityId: 'itsm.request-hardware', catalogueVersion: '0.1.0', status: 'in-scope' }],
      outcomes: [{
        id: 'o1', capabilityId: 'itsm.request-hardware', category: 'approval', statement: 'Manager approves expensive hardware',
        acceptance: [{ id: 'ac1', given: 'g', when: 'w', then: ['t'] }], evidenceIds: ['ev.missing'], status: 'confirmed',
      }],
      design: [{ id: 't1', type: 'team', name: 'T', origin: 'reference', referenceId: 'atl.x', deliversOutcomeIds: ['o-missing'], spec: { name: 'T' } }],
    });
    const msgs = validateBlueprint(bp).map((i) => i.message);
    expect(msgs).toContain('unknown evidence "ev.missing"');
    expect(msgs).toContain('delivers unknown outcome "o-missing"');
    expect(msgs).toContain('confirmed outcome is not delivered by any design element');
  });

  it('exports to JSON Schema', () => {
    const json = z.toJSONSchema(Blueprint, { io: 'input', unrepresentable: 'any', reused: 'ref' }) as { type?: string };
    expect(json.type).toBe('object');
  });
});
