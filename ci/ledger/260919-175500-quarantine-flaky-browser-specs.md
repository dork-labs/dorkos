---
id: 260919-175500
title: 'Quarantine lane for flaky browser specs, shards 1 and 2 first'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-shard
  - wf.browser-test.browser-test
prs: []
hypothesis:
  metric: 'gate.wf.browser-test.browser-test.failure_rate'
  slo: 'wasted-queue-builds'
  baseline: 0.17
  baseline_source: 'research/20260919_ci-pipeline-02-timings.md: browser-test merge_group runs failed 17% over the 7 days to 2026-09-19'
  target: 0.05
  after_days: 14
ratchet-release: []
field-changes: []
---

Seeded proposal 1 of 14 from plans/ci-steward-plan.md §6.

Browser shards 1 and 2 are the main source of queue ejections. Quarantine tests the collector has classified flaky from data (plan §4.9 L1) so a known flake stops ejecting a green batch. Revert if a quarantined test hides a real regression.
