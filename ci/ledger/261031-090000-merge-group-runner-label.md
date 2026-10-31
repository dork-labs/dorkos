---
id: 261031-090000
title: Queue runs of test-shard, community-pg and credential-free-build may use an opt-in runner label
kind: experiment
status: proposed
actor: agent
gates: [wf.test.test-shard, wf.test.community-pg, wf.credential-free-build.credential-free-build]
prs: []
hypothesis:
  metric: gate.wf.test.test-shard.duration_p90@merge_group
  slo: queue-build
  baseline: 24.3
  baseline_source: 'ci-steward-data snapshots/2026-10-29.json, gates["wf.test.test-shard@merge_group"], n=264 job durations: p50 22.3, p90 24.3 minutes'
  target: 15
  after_days: 14
ratchet-release: []
field-changes: []
---

`test-shard` and `community-pg` in `test.yml`, and `credential-free-build`, now pick their runner with `${{ github.event_name == 'merge_group' && vars.RUNNER_LABEL || 'ubuntu-latest' }}`.

**It changes nothing until a person sets the repository variable `RUNNER_LABEL`.** Unset, the expression is `'ubuntu-latest'` on every event, so this PR alone has no effect on any run. The variable is not set here and no agent sets it. The 14-day window starts from the day it is set; until then the verdict is expected to be `inconclusive` and that is correct.

Only `merge_group` runs may move. A `pull_request` run executes the PR's code, and a fork's code must never reach an org runner (Security's Must 1). The `schedule` canary also stays on `ubuntu-latest`. `scripts/__tests__/merge-group-runner-label.test.ts` pins both: every `runs-on` that names `RUNNER_LABEL` must carry the `merge_group` check, and every other `runs-on` in the two workflows must be `ubuntu-latest`.

Hypothesis: on a larger runner the queue leg of `test-shard` drops from p90 24.3 to 15 minutes, which shortens `queue-build`. What could get worse: `community-pg` and `credential-free-build` on a runner image that lacks something `ubuntu-latest` has (Postgres service containers need Docker; `env.ImageOS` may be empty on a self-hosted image, which still keys the pnpm store safely but shares it across images). Watch `gate.wf.test.community-pg.failure_rate@merge_group` beside it.

Revert: unset `RUNNER_LABEL` (instant, no PR) if any of the three gates' `merge_group` failure rate rises, or if `test-shard`'s queue p90 has not dropped below 20 minutes after 14 days.
