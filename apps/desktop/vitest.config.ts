import { defineConfig } from 'vitest/config';

// A NON-UTC zone, pinned before any worker starts.
//
// `shell-log-excerpt` parses electron-log's timestamps, which carry no zone and
// therefore mean LOCAL time. Under `TZ=UTC` — which is what a GitHub Actions
// runner uses — local and UTC are the same clock, so a parse that went to UTC
// by mistake would pass every recency test while silently shifting every
// timestamp by the developer's offset on a real machine. Measured in review:
// mutating that parse to UTC kept all 14 tests green under UTC.
//
// `Etc/GMT-3` is UTC+3 (POSIX inverts the sign in these names), far enough from
// UTC that a zone mix-up moves an entry clear outside the 30-minute window. Any
// non-UTC zone would do; what matters is that it is not UTC.
//
// Set on `process.env` here as well as through `test.env` below because Node
// caches the zone on first `Date` use, and a worker that read the clock before
// applying `test.env` would keep the runner's zone. Unconditional rather than
// `??=`: a runner that exports `TZ=UTC` would otherwise silently take the
// discrimination back out, which is the whole failure being fixed.
const TEST_TIMEZONE = 'Etc/GMT-3';
process.env.TZ = TEST_TIMEZONE;

export default defineConfig({
  test: {
    env: { TZ: TEST_TIMEZONE },
    // What `--project <name>` matches from the repo root. Rationale:
    // apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1822).
    name: 'desktop',
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
    // Honors the pre-push gate's VITEST_RETRY budget; 0 when unset. CI sets its
    // own budget on the command line instead (DOR-1701).
    // Rationale: apps/server/vitest.config.ts. Pinned for every project by
    // scripts/__tests__/vitest-projects.test.ts (DOR-1772).
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
