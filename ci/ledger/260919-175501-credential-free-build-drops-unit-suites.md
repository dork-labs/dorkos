---
id: 260919-175501
title: 'credential-free-build stops re-running the unit suites, keeping build, typecheck and boot'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.credential-free-build.credential-free-build
prs: []
hypothesis:
  metric: 'gate.wf.credential-free-build.credential-free-build.duration_p90'
  slo: 'queue-build'
  baseline: 55
  baseline_source: 'research/20260919_ci-pipeline-02-timings.md: credential-free-build in merge_group ran 25.7 min median, 55 min p90, 21% failures'
  target: 20
  after_days: 14
ratchet-release: []
field-changes: []
---

Seeded proposal 2 of 14 from plans/ci-steward-plan.md §6.

In the queue the same package suites run twice in parallel, once sharded in `test` and once serially here, and the serial copy is the critical path. Keep what only this job proves (the app builds and boots with no cloud credentials). Revert if a credential-dependent test failure reaches main.
