import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // Vitest 4 no longer auto-excludes dist/, and `tsc` emits compiled
    // *.test.js there — scope discovery to source like every other package.
    include: ['src/**/__tests__/**/*.test.ts'],
    // Gate runs (lefthook pre-push, CI) set VITEST_RETRY to absorb timing flake
    // in integration tests. It rides turbo's globalPassThroughEnv, so it never
    // forks the cache key; dev runs get retry: 0 and surface flake loudly.
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/test-utils/**'],
    },
  },
});
