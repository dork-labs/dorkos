import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    globals: false,
    passWithNoTests: true,
    // Gate runs (lefthook pre-push, CI) set VITEST_RETRY to absorb timing flake
    // in integration tests. It rides turbo's globalPassThroughEnv, so it never
    // forks the cache key; dev runs get retry: 0 and surface flake loudly.
    // watcher-manager.test.ts drives a real chokidar watcher against real tmpdir
    // writes with a tight 5s timeout, which is exactly the kind of test this
    // exists for — see apps/server/vitest.config.ts for the original wiring.
    // eslint-disable-next-line no-restricted-syntax -- vitest.config.ts has no env.ts of its own; mirrors apps/server/vitest.config.ts
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
