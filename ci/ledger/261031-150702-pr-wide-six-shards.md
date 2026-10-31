---
id: 261031-150702
title: a pull request that changes apps/server or packages/shared runs six test shards again, so it finishes inside the 30-minute ceiling
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard-count
  - wf.test.test-shard
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p90@pull_request'
  slo: 'pr-feedback'
  baseline: 30
  baseline_source: 'release PR #3357 and PR #3221, 2026-10-30..31: test-shard on 2 shards (ledger 261030-233825) was cancelled at its 30-minute timeout-minutes on both, so p90 is pinned at the ceiling for any PR that touches apps/server or packages/shared'
  target: 20
  after_days: 7
ratchet-release: []
field-changes:
  - gate: wf.test.test-shard
    field: shards
    from: '2 on pull_request, 6 on merge_group'
    to: '6 on a pull_request that changes apps/server/** or packages/shared/**, 2 on other pull requests, 6 on merge_group'
---

Ledger 261030-233825 cut the pull request leg of `test-shard` from 6 shards to 2 to free runners for
the merge queue. It assumed two shards would keep the widest PR sweep near 20 minutes. They did not:
a change to `apps/server` or `packages/shared` makes the affected sweep nearly the whole monorepo,
and on two shards release PR #3357 and #3221 both hit the 30-minute ceiling and were cancelled. A
cancelled shard reds the required `test` check, so those PRs could not enter the queue at all.

A new job, `test-shard-count`, runs before `test-shard` and hands it the shard list. On a pull
request it diffs the test-merge commit against its first parent: a change under `apps/server/**` or
`packages/shared/**` gets six, anything else keeps two. `merge_group` and the canary always get six.
If the diff cannot be computed, it picks six, never two. If the job itself fails, `test-shard` is
skipped and the `test` fan-in fails, so it cannot turn into a false green.

What this costs, and the revert condition, written before the result: wide PRs take back 4 runners
per push, which is the queue starvation 261030-233825 was fixing. Watch `queue.queue_wait` beside
the PR duration. Revert to a flat 2 and split the work another way if `queue.queue_wait` p50 rises
by more than a third over its 261030-233825 level while wide PRs still do not finish under 25
minutes.
