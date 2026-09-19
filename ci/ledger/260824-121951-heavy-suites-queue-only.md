---
id: 260824-121951
title: 'Heavy suites run once per PR in the merge queue, and the queue batches up to 5 (#1246)'
kind: incident-fix
status: active
actor: agent
gates:
  - wf.test.test
  - wf.browser-test.browser-test
  - ruleset.merge_queue
  - ruleset.required_status_checks
prs: [1246]
hypothesis:
  metric: 'queue.queue_wait'
  slo: 'wasted-queue-builds'
  baseline: 120
  baseline_source: 'PR #1246 body: on 2026-08-23, 88 runs queued against 14 running and "a two-hour merge queue" (run 32663568051)'
  target: 30
  after_days: 14
ratchet-release: []
field-changes: []
---

Backfilled on 2026-09-19 from research/20260919_ci-pipeline-04-change-tracking.md, as a
fixture for the phase-1 verdict engine. #1246 stated its hypothesis only qualitatively
("relieve saturation"); the target of 30 minutes is a reconstruction for the fixture, not a
number anyone wrote at the time.

Why: `test` and `browser-test` ran three times per merged PR under what was believed to be a
20-concurrent-job Free-plan cap. What changed: both suites moved to merge_group only and became
required; `max_entries_to_merge` went from 1 to 5. The `test` PR leg came back the same day
after a deadlock, and PR shards followed in #1646, so this is only partly still in force.

What was seen later, by accident: DOR-1818 / #1664 found 56% of merge_group browser builds
failed, 967 ejections across 71 PRs, and the Free-plan premise already false on the day it
shipped. The expected verdict is failed without a confounder, inconclusive with a planted
same-week confounder; the engine computes it.
