---
id: 260919-175500
title: 'Quarantine lane: a test data has classified flaky runs and reports, but cannot eject a queue build'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-shard
  - wf.browser-test.browser-test
  - wf.test.test-shard
  - wf.test.test
prs: []
hypothesis:
  metric: 'queue-green'
  slo: 'queue-green'
  baseline: 0.7481
  baseline_source: 'origin/ci-steward-data:latest.json, queue-green over the 7 days to 2026-09-19 (n=135, min_n=30)'
  target: 0.8
  after_days: 14
ratchet-release: []
field-changes: []
---

## What changed

A test the collector has classified flaky **from data** can be put on a list on the `ci-steward-data` branch, and from the next queue build its failures no longer fail the blocking job. It still runs, still retries, and is still reported — nothing is skipped, excluded or grep-filtered — so the day it stops flaking is visible in the same reports.

`ci-steward flaky` does the classifying. An occurrence is one merge-group SHA on which the test failed and then passed; two distinct SHAs in 14 days qualify, and a test that has been quiet for longer than its own average gap between flakes is `cooling` and is refused, because that is the shape of a test somebody fixed.

## Why `queue-green`

`queue-green` is 0.7481 against a 0.97 objective and is the constraint. Last week the browser suite was among the failing checks on 11 of 23 ejections and only 3 of those were real. `flaky-test-runs` reads 0.005, so the flakiness is concentrated rather than general — which is exactly the shape a per-test lane can address and a retry budget cannot.

A gate-level metric would be narrower, and `gate.wf.browser-test.browser-test.failure_rate` was this entry's first proposal. It was replaced because the lane's effect does not land on one gate: the same mechanism rides both `browser-test` and `test`, and what a person feels is the queue build that did not have to be thrown away. `queue-green`'s n is about 135 a week, well over its minimum of 30.

## The clock has not started

**This entry stays `proposed` until the lane holds its first entry.** The mechanism merging changes nothing on its own: `quarantine.json` does not exist yet, and a lane with nothing in it absorbs nothing, so a 14-day window opened at merge would measure the weather. The `after_days` clock starts the day the first entry is published, and this entry goes `active` in the same change that records it, naming the PR.

## The target, and what it assumes

0.80 recovers roughly a fifth of the distance from 0.7481 to the objective, and it assumes **three to five entries** covering the browser tests that actually eject builds. One entry cannot do it: the seed candidate flaked on 2 of 28 sampled builds and its failures are already absorbed by Playwright's single retry, so on its own it is worth a fraction of a point.

If the lane is still at one entry when the after-window closes, the honest reading is that the hypothesis was never tested: re-baseline and run it again with the entries it assumed, rather than scoring the mechanism on an empty lane. That is a judgement for whoever reads the verdict, not something the verdict engine can know.

The number this could make worse is the one the interlocks exist for: a real break reaching `main`. `main-green` is reported beside the verdict, and a rise in red episodes on `main` during the window is a revert, whatever `queue-green` does.

## What would make us revert

- A quarantined test turns out to have been hiding a real regression (read `main-green` and `tracked.escaped`).
- The lane is full, or the same test is re-quarantined after an expiry, which means it is being used to store broken tests rather than to buy time for a fix.
- `queue-green` does not move and the entries are all still there at 14 days: the flakiness is somewhere the lane cannot reach, and the next experiment should be a different lever.

## Interlocks, stated as they are implemented

- A failure the list does not name fails exactly as before.
- The gate reads three numbers out of the same reports — the runner's failed-test tally, its own per-test walk, and the failures attributed to no test (a file that throws on import fails to collect and never becomes a failed test) — refuses the first two when they disagree, refuses the third outright, and excuses a non-zero exit only when the tally is exactly the set the lane absorbed.
- **Open hole, named:** a package whose process dies before writing any report is in none of those numbers and is excused when a quarantined test failed in the same run. Nothing downstream catches it — `assert-tests-executed.sh` counts turbo tasks, and the union check unions what other shards collected. Closing it needs the turbo summary's per-task exit codes read in the gate.
- The whole lane is printed in the job summary of every queue build that read it, and the fan-in refuses an incomplete set of shard copies rather than intersecting over whatever arrived.
- `assert-browser-tests-executed.sh` fails when a quarantined browser test did not run, missing or collected-then-skipped. `assert-shard-union.sh` fails when a quarantined vitest test's FILE contributed nothing to any shard. **The vitest half is file-level, not per-test**, because the fan-in reads no per-test vitest reports.
- `quarantine-size` and `quarantine-days` are the lane's own ceilings, and the pass-count ratchets **must** exclude quarantined tests on both sides when `ratchet-assert` is built (phase 2). That is a requirement this change records, not something it implements; `ci/ratchets.yaml` carries it and a test fails if the sentence is removed.
- Entering quarantine writes a `proposed` "fix or delete this test" ledger entry, and the daily triage flags a full lane or an entry near expiry.
- A list that is missing, unreadable, invalid, over the cap, expired, or holding an entry with a longer life than `max_expiry_days` is ignored entirely, and then every test blocks as normal.
