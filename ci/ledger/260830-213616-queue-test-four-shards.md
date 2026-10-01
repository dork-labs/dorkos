---
id: 260830-213616
title: 'Queue test sweep split across four shards (#1391)'
kind: experiment
status: withdrawn
actor: agent
gates:
  - wf.test.test-shard
  - wf.test.test
prs: [1391]
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50@merge_group'
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
The expected verdict was "held"; the engine computes it (phase 1: partial, see the plan's §4.4).
The metric names the queue leg (`@merge_group`): the hypothesis is about the queue build, and from
#1646 (2026-09-07) the same shards also run affected-only on PRs, which would otherwise mix in. Revert if the shards' union ever stops
covering every package.

Closed on 2026-10-01 by 261001-130114. The collector's verdict is `failed`: the after-window
(2026-08-30 to 2026-09-13, n=3389) read 12.2 min per queue shard against the target of 10,
and less than halfway from its baseline. That baseline is the before-window's own 11.2
(n=16), most likely #1391's own queue builds, since the shard job did not exist on
`main` before it merged; the ledger's 26 was not used. Either way the prediction of ~10 min
was missed. The SLO it served, `queue-build` p50, went from 34.8 to 24.4 min. The four shards
are kept, so this entry is `withdrawn`, not `reverted`: the hypothesis is closed and the
change is still live. The hypothesis above is left exactly as it was judged.
