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
    // Honors the pre-push gate's VITEST_RETRY budget; 0 for dev and CI runs.
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    // eslint-disable-next-line no-restricted-syntax -- a vitest config has no env.ts of its own; mirrors packages/relay/vitest.config.ts
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
