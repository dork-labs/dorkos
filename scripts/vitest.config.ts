import { defineConfig } from 'vitest/config';

/**
 * Vitest project for repo-root `scripts/`, which is not a pnpm workspace and so
 * is not covered by any package's `test` task. Registered in the root
 * `vitest.config.ts` project list and run by `pnpm test:scripts`, which
 * `pnpm verify` already invokes.
 */
export default defineConfig({
  test: {
    name: 'scripts',
    root: import.meta.dirname,
    environment: 'node',
    include: ['**/__tests__/**/*.test.ts'],
  },
});
