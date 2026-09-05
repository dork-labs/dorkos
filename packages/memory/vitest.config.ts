import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    // Honors the pre-push gate's VITEST_RETRY budget; 0 for dev and CI runs.
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    // eslint-disable-next-line no-restricted-syntax -- a vitest config has no env.ts of its own; mirrors packages/relay/vitest.config.ts
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
    // Resolve the two `@dorkos/shared` subpaths this engine imports at RUNTIME
    // to the package's SOURCE rather than its built `dist/`.
    //
    // This is `test.alias`, NOT `resolve.alias`, on purpose: it applies only
    // under Vitest, so the shipped build keeps resolving the package's `exports`
    // map exactly as it does today. Same wiring, same reason as
    // packages/relay/vitest.config.ts.
    //
    // Without it, the targeted `pnpm vitest run packages/memory` loop AGENTS.md
    // prescribes depends on somebody having built `@dorkos/shared` first — and
    // `memory-provider.ts` is new, so on a fresh checkout its `dist/` entry does
    // not exist at all and every test file fails to import before a single
    // assertion runs. That reads as a broken engine rather than a missing build.
    // The error classes are the load-bearing part: they are runtime values, so
    // `instanceof` must resolve to ONE module instance, and aliasing both
    // subpaths the engine touches is what guarantees it.
    alias: [
      {
        find: '@dorkos/shared/memory-provider',
        replacement: path.resolve(__dirname, '../shared/src/memory-provider.ts'),
      },
      {
        find: '@dorkos/shared/atomic-write',
        replacement: path.resolve(__dirname, '../shared/src/atomic-write.ts'),
      },
      // `convention-files-io` is the OTHER writer of a memory file — the in-app
      // editor's path — and it has to be aliased for a reason beyond staleness:
      // it takes the same `withFileLock` this engine takes, and a lock is only a
      // lock if both callers reach the SAME module instance. Left on `dist/`,
      // it imports `dist/atomic-write.js` while the engine imports the source
      // one, so there are two `pathLocks` maps, the two writers serialise
      // against nothing, and `editor-race.test.ts` reports a data-loss rate that
      // no longer exists in production. Measured: 8/200 interleaves lost notes
      // purely from the split module graph.
      {
        find: '@dorkos/shared/convention-files-io',
        replacement: path.resolve(__dirname, '../shared/src/convention-files-io.ts'),
      },
      {
        // Anchored, because a bare string `find` matches by PREFIX and would
        // otherwise swallow `convention-files-io` depending on array order.
        find: /^@dorkos\/shared\/convention-files$/,
        replacement: path.resolve(__dirname, '../shared/src/convention-files.ts'),
      },
    ],
  },
});
