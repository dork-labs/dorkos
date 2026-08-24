import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // `scripts/` is in on purpose: the build gates there decide what ships (a
    // rejected server bundle, a renderer with unsubstituted defines), and they
    // were the only code in this package nothing executed — the same reason
    // tsconfig.scripts.json exists.
    include: ['src/**/__tests__/**/*.test.ts', 'scripts/**/__tests__/**/*.test.ts'],
    globals: false,
    passWithNoTests: true,
    // The main-process tests wait on mock children behind real socket I/O (the
    // free-port probe), bounded in wall clock rather than event-loop turns
    // (DOR-653). The default 5s killed the test before its own 10s wait could
    // report a useful message, which is why one flake surfaced as two unrelated
    // failures: "was never spawned" and "timed out in 5000ms" were one cause.
    testTimeout: 30_000,
  },
});
