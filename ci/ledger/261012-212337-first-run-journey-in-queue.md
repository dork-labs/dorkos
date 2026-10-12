---
id: 261012-212337
title: The one-minute first run gates the merge queue, so a broken first run cannot land silently
kind: experiment
status: proposed
actor: agent
gates: [wf.browser-test.first-run, wf.browser-test.browser-test]
prs: []
hypothesis:
  metric: 'gate.wf.browser-test.first-run.failure_rate@merge_group'
  baseline: 0
  baseline_source: "local run of pnpm --filter @dorkos/e2e e2e:first-run on 2026-10-12, Apple Silicon: 2 of 2 paths passed, DorkOS path 5958 ms and own-AI path 2286 ms against the 60000 ms bar, 5.3 min wall time with cold server builds. Never yet run on ubuntu; this PR's queue build is the first."
  target: 0.03
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-2783 added `apps/e2e/first-run/first-run.journey.ts`, which times a never-onboarded install from Welcome to DorkBot's first reply on both paths. Nothing ran it in CI, so a change that broke the one-minute first run, the claim the launch leans on, would merge green (DOR-2844).

It now runs as its own `first-run` job in `browser-test.yml`, beside the shards: merge queue and main canary only, a pass-through on pull requests like the shards, and the required `browser-test` fan-in fails unless it passed. It cannot share a shard: it needs fresh homes and its own test-mode flags. It runs in parallel with the six shards and is shorter than any of them, so the queue build should not get longer.

Why this metric: the change adds a blocking test, and the risk it brings is a flaky one ejecting good PRs. The target says it fails at most 3% of queue builds. The job does not read the quarantine lane and the config has no retries, so the only remedy for a flaky run is a revert PR (or adding the lane in a follow-up). Revert if it goes above that without a real regression behind the failures, or if `gate.wf.browser-test.browser-test.duration_p90@merge_group` rises because this job became the longest leg.
