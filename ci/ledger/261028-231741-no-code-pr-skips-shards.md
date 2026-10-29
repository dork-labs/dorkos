---
id: 261028-231741
title: A pull request that changes only changelog, docs or version lines skips the test shards
kind: experiment
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: []
hypothesis:
  metric: gate.wf.test.test-shard.duration_p50@pull_request
  baseline: 16.8
  baseline_source: 'ci-steward-data snapshots 2026-10-21 to 2026-10-27, gates["wf.test.test-shard@pull_request"].durations, n=1372 job runs (p90 23.2 min); latest.json carries no per-gate durations'
  target: 15.5
  after_days: 14
ratchet-release: []
field-changes: []
---

Release PRs bump `"version"` in package.json files, and a root package.json change is global to turbo, so `turbo test --affected` ran the full suite on all six PR shards for tests nothing in the diff could change (PR #3237: shard 3/6 spent 13m18s of turbo time; vitest import 412s, tests 686s). Changelog-only and docs-only PRs pay the shard setup for nothing too.

`scripts/no-code-scope.sh` now skips the PR leg's test step when every changed path is `CHANGELOG.md`, `VERSION`, `changelog/`, `docs/`, `blog/`, or a package.json whose diff changes only `"version"` lines. It fails open to running the tests on any doubt. The job still runs and reports, so the required `test` context is unchanged; the merge queue and the main canary run the full suite exactly as before.

Bet: those shards drop to checkout plus install (about 2 minutes), pulling the PR-leg median from 16.8 to 15.5 minutes or lower. Revert if a queue ejection is traced to a change this skipped that the old PR leg would have caught, or if the median does not move.
