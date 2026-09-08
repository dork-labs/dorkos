import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // What `--project <name>` matches from the repo root. Rationale:
    // apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1822).
    name: 'harness',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    // Real filesystem/Git cases can stall on Windows runners; correctness is
    // the assertion, not a five-second latency budget. Keep the bound finite
    // without changing other platforms, case counts or retry policy (DOR-1898).
    ...(process.platform === 'win32' ? { testTimeout: 30_000 } : {}),
    // Honors the pre-push gate's VITEST_RETRY budget; 0 when unset. CI sets its
    // own budget on the command line instead (DOR-1701).
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
