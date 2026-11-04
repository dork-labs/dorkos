---
id: 261104-040000
title: duration-aware-shards — balance unit test work across six runners
kind: experiment
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: []
hypothesis:
  metric: gate.wf.test.test-shard.duration_p90@merge_group
  slo: headroom
  baseline: 24.2
  baseline_source: 'Run 41704679385, 2026-11-03: slowest test sweep 24.2 minutes; six sweep walls 14.4, 24.2, 18.4, 23.4, 18.2, 15.2. A single-run maximum is a provisional proxy for p90, not a measured p90.'
  target: 21
  after_days: 7
ratchet-release: []
field-changes: []
---

After #3483 (narrow checkout), keep six runners and change file assignment from
Vitest's hash/count split to longest-first duration balancing within each package.
The union and quarantine checks, retry budget, timeouts and package selection stay
as they are. Both PR and queue sweeps load the sequencer; narrow PRs retain two shards.

The reviewed snapshot contains only repo-relative file names and elapsed milliseconds,
from the green run 41704679385 (5,093 files). It contains no assertion names, output,
credentials or machine paths. Refresh it with
`node scripts/sharding/refresh.mjs <downloaded-report-directory> <run-id>` and review
that diff. Use a complete green full-suite run's six `vitest-shard-report-*` artifacts,
not assertions copied from local homes. Refresh weekly while measuring this experiment.

New files get their package's median duration (at least one second). Missing,
malformed, future or over-30-day-old snapshots fall back to the installed Vitest's
unchanged hash/count partition. Age is relative to the tested commit timestamp,
pinned identically on every runner; the fresh/fallback mode enters each test key; wall-clock expiry
could switch algorithms halfway through a build and leave holes. Old-commit reruns
therefore keep their original partition. Snapshot and sequencer changes also enter
every test cache key through task inputs. Epoch and snapshot changes do not
invalidate build caches.

Simulation over recorded test work, balancing each package separately and adding
its bins in Turbo's serial package order: **20.01, 20.13, 19.91, 20.77, 20.29, 19.78
minutes**. This excludes build, worker startup, import/collection, checkout, retries
and CPU variation. It is not a measured wall-time win or proof of the <=21m target.
Package-specific tie rotation avoids always giving small-package remainders to runner 1.

Measure a week of actual sweep/job times and missing-snapshot fallbacks. A seventh
shard is a separate decision only if wall times still exceed 21 minutes after that
week. Revert the two sequencer flags if duration balancing doesn't improve the tail
or causes collection/coverage regressions; the default split remains available.
Security reviews this workflow change at its exact head; PR stays on hold.
