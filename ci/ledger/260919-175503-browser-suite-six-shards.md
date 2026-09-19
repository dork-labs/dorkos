---
id: 260919-175503
title: 'Browser suite to six shards'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-shard
prs: []
hypothesis:
  metric: 'gate.wf.browser-test.browser-shard.duration_p90'
  slo: 'queue-build'
  baseline: 23.5
  baseline_source: 'research/20260919_ci-pipeline-01-inventory.md §0 fact 3: last successful queue browser shards took 20-23.5 min'
  target: 12
  after_days: 14
ratchet-release: []
field-changes: []
---

Seeded proposal 4 of 14 from plans/ci-steward-plan.md §6.

`browser-test` is the long pole in 90% of green queue builds. Doubling the shards halves the per-shard suite time at a fixed per-shard setup cost. Revert if the setup overhead makes the wall time no better.
