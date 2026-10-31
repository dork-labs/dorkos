---
id: 261031-121500
title: "Headroom reads the browser shards against when Playwright's deadline really ends the job"
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-shard
prs: []
hypothesis:
  metric: 'headroom'
  slo: 'headroom'
  baseline: 0.948
  baseline_source: "CI Steward trigger headroom:wf.browser-test.browser-shard on 2026-10-31: p95 job duration 23.70 min over Playwright's 25-minute globalTimeout, n=1422 queue shard jobs, snapshots 2026-10-24..30 on ci-steward-data. Recomputed by hand from the same snapshots: 0.948."
  target: 0.9
  after_days: 7
ratchet-release: []
field-changes: []
---

Hygiene: this changes the ruler, not the pipeline. No job runs differently and no limit moves.
Playwright's `globalTimeout` is still 25 minutes, the suite step still 35 and the job still 45.

**The red.** `headroom:wf.browser-test.browser-shard` read p95 94.8% of the time limit (n=1422),
above the 0.9 floor. The ratio divides the whole job's duration by Playwright's 25 minutes. But
Playwright's clock starts at `Run the browser suite`, after checkout, install, the browser and the
build. In this job that deadline ends the run at about `setup + 25` minutes, not at 25.

**Measured, 2026-10-24..31.** 312 queue runs, 1,788 browser-shard jobs, read from the Actions jobs
API with step timings:

| Part of a green shard job (n=1,474)  | p50  | p95  | min  |
| ------------------------------------ | ---- | ---- | ---- |
| Steps before `Run the browser suite` | 3.55 | 4.02 | 2.52 |
| `Run the browser suite`              | 17.8 | 19.5 | 10   |
| Whole job                            | 21.6 | 23.7 |      |

- The suite step, which is what Playwright's deadline bounds, runs p95 19.4-19.8 minutes on every
  shard: 78% of 25. Of 1,788 shard jobs the deadline stopped at most one (run 40442057994, shard 4,
  25.05 minutes, already four tests red). Two shard failures that looked like timeouts were the
  site webServer leg's 242-second readiness timeout, not `globalTimeout`.
- **The shards are balanced.** The balanced-shard reporter estimates 14.0 test-minutes for each,
  and `shard-timings.json` (77.6 test-minutes for the known units) matches today's reports (76-77).
  The spread between shards (11.5 to 19.3 minutes in one run) is the runner: suite-step times are
  bimodal, about 12-14 and about 18 minutes, with boot slower by the same factor (first test at
  2.2-2.4 against 3.4-3.7 minutes). About 62% of shard jobs land on the slow kind, steady every day
  of the window. Rebalancing cannot fix that.
- **#3341 did not move browser time.** Suite step p50 17.8 before it merged (10-31 07:02Z), 18.1
  after.
- **The failure spike is not time.** The 12.6% shard failure rate is queue builds catching broken
  PRs. Of 242 failed shard jobs, 240 named failing specs (rooms/files, profile-pushin,
  control-center, conversation/peek and lane-no-shift, responsive/no-horizontal-scroll) and two
  were the site leg's readiness timeout, while the main canary stayed green. The 72 cancelled jobs
  are 12 queue builds cancelled together on the night of 10-30.

**What changed.** A `deadlines:` entry in `ci/config.yaml` takes `lead_minutes`, the job time
before the deadline's clock starts, and `deadlineMinutes` returns `lead_minutes + minutes`. The
browser shard's lead is 2.5, the shortest setup measured, so a shard with a slow install still
reads high, the safe side. 260925-193459 had accepted "about 2.5 minutes of setup, about 0.08
high". The setup is now 3.5 minutes at p50 and read 0.15 high, enough to breach the floor alone.

**Expected reading.** The same 1,422 jobs over 27.5 minutes: **0.862**, under the 0.9 floor and
still above the 0.6 objective. That gap is real. A healthy shard on a slow runner uses about 78%
of Playwright's deadline, and the 1.75x margin `playwright.config.ts` derives has worn to about
1.35x as the suite grew from 52.7 to about 77 test-minutes since 2026-09-27.

**Rollout.** Snapshots record each day's effective timeout when collected, folded with the
deadline (`collect.ts`), and the readers take the smaller of that and the deadline. Days collected
before this merges keep 25, so the reading falls as the 7-day window rolls past them: the trigger
clears on the first window made of new days only, about 7 days after merge.

**Verdict.** After 7 days, `headroom` for this gate reads at or under 0.9 with the suite step's
p95 still under 21 minutes. If it reads under 0.9 only because the suite got faster, the ruler
was not the cause; say so in the verdict.

**Revert if** a green-bound shard is stopped by `globalTimeout` while this reads under 0.9: the
ruler would then be hiding a real limit. Revert by removing `lead_minutes` from the config entry;
the field defaults to 0, which is the old ruler.

**Not done, on purpose.**

- `UNSHARDED_SUITE_MINUTES` (58) in `playwright.config.ts` is stale. Re-measured it would derive a
  30-minute `globalTimeout`, which raises the limit, so it waits for the next shard-count change,
  when its own comment asks for a re-measure.
- A seventh shard would bring a slow-runner shard to about 16 minutes, at the cost of one more
  runner and its ~3.5 setup minutes per queue build. Choose it when the suite step's p95 passes
  21 minutes, or when the deadline stops a green-bound shard.
