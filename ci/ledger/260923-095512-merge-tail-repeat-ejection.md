---
id: 260923-095512
title: merge-tail stops re-arming a PR the queue rejected twice for the same check
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.merge-tail.arm
prs: []
hypothesis:
  metric: 'tracked.repeat-ejections'
  slo: 'wasted-queue-builds'
  baseline: 11.5
  baseline_source: "measured 2026-09-23 from the PR timelines of the 278 PRs updated 2026-09-09..09-23: 106 failed-checks ejections on 77 PRs, 23 of them repeating a check that had already failed on the same unchanged head (12 PRs; #1964, #1933 and #1794 four each), so 11.5 per 7 days. Head push time = earliest check suite on the head commit; failing checks = FAILURE/TIMED_OUT/STARTUP_FAILURE runs on each removal's merge-group commit"
  target: 6
  after_days: 14
ratchet-release: []
field-changes: []
---

PR #1964 broke one browser assertion. Browser tests run only in the merge queue, so its PR checks
read green, and it was re-armed unchanged after four of its five ejections (merge-tail once, agents
following our own "re-arm once it is plainly not yours" advice three times), for 17 queue builds
counting every PR stacked behind it. It merged only after a real fix.

The change: `scripts/should-arm-automerge.sh` refuses (`SKIP repeat-queue-failure`) when one check
failed in two or more queue removals since the current head was pushed; merge-tail reads that from the
same GraphQL call it already makes, comments on the PR once per head naming the check, and arms again
after a new commit. The advice in AGENTS.md, `contributing/ci.md`, the creating-pull-requests skill
and the watcher's remedy text now says: re-arm once; the same check failing again on the same head is
a regression, stop and fix it.

The target is one repeat per regression instead of up to four: the second ejection still happens (it
is the evidence), and the rule only binds merge-tail, so the rest of the drop depends on agents
following the new advice. Honest limit: 3 of the 12 PRs in the baseline (#1930, #1932, #1933) were
failing on a break that had landed on `main` (the wall-clock fixture), where the rule declines a PR
that is not at fault; the comment tells the author to re-arm by hand once `main` is fixed.

`tracked.repeat-ejections` is not computed by the collector yet, so no verdict is produced until it
learns the two reads this rule makes (the failing check names of each removal's merge-group commit and
the head's first check-suite time); until then this entry is judged by re-running the measurement
above by hand. Revert if a flaky check starts failing twice in a row on unchanged heads often enough
that merge-tail strands green PRs, visible as `repeat-queue-failure` skips on PRs that later merge
with no new commit.
