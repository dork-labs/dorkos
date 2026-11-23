---
id: 261123-194400
title: Queue and canary unit tests run in ten shards
kind: experiment
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: []
hypothesis:
  metric: gate.wf.test.test-shard.duration_p90@merge_group
  slo: queue-build
  baseline: 25.1
  baseline_source: 'origin/ci-steward-data@ea53d593d4, snapshots/2026-11-19.json..2026-11-22.json: 1,590 completed merge_group test-shard durations, linear p90 25.1 min (p50 21.9). Only days after #3941 (build once, run --only, merged 2026-11-18) so the per-shard setup matches today. latest.json reports healthy=false on that ref; the per-day samples were read as stored.'
  target: 18
  after_days: 7
ratchet-release: []
field-changes: [{ gate: wf.test.test-shard, field: shards, from: 6, to: 10 }]
---

DOR-5113. Follows 260830-213616 (1 to 4 shards, kept though its p50 target missed,
closed by 261001-130114), 261016-121046 (4 to 6) and 261104-040000 (duration-aware
balancing, which said a seventh shard would be its own decision). Ten was never tried.

Since #3941 (ledger 261118-140000) every shard builds once from the canary's cache
and runs its suites `--only`, so the fixed part of a shard is about three minutes
and the rest is test files, which `--shard` divides. Going from six to ten on
`merge_group` and the scheduled/dispatched canary should take the slowest shard
from about 25 minutes to about 16 (22 minutes of tests times 6/10, plus setup).
The target is 18, leaving room for the work that does not divide: each shard still
starts every package's Vitest and pays its own checkout and install. Balancing the
current snapshot (`scripts/sharding/durations.json`, run 43771272162) with
`scripts/sharding/balance.ts` gives a largest shard of 26.78 serial test-minutes
at six and 16.67 at ten (-38%). That is a simulation of test work, not wall time.

Pull requests keep today's choice exactly: six for a wide change, two for a
narrow one, one for a text-only one. A pull request into a release branch keeps
six too: it runs the full sweep, but it is armed on a pull request's CI proof,
which counts at most six shards. Every line of the queue leg that named its total
as a literal 6 (the suite's `--shard=`, the step name, the quarantine lane and
gate titles, `shard.txt`, the retry report) now reads `strategy.job-total`; the
fan-in already derived its total from `shard.txt`. The duration snapshot
(`scripts/sharding/durations.json`) is per file and the balancer takes the shard
count from Vitest, so it needs no change; `scripts/sharding/refresh.mjs` now
prints its simulation for ten shards instead of six.

Cost: four more jobs per queue build and canary run (about 34 instead of 30),
each repeating about three minutes of setup, so roughly 12 more runner-minutes a
build for the same total test time. Runners are free on this public repo. The
risk is the concurrent-job pool: 261030-233825 saw PR runs starve the queue of
runners. Revert to six if `queue.queue_wait` or runner queueing (jobs waiting to
start in the queue builds) rises over the after-window, if shard cancellations or
union/quarantine-lane refusals increase, or if the p90 does not fall below 21.
Never raise a deadline or drop coverage to make the target.
