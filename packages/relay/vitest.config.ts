import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    passWithNoTests: true,
    // Resolve `@dorkos/shared/relay-schemas` to the package's SOURCE, not its
    // built `dist/`. This is `test.alias`, NOT `resolve.alias`, on purpose: it
    // applies only under Vitest, so the shipped build keeps resolving the
    // package's `exports` map exactly as it does today.
    //
    // It backs a DRIFT GUARD. `adapters/__tests__/wizard-field-coverage.test.ts`
    // asserts that every field a manifest declares is shown on some setup step,
    // using `setupStepFields` from the package. The `exports` map points
    // `default` at `dist/`, so without this the guard reads yesterday's rule:
    // breaking `setupStepFields` in `src/` and running the targeted
    // `pnpm vitest run <path>` loop AGENTS.md prescribes returned 15 passed —
    // a false PASS, not a loud failure. `pnpm test` is safe (turbo's `^build`),
    // and that gap is exactly what hid this from the first falsification.
    //
    // Same wiring, same reason as the entries in `apps/client/vite.config.ts`.
    alias: [
      {
        find: '@dorkos/shared/relay-schemas',
        replacement: path.resolve(__dirname, '../shared/src/relay-schemas.ts'),
      },
    ],
    // The lefthook pre-push gate sets VITEST_RETRY to absorb timing flake in
    // integration tests on a developer machine already busy with other agents.
    // It rides turbo's globalPassThroughEnv, so it never forks the cache key;
    // dev runs get retry: 0 and surface flake loudly. CI does not set the
    // variable; its merge-queue leg passes `--retry=1` with a reporter that
    // names every absorbed retry instead (DOR-1701, .github/workflows/test.yml).
    // watcher-manager.test.ts drives a real chokidar watcher against real tmpdir
    // writes with a tight 5s timeout, which is exactly the kind of test this
    // exists for — see apps/server/vitest.config.ts for the original wiring.
    // eslint-disable-next-line no-restricted-syntax -- vitest.config.ts has no env.ts of its own; mirrors apps/server/vitest.config.ts
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
