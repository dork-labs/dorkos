---
id: 261123-010539
title: credential-free-build, two tasks at a time, must not slow past its ceiling
kind: experiment
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: 'gate.wf.credential-free-build.credential-free-build.duration_p90@pull_request'
  baseline: 17.0
  baseline_source: 'origin/ci-steward-data snapshots 2026-11-15..2026-11-21 (data branch head d314da8bb6), gates["wf.credential-free-build.credential-free-build@pull_request"].durations: 797 completed runs, p50 10.6, p90 17.0 min. The same window @merge_group: 502 runs, p50 9.5, p90 16.0 min.'
  target: 18.0
  after_days: 7
ratchet-release: []
field-changes: []
---

The guard for 261123-005727 (the build step runs two tasks at a time, not four): the metric
that change could make worse, with a ceiling.

**What could get worse.** On a change whose affected set reaches the server, the client and
desktop, the heaviest tasks (6.3, 4.7, 4.7, 4.7, 3.7 and 3.5 GB, measured alone) now run in
pairs. Measured alone on a developer machine they take 66, 35, 35, 25, 20 and 31 s, so the
heavy tail is a few minutes longer on a 4-vCPU runner. A narrow change is unaffected.

**Target is a ceiling**: `verified` means the PR leg's p90 stays at or under 18.0 minutes,
the same ceiling 261117-143945 set. Read `duration_p90@merge_group` beside it (baseline
16.0): the queue leg is required too, and a slower run there holds every batch.

**If it fails**, keep two at a time (three does not fit in 16 GB) and move `lint` into its
own turbo call at a higher concurrency, after `build typecheck`.

**Why `gates: []`.** 261123-005727 lists the same gate and lands in the same PR, so listing it
here too would make that entry a confounder of this one and the ceiling would always come out
`inconclusive`, as 261117-143945 explains for its own pair.
