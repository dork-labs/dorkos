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
export default defineConfig({
  test: {
    projects: [
      'apps/client',
      'apps/desktop',
      // Only the capture pipeline's unit tests; the Playwright browser suite is
      // a separate task (`pnpm test:browser`) and no vitest project.
      'apps/e2e',
      // One suite, and it asserts on the plugin's BUILD OUTPUT — so its own
      // `test` script builds first (`vite build && vitest run`). Reached from
      // here without that build, it fails with a message naming the script
      // rather than skipping: a stylesheet guard that passes when there is no
      // stylesheet is the failure mode it exists to prevent.
      'apps/obsidian-plugin',
      'apps/server',
      'apps/site',
      'packages/a2a-gateway',
      'packages/cli',
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
      // Repo-root scripts are outside the pnpm workspaces; `pnpm test:scripts`
      // runs this project, and `pnpm verify` runs that.
      'scripts',
    ],
  },
});
