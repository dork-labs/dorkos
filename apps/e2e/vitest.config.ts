import { defineConfig } from 'vitest/config';

/**
 * Unit tests for the capture pipeline's pure logic (shot registry, dimension
 * validation, override discovery). The Playwright browser suite runs separately
 * via `pnpm --filter @dorkos/e2e e2e`.
 */
export default defineConfig({
  test: {
    include: ['capture/**/__tests__/**/*.test.ts'],
    globals: false,
  },
});
