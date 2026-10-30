---
id: 261030-221104
title: the merge queue takes back out a head that already failed the same required check twice
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.queue-repeat-guard.door
prs: []
hypothesis:
  metric: 'tracked.repeat-ejections'
  slo: 'queue-green'
  baseline: 11
  baseline_source: "measured 2026-10-30 by hand from the PR timelines of the 350 PRs updated 2026-10-16..10-30: 85 failed-checks ejections, 22 of them on a head the queue had already ejected (any check), 7 of those a third or later try (#3104 x3 on 10-20, #3194 x2, #3265, #3096), so 11 per 7 days. The collector's repeat_ejections read 0 for 2026-10-29 because it counts PRs by merge day; #3216's repeat on 10-29 merged 10-30. Head = the last timeline commit or force-push before each removal"
  target: 7.5
  after_days: 14
ratchet-release: []
field-changes: []
---

Entry 260923-095512 made merge-tail refuse to re-arm a pull request whose current head failed the
same check in two queue builds. It only binds merge-tail. Agents arm with `gh pr merge --auto`, which
on a green pull request enqueues at once, and every re-queue in the baseline was made that way, not
by the merge-tail app: #3104 went back in four times on one commit on 10-20, each within a minute of
its last ejection. Each of those builds was red, and so was every build stacked behind it, because a
merge-group build carries every entry ahead of it.

The change: `.github/workflows/queue-repeat-guard.yml` runs on `merge_group: checks_requested`, the
one event every queue entry raises whoever queued it. `scripts/queue-repeat-guard.sh` reads the same
jq rule as merge-tail's gate (`should-arm-automerge.sh --repeat-failure`), keeps only checks listed in
`ci/required-checks.json` (`security-gate` fails in every merge group on a security path by design,
so without the filter two different ejections would read as a repeat), and dequeues on proof only.
The author is told once per head, under merge-tail's own comment marker. A `requeue-ok` label lets
one more try through and is removed as it passes, for the case where the failures were `main`'s.

The target removes the third-and-later tries (7 in the baseline's 14 days, 3.5 per 7 days); the
second ejection still happens, because it is the evidence. Report `queue-green` and
`wasted-queue-builds` beside it.

Known cost, seen in the baseline: #3265 failed `test` twice on one head (both `community-pg`
timeouts, a flake with its own fix in flight) and merged on its fourth try
unchanged. Under this guard it would have waited for a person to add `requeue-ok`. Revert, or narrow
the rule to non-flaky checks, if `requeue-ok` is needed on more than two pull requests a week whose
next try then passes unchanged: that is the guard stranding good work on flakes rather than stopping
regressions.
