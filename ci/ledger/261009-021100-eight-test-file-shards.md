---
id: 261009-021100
title: Split serial unit-test work across eight file shards
kind: experiment
status: proposed
actor: agent
gates: [wf.test.test-shard]
prs: [2673]
hypothesis:
  metric: gate.wf.test.test-shard.duration_p90@pull_request
  slo: pr-feedback
  baseline: 23.318333333333335
  baseline_source: 'ci-steward-data snapshot2026-10-07.json collected2026-10-08T11:54:40.495Z; wf.test.test-shard@pull_request,350 completed non-cancelled durations,404 total runs including54 cancelled and18 failed. Baseline is linearly interpolated p90 in minutes using the collector quantile definition.'
  target: 18
  after_days: 7
ratchet-release: []
field-changes:
  - gate: wf.test.test-shard
    field: shards
    from: 4
    to: 8
---

Current431ffe shard1 job113625945675 reached the unchanged thirty-minute
ceiling. The serial affected step started01:31:18Z; server:test began01:43:32Z
and was still active at02:00:38Z cancellation. Between the first task and
server:test, build-task slots consumed161.252seconds and earlier test-task
slots572.191seconds. Client:test alone occupied413.677seconds. These are
observed intervals between task-start logs, including boundary overhead,
not CPU measurements or twelve minutes of dependency compilation.

Increase the file-shard matrix4→8 while retaining package concurrency1,
the original affected/full task graphs, assertions, worker configuration,
5-second body/10-second hook defaults, PR retry0, queue retry1 with its
existing retry reports, quarantine controls and30-minute job deadline.
Both command denominators, shard identities and report labels use8. The
fan-in still requires the whole matrix to succeed; queue collection still
requires the complete1..N lane set and every package in the file union.
The existing inline flake-reporter fixture follows the new shard label.
The census gate purpose becomes count-neutral; required context test is
unchanged, and no ruleset edit or quality-floor release is involved.

The installed original Vitest sequencer partitions the same collected
file set into disjoint ranges after deterministic path hashing. The
source-only partition proof checks4- and8-way unions and no overlap over
tracked test-filename inputs plus boundary-cardinality cases. This does
not claim actual runtime discovery or a newly executed remote suite.

The target18-minute PR shard p90 is a hypothesis for the collector's
seven-day after-window, not a promised completion time. Eight jobs double
peak shard slots and repeat fixed setup/build costs four extra times.
Using this failed run's observed161-second build slots alone suggests
about10.75 additional runner-minutes per workflow before extra startup;
actual cost and pool queueing must be observed, including queue/canary
legs. Retain the failed431ffe run. Cold-import SIGTERM and Relay/focus body
failures remain separate defects; this schedule change does not repair
or waive them, and does not authorize an unchanged retry.

Revert if the after-window PR shard p90 misses18minutes, complete shard
collection/union fails, or extra runner contention outweighs feedback-time
savings. Read collector outcome and actual runner minutes before claiming
improvement; concurrent changes to the same gate may confound the verdict.
