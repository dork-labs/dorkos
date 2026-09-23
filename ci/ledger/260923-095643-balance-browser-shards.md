---
id: 260923-095643
title: Cut the browser shards by measured duration
kind: experiment
status: active
actor: agent
gates:
  - wf.browser-test.browser-shard
  - wf.browser-test.browser-test
prs: [2006]
hypothesis:
  metric: 'gate.wf.browser-test.browser-shard.duration_p90@merge_group'
  slo: 'headroom'
  baseline: 28.9
  baseline_source: 'Actions job records, 656 completed browser-shard jobs of merge_group runs created 2026-09-16..23 (pooled across the three shards; shard 3 alone 29.6)'
  target: 26
  after_days: 14
ratchet-release: []
field-changes: []
---

**The deadline that fires is not the one `headroom` watches.** `headroom` reads
job time over `timeout-minutes` (45) and reports 0.65 for this gate. The rung
that actually fires is the inner one: the "Run the browser suite" step against
Playwright's 30-minute `globalTimeout`. Over the same 656 jobs, shard 3's step
ran p50 25.4, p95 27.6, max 30.0 min, which is **0.92** of that limit. It hit
the limit once (2026-09-20 17:46, "Timed out waiting 1800s", 134 tests
passed). Shards 1 and 2 ran p95 20.7 and 21.8.

**Why shard 3.** Playwright's `--shard` cuts by test count, in `projects`
order. The one big cockpit project (`chromium`) comes first, and all seven
test-mode projects come after it. Their tests take about 40% longer each
(8.5 s against 6.1 s; `chromium-mock` alone is 8.2 min). An equal count gave
shard 3 all 135 test-mode tests plus 16 cockpit ones. Summed test time from the JSON reports of 7
green queue runs (2026-09-23): 14.3 / 16.3 / 20.8 min. The webServer boot
costs the same on every shard (about 4.5 min), so it is not the cause.

**The change.** `apps/e2e/reporters/balanced-shard-reporter.ts` uses
Playwright's own `Reporter.preprocess` + `testRun.skipSharding()` hook. It
weighs each spec file, per project, from `shard-timings.json` (medians of those
7 runs), then gives the heaviest file to the lightest shard, and so on down.
Estimated test time, with the same weights: before 14.7 / 16.5 / 20.5 min,
after 17.4 / 16.8 / 17.4. Files are never split. New specs are weighed at their
project's per-test rate, so the balance holds as the suite grows. `--shard=i/3`
is still passed and recorded. The fan-in now also fails if any test ran in two
shards. Shard count, timeouts, retries and the required set are unchanged.

**Prediction.** The slowest shard loses about 3 min of test time. Its step
should go to about 22 min at p50 and 23.5-24.5 at p95, so the headline ratio
drops from 0.92 to about 0.80. The metric above is the closest one the
collector computes (pooled job p90). The target is 26 min; 27.5 would be
halfway. Getting every shard under 0.75 at p95 is NOT expected from this
change: a perfect split still leaves the mean shard's step at about 21.8 min
p50. Reaching 0.75 needs the fixed boot cut or more shards.

**Why this comes before 260919-175503 (six shards).** That one doubles the
runner bill and pays the ~4.5 min fixed boot three more times. A count-based
six-way cut would also stack the test-mode projects onto the last shard or
two, the same skew as today. Balance first, so that experiment measures shard
count and nothing else. The two must not run in the same window on this gate.

**Metric fix to propose (not done here).** `headroom` should read the
innermost deadline for each matrix leg, not the outer job timeout pooled
across legs. For this gate that means the suite step against `globalTimeout`
(or, at least, the step's own 35-min `timeout-minutes`). A per-leg
`step_over_deadline` metric in `ci/metrics.yaml` would let this entry name
0.92 directly.

**Confounders.** Two active entries touch this gate in the before-window:
`260921-040000` (hygiene, measurement only) and `260920-184120` (the canary,
which the `@merge_group` qualifier excludes).

**The reorder surfaced an order-dependent spec, as any rebalance can.** The
first queue run (35847511684) failed one test out of 454. The `/` 768px case in
`responsive/no-horizontal-scroll.spec.ts` measures Home's bar, and the bar
carries #team's head count. #team holds every agent that earlier specs on the
same server created. The new order ran the case after 37 of them, and the bar
spilled 12px against a 5px allowance (DOR-1816 F1). The spec now pins the
roster it reads to the fresh-install two members, using the same route rewrite
as `room-follow.spec.ts`. That makes the result the same whatever ran first. It
does not fix the bar, which is tracked separately. Shard times on that run:
17.4 / 22.5 / 23.8 min (shard 3 includes the failing test's retry).

**Revert if** any test runs twice or never (the fan-in names it), or if the
slowest shard's step p95 does not drop by at least 1.5 min over 14 days.
