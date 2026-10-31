---
id: 261031-165048
title: a pull request runs the test suites whose turbo hash it changed, not turbo's affected packages
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard-count
  - wf.test.test-shard
  - wf.test.test
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.failure_rate@merge_group'
  baseline: 0.0362
  baseline_source: 'ci-steward-data snapshots 2026-10-24..30: wf.test.test-shard@merge_group, 51 failed or timed out of 1,410 that finished (1,434 runs, 24 cancelled or skipped)'
  target: 0.03
  after_days: 14
ratchet-release: []
field-changes:
  - gate: wf.test.test-shard
    field: shards
    from: '6 on a pull_request that changes apps/server/** or packages/shared/**, 2 on other pull requests, 6 on merge_group'
    to: '6 on a pull_request whose plan is every suite or reaches @dorkos/server, or that changes apps/server/** or packages/shared/**; 1 when the plan is none; 2 on other pull requests; 6 on merge_group'
  - gate: wf.test.test-shard-count
    field: timeout-minutes
    from: '5'
    to: '10'
---

DOR-3518 step 1, part two, stacked on 261031-164516. The pull request leg picked
its suites with `turbo test --affected`, which maps changed files to packages and
ignores every task's `inputs`. A change to `contributing/capabilities/runtimes.md`,
a declared input of the server suite, ran no test at all; so did a workflow-only
change, which the ci-steward suite reads. Only the queue's full run caught them,
and a red there is an ejection.

Now `test-shard-count` runs `scripts/test-plan.sh`, read from the base commit,
with the turbo version the base `package.json` pins. It dry-runs turbo on the base
and on the head and keeps the `test` tasks whose hash changed. A hash covers a
suite's own files, its declared inputs and the hashes of everything it builds on.
The shards run that list as turbo filters. The merge queue and the canary never
read the plan and still run every suite.

Security's conditions (#dorkos, 2026-10-31), each pinned by
`scripts/__tests__/test-plan.test.ts`: the queue stays full; a change to
`turbo.json`, any `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`,
`.github/`, `scripts/` or `ci/` runs every suite; a failed dry run, a reply that
is not turbo's plan, a package name that is not a plain npm name, or a plan that
selects nothing while a non-Markdown file changed runs every suite; and a
declared root input, a `ci/ledger/` change and a workflow-only change each select
tests. Markdown that no suite hashes runs none.

What it costs, written before the result. A pull request on Security's list now
runs every suite on six shards where `--affected` often ran nothing: of 386
finished pull request runs from 2026-10-24 to 2026-10-30, 47 tested nothing and
were mostly `ci/` and `.github/` changes. At about twelve minutes a shard that is
roughly 3,400 more runner-minutes a week. Watch
`gate.wf.test.test-shard.duration_p90@pull_request` and `queue.queue_wait` beside
the metric. Narrow the list (for example, `ci/ledger/` and `.github/` files no
suite reads) if `queue.queue_wait` p50 rises by more than a third while the queue
failure rate does not fall.
