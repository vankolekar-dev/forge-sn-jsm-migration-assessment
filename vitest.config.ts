import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@snjsm/model': pkg('model'),
      '@snjsm/reference': pkg('reference'),
      '@snjsm/collector': pkg('collector'),
      '@snjsm/atlassian/node': fileURLToPath(new URL('./packages/atlassian/src/node.ts', import.meta.url)),
      '@snjsm/atlassian': pkg('atlassian'),
      '@snjsm/tools': pkg('tools'),
      '@snjsm/analyser': pkg('analyser'),
      '@snjsm/builder': pkg('builder'),
      '@snjsm/acceptance': pkg('acceptance'),
      '@snjsm/workflow': pkg('workflow'),
      '@snjsm/mcp-server': pkg('mcp-server'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
