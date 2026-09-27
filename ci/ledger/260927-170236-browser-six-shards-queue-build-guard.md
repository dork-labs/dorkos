---
id: 260927-170236
title: Six browser shards must not slow the queue build
kind: experiment
status: active
actor: agent
gates: []
prs: [2212]
hypothesis:
  metric: 'queue-build'
  slo: 'queue-build'
  baseline: 29.7
  baseline_source: 'origin/ci-steward-data:latest.json for 2026-09-26, queue-build over 2026-09-20..26 (n=167, p50 29.7, p90 58.6)'
  target: 29.7
  after_days: 7
ratchet-release: []
field-changes: []
---

The guard for 260919-175503 (browser suite from three shards to six), the
second entry the change protocol asks for: the metric that change could make
worse, with a ceiling.

**What could get worse.** Six shards add three jobs to every queue build
(about 31 → 34) and to every canary round, on a 60-job pool the queue shares
with every PR push. If runners get scarcer, shards wait longer to start, and a
queue build is only as fast as its last job. Runner wait for a browser shard
was p50 0.03, p90 3.05 min over the 30 green queue runs of 2026-09-26/27.

**The ceiling is today.** Target equals the baseline: `verified` means the
queue build's p50 is at or under 29.7. That is a fixed number, not the
before-window's own reading, so a week that was already faster than 29.7 and
slowed down could still read `verified`; with `gates: []` no other change
counts as a confounder either. Compare the verdict's before and after
readings by hand, not only its label. The verdict reads p50 (the SLO's first
objective); read p90 beside it by hand, and treat anything over 58.6 as the
same failure.

**What is expected instead.** The browser shard is the queue's long pole (job
p50 27.9 min, against 14.8 for the vitest `test-shard` jobs). At six it should
be about 17, so the p50 queue build should fall by several minutes, not merely
hold.

**No gates, on purpose.** The verdict's confounder check matches entries by
gate. Naming `wf.browser-test.browser-shard` here would make this entry and
260919-175503, merged in the same PR, confound each other and leave both
`inconclusive`. This entry measures the queue as a whole.

**Cost, noted, not scored:** about +45 job-minutes per merged PR against 555
(`tracked.job-minutes-per-merged-pr`, 7 days to 2026-09-26). Revert
260919-175503 if this entry fails, or if job-minutes per merged PR rise by more
than about 60 with no queue-build gain.
