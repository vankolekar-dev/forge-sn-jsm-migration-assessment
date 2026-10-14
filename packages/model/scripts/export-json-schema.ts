/**
 * Writes JSON Schema files for the public contracts to packages/model/schema/.
 * Partners can validate Blueprint and catalogue files without using TypeScript.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Blueprint, Capability, CoverageMatrix, SCHEMA_VERSION } from '../src';

const outDir = join(__dirname, '..', 'schema');
mkdirSync(outDir, { recursive: true });

const targets: Record<string, z.ZodType> = {
  'blueprint.schema.json': Blueprint,
  'capability.schema.json': Capability,
  'coverage-matrix.schema.json': CoverageMatrix,
};

for (const [file, schema] of Object.entries(targets)) {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any', reused: 'ref' }) as Record<string, unknown>;
  json.$id = `https://github.com/vankolekar-dev/forge-sn-jsm-migration-assessment/schema/${SCHEMA_VERSION}/${file}`;
  writeFileSync(join(outDir, file), JSON.stringify(json, null, 2) + '\n');
  console.log(`wrote ${file}`);
}
