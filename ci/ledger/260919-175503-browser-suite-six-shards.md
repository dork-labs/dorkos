---
id: 260919-175503
title: 'Browser suite to six shards'
kind: experiment
status: active
actor: agent
gates:
  - wf.browser-test.browser-shard
prs: [2212]
hypothesis:
  metric: 'headroom'
  slo: 'queue-build'
  baseline: 0.969
  baseline_source: 'origin/ci-steward-data:latest.json for 2026-09-26, headroom over 2026-09-20..26 (n=24169; worst gate wf.browser-test.browser-shard, n=1208, p95 29.0 min against the 30-min globalTimeout). The next worst gate is wf.test.test-shard at 0.597, so this SLO reads this gate unless another one regresses.'
  target: 0.8
  after_days: 7
ratchet-release: []
field-changes:
  - gate: wf.browser-test.browser-shard
    field: shards
    from: 3
    to: 6
---

Seeded proposal 4 of 14 from plans/ci-steward-plan.md §6, taken up on
2026-09-27 when `headroom:wf.browser-test.browser-shard` went red.

## What was wrong

A three-way shard no longer fit its deadline. Over 30 green queue runs on
2026-09-26/27 (90 shard jobs) the suite step ran p50 25.3, p95 27.4, max 28.5
minutes against Playwright's 30-minute `globalTimeout`; the job ran p50 27.9,
p95 30.0. The duration-balanced cut (260923-095643) did its job, since the
three shards now take about the same time, but the suite kept growing (454
tests on 2026-09-23, 512 now) and all three rose together.

The deadline had also gone stale on its own. `playwright.config.ts` derives
`globalTimeout` from two facts measured on 2026-08-19, a 41-minute unsharded
suite and 4 minutes of boot. Today they are 58 and 5. Re-derived honestly,
three shards would get 40 minutes, not 30, so healthy runs sat close to a deadline built for a suite a third smaller:
the suite step's p95 was 27.4 of 30 on Playwright's own clock (0.91), and the
job, which `headroom` reads, 30.0 (0.97).

## The change

- `browser-test.yml`: `shard: [1, 2, 3]` becomes `[1, 2, 3, 4, 5, 6]`. The
  `--shard` flag, `E2E_SHARD_TOTAL`, artifact names and the fan-in's shard-set
  and lane checks all read `strategy.job-total`, so nothing else names the
  count. `browser-test` still `needs: browser-shard` (every leg) and refuses
  anything but `success`; `assert-browser-tests-executed.sh` still demands
  exactly shards 1..N, one report each, every shard with tests of its own, and
  no test in two shards.
- `playwright.config.ts`: `UNSHARDED_SUITE_MINUTES` 41 → 58 and
  `LEG_BOOT_MINUTES` 4 → 5, measured (the method is in the file). At six
  shards the derivation gives 25 minutes, so `ci/config.yaml`'s `deadlines:`
  goes 30 → 25 and `ruler.test.ts` holds the two together.
- `reporters/shard-timings.json` regenerated from the 7 latest green queue
  runs (101 units, 512 tests, 52.7 min). The six-way cut estimates 8.8 min of
  tests per shard, flat to 0.1 min.

## Why six

Per shard: 2.5 min (p95 2.9) outside the suite step, 3.0-5.1 min of boot
inside it, then its share of 52.7 min of tests. At p95 a shard runs about 1.25x
its estimate (this reproduces the measured 30.0 at three shards).

| shards | job p95 (min) | derived deadline | p95/deadline |
| -----: | ------------: | ---------------: | -----------: |
|      3 |   30 measured |       30 (stale) |         0.97 |
|      5 |          21.2 |               30 |         0.71 |
|      6 |          19.0 |               25 |         0.76 |
|      7 |          17.4 |               25 |         0.70 |
|      8 |          16.2 |               25 |         0.65 |

The deadline follows the count, so the ratio lands at 0.65-0.76 anywhere from
five to eight and does not pick the count. Wall time does: at six the job is
about 17 min p50 and 19 p95, close to with the vitest `test-shard` jobs (p50 14.8,
p95 17.9) the queue also waits for. Past six the browser suite stops being the
queue's long pole, so a seventh or eighth shard buys time the queue cannot use
while every shard re-pays about 8 fixed minutes.

## Prediction

The shard job's p95 goes from 30.0 to about 19 min, and `headroom` from 0.969
to about 0.76. Target 0.8; 0.885 would be halfway. `queue-build` is reported
beside it and has its own guard entry (260927-170236).

## Cost

Three more jobs per queue build (about 31 → 34 non-skipped check runs) and per
canary round (4 a day). About +24 job-minutes per queue build (3 × 8 fixed; the
test minutes only move between runners), about +45 per merged PR at today's
~1.8 queue builds per merged PR, against 555 in total
(`tracked.job-minutes-per-merged-pr`, 7 days to 2026-09-26). The collector's
flaky sample reads 3 more artifacts per queue build, about +30 requests a day
against a 700 budget (279 used on 2026-09-26).

## Reading the verdict

- **The ruler moves with the change.** Readers apply `deadlines:` to every day
  they read, so from the merge the before-window's three-shard runs are read
  against 25, not the 30 they ran under: about 1.1-1.2. The verdict prefers
  that before-window measurement over the baseline above, which makes
  `partial` easier to reach; `verified` (≤ 0.8 in the after-window) does not
  depend on it. The daily `headroom` reading shows the same mix, above 1.0, for
  up to 7 days after the merge. That is the ruler, not a regression.
- **This confounds 260923-095643** (balance by duration, same gate, after-window
  to about 2026-10-07): its verdict will read `inconclusive`. Its own effect
  was visible before this change: the three shards' steps are now within 1.5
  minutes of each other (p95 26.8 / 26.6 / 28.0), where they were 20.7 / 21.8 /
  27.6.

## Revert if

A shard's suite step reaches 20 minutes (0.8 of its 25) at p95 in the
after-window, or `queue-build` p50 or p90 gets worse than 29.7 / 58.6 (runner
contention from three more jobs a build), or the added cost is not paid back in
queue time.
