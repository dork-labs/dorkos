---
id: 260819-235925
title: 'Browser suite runs in three shards behind one browser-test gate (#1135)'
kind: incident-fix
status: active
actor: agent
gates:
  - wf.browser-test.browser-shard
  - wf.browser-test.browser-test
prs: [1135]
hypothesis:
  metric: 'gate.wf.browser-test.browser-shard.duration_p50'
  slo: 'queue-build'
  baseline: 43
  baseline_source: 'PR #1135 body: the unsharded suite measured 40m33s-43m11s wall clock (41-45 min per DOR-1363); midpoint 43'
  target: 17
  after_days: 14
ratchet-release: []
field-changes: []
---

Backfilled on 2026-09-19 from research/20260919_ci-pipeline-04-change-tracking.md, as a
fixture for the phase-1 verdict engine. Not written at the time: #1135 stated a quantified
prediction ("41-45 min to ~17 min projected") but nothing checked it after rollout.

Why: the 41-45 minute browser suite made the merge queue time out and dequeue green PRs
(DOR-1363). What changed: a 3-way Playwright matrix behind one fan-in job that keeps the
`browser-test` check name, with the executed-count assertion extended to union the shards.

What was seen later, by accident: #1664 (2026-09-07) measured 20.2 min per shard and 22.1 min
wall. The expected verdict is "held, but by less than predicted"; the engine computes it.
Revert if shard wall time ever exceeds the unsharded suite.
