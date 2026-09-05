import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the pure logic in this package's tsx harnesses — the capture
 * pipeline (shot registry, dimension validation, override discovery), the
 * multi-window check's runtime comparison, `playwright.config.ts` itself
 * (`__tests__/`, DOR-1243), and the `manifest-reporter.ts` custom reporter
 * (`reporters/__tests__/`, DOR-1555). The Playwright browser suite runs
 * separately via `pnpm --filter @dorkos/e2e e2e`.
 */
export default defineConfig({
  test: {
    include: [
      'capture/**/__tests__/**/*.test.ts',
      'multi-window/**/__tests__/**/*.test.ts',
      'reporters/**/__tests__/**/*.test.ts',
      '__tests__/**/*.test.ts',
    ],
    globals: false,
    // Honors the pre-push gate's VITEST_RETRY budget; 0 for dev and CI runs.
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    // eslint-disable-next-line no-restricted-syntax -- a vitest config has no env.ts of its own; mirrors packages/relay/vitest.config.ts
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
