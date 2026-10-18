import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanupPhrase, confirmPhrase, signOffPhrase, testPhrase } from '@snjsm/mcp-server';

// The orchestration skill must stay in step with the tools, the CLI and the gate phrases it tells Rovo to use.
const root = join(__dirname, '../../..');
const skill = readFileSync(join(root, '.rovo/skills/sn-jsm-outcome-migration/SKILL.md'), 'utf8');
const tools = [...readFileSync(join(root, 'packages/mcp-server/src/tools.ts'), 'utf8').matchAll(/registerTool\('([a-z_]+)'/g)].map((m) => m[1]!);
const cli = [...readFileSync(join(root, 'packages/mcp-server/scripts/jsm.ts'), 'utf8').matchAll(/case '([a-z-]+)':/g)].map((m) => m[1]!);

describe('sn-jsm-outcome-migration skill', () => {
  it('has the frontmatter Rovo needs', () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1] ?? '';
    expect(fm).toMatch(/^name: sn-jsm-outcome-migration$/m);
    expect(fm).toMatch(/^description: /m);
  });

  it('names only tools that exist, and covers every tool', () => {
    const named = new Set([...skill.matchAll(/`((?:blueprint|signoff|build|acceptance)_[a-z_]+)`/g)].map((m) => m[1]!));
    expect([...named].filter((t) => !tools.includes(t))).toEqual([]);
    expect(tools.filter((t) => !named.has(t))).toEqual([]);
  });

  it('names only CLI commands that exist', () => {
    const named = new Set([...skill.matchAll(/npm run jsm -- ([a-z-]+)/g)].map((m) => m[1]!).filter((c) => c !== '<command'));
    expect(named.size).toBeGreaterThan(5);
    expect([...named].filter((c) => !cli.includes(c))).toEqual([]);
  });

  it('shows the exact gate phrases the service accepts', () => {
    for (const phrase of [
      signOffPhrase('<signHash>', '<blueprintId>'),
      confirmPhrase('<planHash>', '<site>'),
      testPhrase('<runHash>', '<site>'),
      cleanupPhrase('<runId>', '<site>'),
    ]) expect(skill).toContain(`\`${phrase}\``);
  });
});
