import { defineConfig } from 'vitest/config';

// Root-level project list so `pnpm vitest run <path>` works from the repo root
// for EVERY package that has tests. Full-suite runs still go through turbo
// (`pnpm test -- --run`) — see AGENTS.md; running the whole workspace via bare
// vitest is unsupported and this list does not change that.
//
// The list must cover every workspace package that declares a `test` script.
// For most of this repo's life it covered eight of them, which made the
// targeted loop AGENTS.md recommends fail with "No test files found, exiting
// with code 1" for ~168 test files across ten packages (DOR-670). That failure
// reads as a broken test, not a runner that was never pointed at the package,
// so the time it costs is spent debugging the wrong thing. Nothing here is
// excluded on purpose — `scripts/__tests__/vitest-projects.test.ts` fails if
// this list and the workspace ever drift apart again.
//
// `packages/evals` is here, and it is the one entry that needed checking rather
// than assuming, because `pnpm evals:local` spends against a real Claude
// subscription. Almost all of its suite is unit tests over injected seams — the
// model call is a `score` function handed to the rubric judge, docker is an
// injected `DockerCli`, and `run-eval.test.ts` module-mocks `hasLocalClaudeLogin`
// so its credentialed-tier cases assert the fail-closed refusal without
// launching anything.
//
// The exception is `runner/__tests__/harness-server.test.ts`, which really does
// boot a server and drive a real turn. Do NOT reason about it from `bin/evals.ts`
// — it never touches that binary, it calls `startChildProcessServer` and
// `driveTurn` directly. It is safe here only because it now requires an explicit
// `DORKOS_EVALS_CREDENTIALED=1` on top of a credential; see the comment there,
// which is the authority on why a key alone was not enough.
//
// The lesson generalizes past this one entry: a package earns a place on this
// list by what its tests EXECUTE, not by what its name or its `test` script
// suggests. Read the gated blocks — module-scope `skipIf` conditions are exactly
// the ones a per-test mock cannot reach.
/**
 * Workers one LOCAL vitest run may use (DOR-2160).
 *
 * Vitest defaults to one worker per core and nothing capped it, so one run on
 * this 14-core, 48 GB machine is 14 workers. Measured while writing this, with
 * three worktrees' suites live at once: 53 vitest processes holding 10.0 GB,
 * 187 node processes holding 17.2 GB, and swap at 10.6 GB of 12.3 GB. Per
 * vitest process, p50 0.11 GB, p90 0.31 GB, max 1.24 GB — the big ones are
 * jsdom workers from `apps/client`.
 *
 * FOUR, and the number is measured rather than guessed. `packages/relay`
 * (1,962 tests) on this machine, repeated runs at load 360-470:
 *
 *   workers  reps  green  wall (mean)  peak tree RSS (mean)
 *   14 (def)    5    5/5        125 s                3.12 GB
 *    8          4    4/4         88 s                2.62 GB
 *    4          8    5/8        120 s                1.61 GB
 *    2          1    1/1        177 s                1.05 GB
 *
 * MEMORY IS THE ONLY CLEAN SIGNAL and it is why 4 wins: it is roughly half the
 * default's footprint, where 8 gives back only a sixth. Wall time is NOT
 * resolvable on this machine — the load moved between batches, and in the one
 * fairly interleaved comparison (4 and 14 alternating, three pairs) the means
 * were 110 s and 117 s, which is noise. Read "no measurable wall-time cost at
 * this load" and nothing stronger; on an idle machine the uncapped run would
 * win and this would cost real minutes.
 *
 * THE COST, STATED PLAINLY, because it is not free. Three of eight capped runs
 * of that suite went red where none of the nine uncapped-or-8 runs did, always
 * in `access-control.test.ts` or `relay-gc.test.ts` — the two tests that drive
 * a real filesystem watcher against a deadline. Run on their own they pass
 * 12/12 at both settings, so this is contention INSIDE the run: with 4 workers
 * each one carries ~19 files instead of ~5, its event loop is busy for longer,
 * and a watcher callback is likelier to miss its window. That is a real cost of
 * the cap and the honest fix is to make those two tests deterministic, not to
 * raise the number until they stop complaining. Meanwhile local runs
 * deliberately use `retry: 0` so flake is loud, and any single run can opt out
 * with `VITEST_MAX_WORKERS=14 pnpm vitest run <path>`.
 *
 * CI IS DELIBERATELY EXEMPT. Its runners are small (so the default is already
 * near 4 there) and the queue's wall time is an SLO we are trying to improve,
 * which is exactly the case where more workers help. `CI` is set by GitHub
 * Actions on every runner.
 *
 * WHAT THIS REACHES, and what it does not. `maxWorkers` here governs
 * `pnpm vitest run <path>` from the repo root, which is the targeted loop
 * AGENTS.md prescribes. The turbo path (`pnpm test`, `pnpm verify`) runs each
 * package's OWN config in its own process, so those two root scripts export
 * `VITEST_MAX_WORKERS` instead — the variable vitest reads at config-resolve
 * time whatever config it loads, already on turbo's `globalPassThroughEnv` so
 * it never forks a cache key. `scripts/__tests__/local-worker-cap.test.ts` pins
 * both halves. A bare `pnpm --filter <pkg> test` run inside a package directory
 * is reached by NEITHER and stays uncapped; closing that would mean editing all
 * 24 package configs, and it is not a path AGENTS.md sends anyone down.
 *
 * It composes with, and does not duplicate, `scripts/heavy-run-lock.sh`: that
 * caps concurrent heavy COMMANDS (3), this caps workers within one run (4).
 * They multiply only where both apply, and today they overlap nowhere — the
 * lock guards pre-commit `lint` and `typecheck`, which are turbo tasks that
 * spawn no vitest workers at all. So the machine's exposure from lock-guarded
 * gates is 3 concurrent turbo runs, and its exposure from agent-initiated test
 * runs is 4 workers each with no cap on how many runs. Capping the number of
 * concurrent test RUNS is the obvious next lever and is deliberately not taken
 * here: one lever at a time, and this one has to be measured first.
 */
const LOCAL_MAX_WORKERS = 4;

export default defineConfig({
  test: {
    ...(process.env.CI ? {} : { maxWorkers: LOCAL_MAX_WORKERS }),
    projects: [
      'apps/client',
      'apps/community',
      'apps/design-system',
      'apps/desktop',
      // Only the capture pipeline's unit tests; the Playwright browser suite is
      // a separate task (`pnpm test:browser`) and no vitest project.
      'apps/e2e',
      'apps/server',
      'apps/site',
      'packages/a2a-gateway',
      'packages/ci-steward',
      'packages/cli',
      'packages/cloud-api',
      'packages/connector-providers',
      'packages/db',
      'packages/evals',
      'packages/extension-api',
      'packages/harness',
      'packages/marketplace',
      'packages/memory',
      'packages/mesh',
      'packages/operating-skills',
      'packages/relay',
      'packages/shared',
      'packages/skills',
      'packages/test-utils',
      'packages/ui',
      // Repo-root scripts are outside the pnpm workspaces; `pnpm test:scripts`
      // runs this project, and `pnpm verify` runs that.
      'scripts',
    ],
  },
});
