---
id: '261016-121046'
title: 'Split unit test files across six shards'
kind: 'experiment'
status: 'proposed'
actor: 'agent'
gates: ['wf.test.test-shard']
prs: [2945]
hypothesis:
  {
    'metric': 'gate.wf.test.test-shard.duration_p90@merge_group',
    'slo': 'queue-build',
    'baseline': 27.683333333333334,
    'baseline_source': 'Existing origin/ci-steward-data@989a126db72957b973786100aef4b58570c00110, snapshots/2026-10-08.json..2026-10-14.json:1646 completed non-skipped non-cancelled duration samples; exact collector linear p90 in minutes. Pinned latest collected2026-10-15; stale local-export health warning retained.',
    'target': 22,
    'after_days': 7,
  }
field-changes: [{ 'gate': 'wf.test.test-shard', 'field': 'shards', 'from': 4, 'to': 6 }]
ratchet-release: []
---

The merge-group unit job has exhausted its unchanged 30-minute budget twice. In run38873954612, shard4 completed its suite, quarantine gate and execution proof, then was cancelled during report upload by the job limit. The earlier run38860588052 also has a confirmed30-minute annotation; its complete sweep was not proven. These are budget failures, separate from the Recovery browser readiness failure.

Split each package's existing Vitest file partition four ways into six ways on both PR and merge-group legs. Keep every package task, serialized package graph, file union/execution proofs, quarantine semantics, report artifacts, retries, workers, job deadlines, required context and fan-in results unchanged. This divides files, not an individual slow test. Two additional runners repeat fixed install/build work and can consume more capacity.

The baseline is the existing pinned collector week2026-10-08 through2026-10-14 (1646 non-cancelled duration samples), not a new collection or a selected30-minute cancellation. The exact local collector ref/date and unhealthy stale-local-export warning are recorded in the proposal evidence. With roughly1.3minutes of current fixed setup, proportional reduction of a28-minute successful shard suggests about19.1minutes;22minutes leaves measured-cost margin. This is a hypothesis, not an observed improvement.

Check the seven-day after-window for p90 at or below22minutes, all six children and unchanged full union/proofs, timeout frequency, queue waiting and total runner cost. Revert or revise work division if the target is missed, cancellations increase, or added runner demand materially worsens queue wait; do not increase ceilings or drop coverage to declare success. Collector verdicts remain computed.
