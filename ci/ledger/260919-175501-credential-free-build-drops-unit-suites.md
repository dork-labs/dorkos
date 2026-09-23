---
id: 260919-175501
title: 'credential-free-build stops re-running the unit suites, keeping build, typecheck and boot'
kind: experiment
status: active
actor: agent
gates:
  - wf.credential-free-build.credential-free-build
prs: []
hypothesis:
  metric: 'gate.wf.credential-free-build.credential-free-build.failure_rate@merge_group'
  slo: 'wasted-queue-builds'
  baseline: 0.059
  baseline_source: 'GitHub Actions API, credential-free-build.yml merge_group runs created 2026-09-16T00:00Z to 2026-09-23T02:00Z, measured 2026-09-23: 13 failed of 219 finished non-cancelled runs (7 more cancelled). 11 of the 13 failed in the "Test everything this change can reach" step; the other 2 (35039034938, 35042360363, 09-16) died mid-build before the concurrency fix.'
  target: 0.015
  after_days: 7
ratchet-release: []
field-changes: []
---

Seeded proposal 2 of 14 from plans/ci-steward-plan.md §6.

## What changed

`credential-free-build` no longer runs `turbo test --affected`. It still runs
the install, `turbo build typecheck lint --affected`, the CLI build and the
server boot probe, all under `scripts/run-credential-free.sh`.

## Why

The unit suites already run in `test-shard` (4 shards). In the queue those
shards retry a failed test once, name it, and apply the quarantine lane. The
copy here had none of that, so a flake the shards absorbed still ejected the
batch from here. Across the 13 failures above:

- `sessions-ui-action.test.ts > accepts a click that lands after the turn
ended…` failed 5 queue builds (09-19 13:14, 09-20 01:58, 09-23 00:35, 00:51,
  01:59), each a different PR. It was the only cause in 3 of them.
- 4 server `sessions-*` detached-turn tests failed together in 3 builds
  (09-16, 09-17).

The scrub does not change a unit test's result on CI: `test.yml` sets no
hosted variable and reads no secret, and turbo's strict env mode strips the
rest. `scripts/__tests__/credential-free-workflow.test.ts` now fails if
`test.yml` starts setting a variable from the scrub's list or reading a
secret, so that stays true.

## Secondary number (reported, not scored)

`duration_p90@merge_group` over the same window: 55.3 min (p50 4.8). The test
step alone was p90 45.2. The same 206 green runs with the test step taken out:
p50 2.9, p90 9.9, worst 11.2. Expect the job's p90 near 10 min.

## Reading the verdict

`queue-green` will rise this week anyway: three big flake sources were fixed
just before this (#1974, #1944, #1934). Do not read this experiment's result
off `queue-green`. The scored metric is this job's own failure rate in the
queue. Those fixes can lower it a little too, since some of the tests they
fixed also ran here, but 11 of this job's 13 failures were in the step this
change removes, whichever test tripped it.

The target allows about 3 real failures a week (build, typecheck, lint or the
boot probe). A failure here should now mean one of those, never a unit test.

## Revert if

A unit test that fails only with a hosted variable removed reaches `main`, or
`test.yml` has to start reading a hosted secret. Either one puts the unit
suites back under the scrub.
