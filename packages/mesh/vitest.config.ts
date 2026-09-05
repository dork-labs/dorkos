import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    passWithNoTests: true,
    // Honors the pre-push gate's VITEST_RETRY budget; 0 when unset. CI sets its
    // own budget on the command line instead (DOR-1701).
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    // eslint-disable-next-line no-restricted-syntax -- a vitest config has no env.ts of its own; mirrors packages/relay/vitest.config.ts
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
