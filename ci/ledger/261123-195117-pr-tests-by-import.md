---
id: 261123-195117
title: a pull request runs the test files that import its change, not every file of every planned suite
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard-count
  - wf.test.test-shard
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50@pull_request'
  slo: 'pr-feedback'
  baseline: 18.6
  baseline_source: 'origin/ci-steward-data snapshots/2026-11-16..2026-11-22.json, gates["wf.test.test-shard@pull_request"].durations: n=4137 job runs, p50 18.6 min, p90 24.2 min.'
  target: 14
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-5110. The pull request leg picks whole suites by turbo hash (`scripts/pr-test-plan.sh`, ledger
261031-164008). A one-line change in a shared package moves the hash of nearly every suite, so it
runs nearly every test file in the monorepo (DOR-4833's one-string change; shards near 20 minutes on
wide pull requests, ledger 261030-233825).

The change: test-shard-count runs `scripts/pr-related-scope.sh` from the base commit. When it
answers `related=true` and the plan is `selected`, each shard runs `scripts/pr-related-tests.sh`:
in each planned suite, through that package's own config, Vitest's import graph picks the test
files tied to a changed file (the file itself, the built `dist/` copy of a dependency's changed
source, and test files that quote the changed file's name or its top folder, which is how tests
that read files from disk are caught). The set is split across the same shards. The changed-file
list rides the `vitest_files` output the text-only lane already uses. Shard counts are unchanged.

Falls back to today's whole-suite plan for the whole pull request on any config change
(package.json, lockfile, workspace, turbo, tsconfig, vite/vitest, eslint and similar), anything
under `.github/`, `scripts/` or `ci/`, the shared test packages, setup files, test helpers,
fixtures, mocks and snapshots, a deleted file, or a non-prose file outside the packages. Falls back
for one package when a changed file in it is not code, when the graph cannot be read, when a
dependency's changed source has no built copy, or when it owns a changed source file and no test
imports it. **The merge queue and the canary are untouched**: they run every suite on six shards.

Measure: the PR shard p50 at or under 14 minutes. Many pull requests fall back (any `scripts/` or
config change), so the median moves less than a single narrow PR does; also read the share of PR
runs whose log says "Tests chosen by import". A later step can give the lane fewer shards; this
one keeps the count so a package that falls back has the shards it had.

Revert if a queue ejection or a red main canary traces to a test this lane skipped on the pull
request, or if `gate.wf.test.test-shard.ejections_caused` rises above its floor with no gain in
PR shard duration.
