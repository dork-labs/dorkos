import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    // What `--project <name>` matches from the repo root. Rationale:
    // apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1822).
    name: 'decisions',
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    // Honors the pre-push gate's VITEST_RETRY budget; 0 when unset. CI sets its
    // own budget on the command line instead (DOR-1701).
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
    // Resolve the port to the shared package's SOURCE rather than its built
    // `dist/`, under Vitest only (`test.alias`, not `resolve.alias`), so the
    // targeted `pnpm vitest run packages/decisions` loop does not depend on
    // somebody having built `@dorkos/shared` first. Same wiring and reason as
    // packages/memory/vitest.config.ts.
    alias: [
      {
        find: '@dorkos/shared/decision-model',
        replacement: path.resolve(__dirname, '../shared/src/decision-model.ts'),
      },
    ],
  },
});
