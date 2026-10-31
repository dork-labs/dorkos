---
id: 261031-164008
title: a pull request runs the test suites whose turbo hash it moved, not turbo test --affected
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
  baseline: null
  baseline_source: 'not measured by hand: the collector reads the 7 days before this lands. Run-level wall time for test.yml pull_request runs (last 40 green, 2026-10-31) is 9 to 336 min, mostly queueing, so it cannot stand in for shard time.'
  target: 10
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-3518, PR B of two, stacked on PR A (261031-163500). The pull request leg ran
`turbo test --affected`, which picks packages by changed files and ignores task `inputs`: a change
to `contributing/capabilities/runtimes.md`, a declared input of `@dorkos/server#test`, ran zero
tests. `scripts/pr-test-plan.sh` runs `turbo test --dry=json` on the test-merge commit's base and
on its head and keeps the test tasks whose hash changed, so declared inputs and everything a suite
builds on count.

**The merge queue and the canary are untouched**: they run every suite on six shards, as before.
Nothing reaches `main` on this leg's choice alone.

A change cannot select its own tests away: a change to `turbo.json`, any `package.json`, the
lockfile, the workspace, `.npmrc`, the root vitest config, `.github/`, `scripts/` or `ci/` runs
every suite, and the workflow runs the planner and the turbo version from the base commit. Every
doubt runs every suite too: no test-merge commit, a failed or empty turbo plan, or a plan of
nothing. A plan of every suite, or one that reaches `apps/server` or `packages/shared`, gets six
shards.

What this can make worse, and the revert condition, written before the result: a full-suite pull
request (any `scripts/` or `.github/` change) now runs every suite where `--affected` ran a few,
which costs runners while the queue is short of them. And a test that reads a file nobody
declared is skipped on a pull request when only that file changes, so the break is found in the
queue, where it ejects a build. Watch `gate.wf.test.test-shard.ejections_caused` and
`queue.queue_wait` beside the PR duration. Revert to `--affected` if ejections from `test` rise
above their floor with no PR-leg duration gain, or if PR-leg runner minutes rise by more than a
quarter.
