#!/usr/bin/env bash
# run-scripts-suites.sh — every scripts suite `pnpm verify` runs (`pnpm test:scripts`).
#
# The list lives here, not in the root package.json, on purpose (DOR-4190):
# Turborepo treats the root package.json as an input to every package, so
# registering one suite there changed the hash of all of them, and a CI-only PR
# re-ran typecheck and lint for the whole repo from scratch (about 7 minutes
# instead of cached). One command per line also stops parallel CI PRs from
# conflicting on one long line. Its name does not match `test-*.sh` on
# purpose: the parity test treats every such file as a fixture suite.
#
# Register a new suite here AND in .github/workflows/scripts-test.yml;
# scripts/__tests__/shell-suite-parity.test.ts checks the two agree.
# Runs from the repo root; stops at the first failure, as the && chain did.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

pnpm typecheck:scripts
bash scripts/test-review-classifier.sh
bash scripts/test-security-verdict-check.sh
bash scripts/test-security-findings.sh
bash scripts/test-git-guard.sh
bash scripts/test-process-guard.sh
bash scripts/test-merge-guard.sh
bash scripts/test-pr-create-guard.sh
bash scripts/test-heavy-command-guard.sh
bash scripts/test-open-pr.sh
bash scripts/test-hold-reason-check.sh
bash scripts/test-not-held-check.sh
bash scripts/test-release-window-check.sh
bash scripts/test-in-project-hook.sh
bash scripts/test-sync-main-checkout.sh
bash scripts/test-lint-changed-hook.sh
bash scripts/test-run-node-hook.sh
bash scripts/test-assert-tests-executed.sh
bash scripts/test-keep-build-cache-only.sh
bash scripts/test-prune-main-build-caches.sh
bash scripts/test-build-test-deps.sh
bash scripts/test-assert-shard-union.sh
bash scripts/test-assert-browser-tests-executed.sh
bash scripts/test-assert-migrations-current.sh
bash scripts/test-should-arm-automerge.sh
bash scripts/test-should-arm-automerge-input.sh
bash scripts/test-queue-repeat-guard.sh
bash scripts/test-queue-reentry.sh
bash scripts/test-arm-door.sh
bash scripts/test-pr-gates-check.sh
bash scripts/test-qa-real-data.sh
bash scripts/test-design-ok.sh
bash scripts/test-should-redispatch-review.sh
bash scripts/test-review-redispatch-wait.sh
bash scripts/test-review-mode.sh
bash scripts/test-should-reap-worktree.sh
bash scripts/test-worktree-janitor-volumes.sh
bash scripts/test-seeded-pack-changed.sh
bash scripts/test-check-dir-size.sh
bash scripts/test-homedir-guard.sh
bash scripts/test-supertest-import-guard.sh
bash scripts/test-format-changed.sh
bash scripts/test-pre-push-format-check.sh
bash scripts/test-check-banned-words.sh
bash scripts/test-check-dead-doc-paths.sh
bash scripts/test-check-nul-bytes.sh
bash scripts/test-release-version.sh
bash scripts/test-wait-for-npm.sh
bash scripts/test-npm-tarball-sha256.sh
bash scripts/test-heavy-run-lock.sh
bash scripts/test-load-gate-turn.sh
bash scripts/test-no-early-exit-grep.sh
bash scripts/test-sweep-ephemeral-docker.sh
bash scripts/test-sweep-docker-orphans.sh
bash scripts/test-sweep-test-tmp.sh
bash scripts/test-run-credential-free.sh
bash scripts/test-ci-memory-watch.sh
bash scripts/test-scripts-test-scope.sh
bash scripts/test-community-packaged-scope.sh
bash scripts/test-no-code-scope.sh
bash scripts/test-pr-related.sh
bash scripts/test-auto-revert.sh
bash scripts/test-rolling-bisect.sh
bash scripts/test-daily-sweep.sh
bash scripts/test-attest-pr-check.sh
bash scripts/test-daily-release.sh
bash scripts/test-timed-slot.sh
bash scripts/test-after-merge-alert.sh
bash scripts/test-browser-smoke-scope.sh
bash scripts/test-release-branch-contents.sh
bash scripts/test-release-gate.sh
bash .agents/skills/creating-pull-requests/scripts/test-watch-prs.sh
bash .agents/skills/creating-pull-requests/scripts/test-open-pr-cap.sh
bash .agents/skills/creating-pull-requests/scripts/test-pr-age-list.sh
node --experimental-strip-types --disable-warning=ExperimentalWarning --test .claude/scripts/__tests__/*.test.ts
node .claude/scripts/docs-coverage-map.mjs --check
vitest run --config scripts/vitest.config.ts
