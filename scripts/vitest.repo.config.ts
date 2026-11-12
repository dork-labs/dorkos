import { defineConfig } from 'vitest/config';

/**
 * The `scripts/` suites that read the whole repository, run in the merge queue.
 *
 * Most of `scripts/__tests__` checks only the code in `scripts/`. These files
 * also read state anywhere in the tree: a census over `apps/` and `packages/`,
 * an allowlist or baseline, every workflow file, `git ls-files`. A pull request
 * that touches none of `scripts/` can turn one red. The full `scripts` project
 * runs only in `scripts-test / harness`, which is scoped to `scripts/**` and
 * friends on a pull request and does not run in the merge queue, so such a
 * break used to reach `main` and fail every later `scripts/` PR until somebody
 * landed a follow-up (31 failed jobs and three red-main spells in the week of
 * Nov 5, 2026: #3528, #3568, #3564/#3569; ledger 261112-185148).
 *
 * `typecheck.yml` runs this config, because `typecheck` is required,
 * unfiltered and reports on `merge_group`. Whole files, not filtered test
 * names: each file here is fast, and a name filter would silently stop
 * matching when a test is renamed.
 *
 * Every file in the `scripts` project must be in exactly one of
 * {@link REPO_WIDE_SUITES} or {@link HERMETIC_SUITES}, pinned by
 * `scripts/__tests__/repo-wide-suites.test.ts`, so a new suite has to be
 * classified by whoever adds it. When unsure, it is repo-wide.
 */

/** Suites with at least one test that reads files outside `scripts/`'s harness scope. */
export const REPO_WIDE_SUITES = [
  '__tests__/agents-service-census.test.ts',
  '__tests__/check-boundary.test.ts',
  '__tests__/check-design-tokens.test.ts',
  '__tests__/check-vocab-gate.test.ts',
  '__tests__/ci-apt-resilience.test.ts',
  '__tests__/code-only.test.ts',
  '__tests__/codex-sandbox-job.test.ts',
  '__tests__/community-acceptance-readiness.test.ts',
  '__tests__/community-release-workflow.test.ts',
  '__tests__/composio-sdk-import-boundary.test.ts',
  '__tests__/config-glob-scope.test.ts',
  '__tests__/connector-legacy-authority-absence.test.ts',
  '__tests__/connector-public-copy.test.ts',
  '__tests__/credential-free-workflow.test.ts',
  '__tests__/decision-narrow-only.test.ts',
  '__tests__/dependabot-lockstep-families.test.ts',
  '__tests__/extension-child-build-entry.test.ts',
  '__tests__/gray-matter-import-boundary.test.ts',
  '__tests__/merge-group-runner-label.test.ts',
  '__tests__/one-shot-routes.test.ts',
  '__tests__/root-eslint-output-scope.test.ts',
  '__tests__/session-link-boundary.test.ts',
  '__tests__/space-page-versions.test.ts',
  '__tests__/space-server.test.ts',
  '__tests__/tsconfig-extends-resolve.test.ts',
  '__tests__/vitest-projects.test.ts',
] as const;

/**
 * Suites that read only temp fixtures or files inside the harness scope, so
 * `harness` already runs them whenever a change could break them. Several need
 * `packages/harness/dist`, which only `harness` builds.
 */
export const HERMETIC_SUITES = [
  '__tests__/adr-corpus-checks.test.ts',
  '__tests__/agent-hours.test.ts',
  '__tests__/check-copy-length.test.ts',
  '__tests__/check-copy-spec-drift-replay.test.ts',
  '__tests__/check-copy-spec-drift.test.ts',
  '__tests__/check-max-lines.test.ts',
  '__tests__/community-packaged-scope-step.test.ts',
  '__tests__/extension-hono-shipped.test.ts',
  '__tests__/harness-smoke-e2e.test.ts',
  '__tests__/harness-smoke-oracles.test.ts',
  '__tests__/harness-smoke-user-tier-oracle.test.ts',
  '__tests__/harness-smoke-user-tier.test.ts',
  '__tests__/harness-smoke.test.ts',
  '__tests__/heavy-turbo-slot.test.ts',
  '__tests__/knip-ratchet.test.ts',
  '__tests__/local-gate-shape.test.ts',
  '__tests__/local-worker-cap.test.ts',
  '__tests__/neon-preview-sweep.test.ts',
  '__tests__/origin-branch-janitor.test.ts',
  '__tests__/pr-test-plan.test.ts',
  '__tests__/pre-push-format-gate.test.ts',
  '__tests__/repo-wide-suites.test.ts',
  '__tests__/scripts-block-not-versions.test.ts',
  '__tests__/shell-suite-parity.test.ts',
  '__tests__/space-runtime-packages.test.ts',
  '__tests__/turbo-affected-base-pinned.test.ts',
  '__tests__/unit-shard-workdivision.test.ts',
  '__tests__/vitest-flake-reporter.test.ts',
  '__tests__/worktree-janitor-volumes.test.ts',
  'q3-contention/__tests__/canary.test.ts',
  'q3-contention/__tests__/overlap.test.ts',
  'q3-contention/__tests__/plan.test.ts',
  'q3-contention/__tests__/provision.test.ts',
  'q3-contention/__tests__/sampler.test.ts',
  'q3-contention/__tests__/turns.test.ts',
  'sharding/__tests__/sequencer.test.ts',
] as const;

export default defineConfig({
  test: {
    name: 'scripts-repo',
    root: import.meta.dirname,
    environment: 'node',
    include: [...REPO_WIDE_SUITES],
    // Same idiom as scripts/vitest.config.ts; CI passes no VITEST_RETRY, so 0.
    retry: process.env.VITEST_RETRY ? Number(process.env.VITEST_RETRY) : 0,
  },
});
