import { defineConfig } from 'vitest/config';

import { REPO_WIDE_SUITES } from './repo-wide-suites.ts';

/**
 * The one Vitest config for repo-root `scripts/`, which is not a pnpm workspace
 * and so is not covered by any package's `test` task (DOR-4951). It has two
 * projects; always name one, because with no `--project` both run and every
 * repo-wide suite runs twice.
 *
 * - `scripts`: every suite. `pnpm test:scripts` (which `pnpm verify` runs) and
 *   `scripts-test / harness` run `vitest run --config scripts/vitest.config.ts
 *   --project scripts`.
 * - `scripts-repo`: only the suites that read the whole repository, listed in
 *   `repo-wide-suites.ts`. The required `typecheck` job runs it with
 *   `--project scripts-repo`, so a PR outside `scripts/` that breaks one is
 *   ejected from the queue instead of turning `main` red (ledger 261112-185148).
 *
 * The top-level `test` block IS the `scripts` project: the `projects` list
 * names this file to reuse it. The root `vitest.config.ts` registers this
 * directory as a project, and Vitest reads only a registered project's own
 * settings, never its `projects`, so `pnpm vitest run scripts/__tests__/x.test.ts`
 * from the repo root runs the file once, as `scripts`.
 */
export default defineConfig({
  test: {
    name: 'scripts',
    root: import.meta.dirname,
    environment: 'node',
    include: ['**/__tests__/**/*.test.ts'],
    // Honors the pre-push gate's VITEST_RETRY budget; 0 when unset. CI sets its
    // own budget on the command line instead (DOR-1701).
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
    projects: [
      import.meta.filename,
      {
        test: {
          name: 'scripts-repo',
          root: import.meta.dirname,
          environment: 'node',
          include: [...REPO_WIDE_SUITES],
          // The whole-repo scans are CPU-bound. On a 4-core runner, one worker per
          // core made two of them take 26-34s and time out (DOR-4222). Two workers
          // leave each scan more of the machine; the step still takes under a minute.
          maxWorkers: 2,
          // Vitest refuses two projects with different `maxWorkers` in one group,
          // so a run of both projects runs this one after `scripts`.
          sequence: { groupOrder: 1 },
          // Room for a slow runner. A test that sets its own timeout keeps it, so
          // the two slowest scans also raised theirs in-file.
          testTimeout: 120_000,
          // The same idiom as `scripts`; CI passes no VITEST_RETRY, so 0.
          retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
        },
      },
    ],
  },
});
