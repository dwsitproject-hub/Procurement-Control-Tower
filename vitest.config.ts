import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Relative to wherever vitest is started: the workspace script runs it from
    // packages/rules, where 'packages/*/test/**' matched nothing and the
    // documented `npm test` failed with "No test files found".
    include: ['**/test/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: { provider: 'v8', include: ['packages/rules/src/**'] },
  },
});
