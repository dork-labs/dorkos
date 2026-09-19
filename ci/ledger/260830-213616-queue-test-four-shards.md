---
id: 260830-213616
title: 'Queue test sweep split across four shards (#1391)'
kind: experiment
status: active
actor: agent
gates:
  - wf.test.test-shard
  - wf.test.test
prs: [1391]
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50'
  slo: 'queue-build'
  baseline: 26
  baseline_source: 'PR #1391 body: the serialized queue sweep took 19-29 min wall clock, "~26 min"'
  target: 10
  after_days: 14
ratchet-release: []
field-changes: []
---

Backfilled on 2026-09-19 from research/20260919_ci-pipeline-04-change-tracking.md, as a
fixture for the phase-1 verdict engine. #1391 was a planned change with a quantified
prediction ("~26 min to ~10 min per queue build, at $0"), and no post-rollout check.

What changed: the queue's full `turbo test` sweep runs as four vitest file shards, each still
proving every package executed, behind a fan-in that keeps the `test` check name.

What was seen later, by accident: #1646 (2026-09-07) measured the queue shards at 8-13 min each.
The expected verdict is "held"; the engine computes it. Revert if the shards' union ever stops
covering every package.
