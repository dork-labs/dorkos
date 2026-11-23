---
id: 261123-195020
title: main's scheduled canary runs once a day, not four times, now that every merge saves the build caches
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test
  - wf.test.test-shard
  - wf.test.community-pg
  - wf.test.community-packaged
  - wf.browser-test.browser-test
  - wf.browser-test.browser-shard
  - wf.typecheck.typecheck
  - wf.lint.lint
prs: []
hypothesis:
  metric: 'tracked.canary-minutes'
  baseline: 642
  baseline_source: 'ci-steward-data snapshots 2026-11-16..22, counts.canary_minutes: 647, 739.9, 593.9, 621.9, 597.4, 634.5, 660.5 (mean 642.2 job-minutes a day). Each day held 8 canary runs (4 workflows x 2 rounds): GitHub delivered two of the four slots, at 01:27-03:07Z and 13:29-14:41Z.'
  target: 360
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-5114, after DOR-4627 (ledger 261123-194610). `test.yml`, `browser-test.yml`, `typecheck.yml`
and `lint.yml` asked for four canary rounds a day (`0,5,10,21` UTC, minutes 29/33/37/41) and GitHub
delivered two, about 640 job-minutes a day on top of the merge queue, which already runs the full
suites on every merge.

The canary did three jobs. It was the only writer of main's build caches, which
`build-cache.yml` now does after every merge (261123-194610). It catches breaks with no code
change: runner images, the npm registry, date- and time-dependent tests. And it feeds flake data
and shard durations. One round a day covers the last two.

The change: each of the four workflows keeps one slot, `<minute> 0 * * *` (00:29, 00:33, 00:37,
00:41 UTC; recent deliveries of the 00 slots landed 01:30-03:00Z, in or just after the 00:00-02:00
dark window and as the queue's busy stretch tails off). `ci/config.yaml`'s `canary_silent_hours`
goes from 18 to 40: one round a day plus up to about 12 hours of GitHub lateness (`evals.yml`'s
daily cron: p50 2.60 h, p90 5.61 h, max 11.88 h late), so two healthy rounds can land about 36 hours
apart, and a whole missed day still crosses it. The silence arm's worst case to a report grows from
about 39 to about 64 hours. `canary.workflows`, the census rules (schedule present with a cron, a
job runnable on schedule) and the ref guard are unchanged. The workflow headers,
`packages/ci-steward/src/canary.ts`, `contributing/ci.md` and harness-windows.yml's slot note now
say one slot.

What this costs, stated before the data: `tracked.time-to-detect` (the main canary entry
260920-184120, target 720 min p90) rises to about a day plus lateness, so that entry's target no
longer holds by design; a drift break is found within about a day rather than half a day. Breaks
that come from code are still caught by the merge queue before they land. A red round now fires
rule 11 on about 14% of days rather than about 46% (the 5.1% per-shard rate, one round instead of
four), which also means one red day is a stronger signal.

Expected within 14 days: `tracked.canary-minutes` near 320 a day (one round), at or under 360; the
daily report shows 4 canary runs a day; no `main-canary-silent` or `main-canary-stopped` trigger
on a day the round arrived. Done when (DOR-5114) the cache hit rate is not down (read with
261123-194610) and drift failures are still caught within a day. Revert to more slots if a drift
break on main goes unreported for more than a day, if the silence arm fires on throttling alone,
or if queue shards' turbo restores show older entries again (which would mean build-cache.yml is
not saving).
