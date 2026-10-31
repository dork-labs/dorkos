---
id: 261030-193801
title: Two advisory workflows stop starting on pull requests that can't reach them
kind: experiment
status: active
actor: agent
gates: [wf.harness-windows.harness-windows, wf.site-build.site-build]
prs: [3310]
hypothesis:
  metric: tracked.job-minutes-per-merged-pr
  slo: pr-feedback
  baseline: 1163.2
  baseline_source: 'origin/ci-steward-data:reports/2026-W43.md, job minutes per merged PR over 2026-10-19..25 (113 merged PRs)'
  target: 1140
  after_days: 7
ratchet-release: []
field-changes: []
---

One push starts about 20 jobs against a 60-job pool, and PR runs compete with
queue runs. `harness-windows` and `site-build` are advisory, and both already
decide inside the job whether to do any work. A job that decides "no" still
waits for a runner, installs, and reports: 1 to 3 minutes of a runner for
nothing, after up to 20 minutes in line behind everyone else.

**The change.** Both get `paths:` on `pull_request` only. `merge_group` is
unfiltered, so the queue still runs both in full on every merge.

**How many PRs it reaches.** Over the last 40 PRs, 11 would skip
`harness-windows` and 22 would skip `site-build`. `harness-windows` also stops
running on client-only PRs: no suite in it imports the client, it was only in
the turbo closure because the CLI depends on it. The cost is that a break those
paths don't reach shows up as a queue ejection rather than on the PR.

**The expected move is small and noisy.** About 2%, because `test` dominates
the job minutes. A busy week can hide it, so read the before and after by hand.

**Revert if** `wf.harness-windows.harness-windows` or `wf.site-build.site-build`
causes more queue ejections with a real fix behind them in the after-window than
in the window before: that means the PR leg was catching things and the paths
are too narrow.

**Not touched.** `scripts-test.yml` holds the required `fixtures` job and
`credential-free-build.yml` is required, so neither can take a `paths:` filter.
