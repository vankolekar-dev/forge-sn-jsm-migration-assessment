import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validate } from '@forge/manifest';

// The manifest, the backend entry points and the UI must stay in step; forge lint needs a login, this does not.
const app = join(__dirname, '..');
const manifest = readFileSync(join(app, 'manifest.yml'), 'utf8');
const index = readFileSync(join(app, 'src/index.ts'), 'utf8');
const ui = readdirSync(join(app, 'static/ui/src')).filter((f) => /\.tsx?$/.test(f)).map((f) => readFileSync(join(app, 'static/ui/src', f), 'utf8')).join('\n');

describe('Forge app wiring', () => {
  it('has a valid manifest (schema and scopes)', async () => {
    const r = await validate(false, join(app, 'manifest.yml'));
    expect(r.errors ?? [], JSON.stringify(r.errors)).toEqual([]);
    expect(r.success).toBe(true);
  });

  it('points every function handler at an export of src/index.ts', () => {
    const handlers = [...manifest.matchAll(/handler:\s*index\.(\w+)/g)].map((m) => m[1]!);
    expect(handlers.sort()).toEqual(['consumer', 'handler']);
    for (const h of handlers) expect(index).toMatch(new RegExp(`export (const|async function|function) ${h}\\b`));
    expect(manifest).toMatch(/queue: workbench-jobs/);
    expect(readFileSync(join(app, 'src/forge.ts'), 'utf8')).toMatch(/new Queue\(\{ key: 'workbench-jobs' \}\)/);
    expect(manifest).toMatch(/timeoutSeconds: 900/);
  });

  it('defines every resolver function the UI calls', () => {
    const defined = new Set([...index.matchAll(/^\s+(\w+): \(wb, c/gm)].map((m) => m[1]!));
    const called = new Set([...ui.matchAll(/call(?:<[^>]+>)?\('(\w+)'/g)].map((m) => m[1]!));
    expect(called.size).toBeGreaterThan(10);
    expect([...called].filter((c) => !defined.has(c))).toEqual([]);
  });

  it('renders reports without HTML injection', () => {
    expect(ui).not.toMatch(/dangerouslySetInnerHTML|innerHTML/);
  });
});
