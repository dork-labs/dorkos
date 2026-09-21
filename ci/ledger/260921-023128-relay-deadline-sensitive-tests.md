---
id: 260921-023128
title: 'Two relay tests are deadline-sensitive under in-run contention'
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: []
ratchet-release: []
field-changes: []
---

## What was measured

`packages/relay/src/__tests__/access-control.test.ts` ("really does see a rules
file appear, change and vanish under a real watcher") and
`packages/relay/src/__tests__/relay-gc.test.ts` ("a re-drive racing a slow
in-flight handler never flips a delivered message to failed") went red in **3 of
8** full-suite runs at `maxWorkers=4`, and in **0 of 9** runs at 14 or 8 workers,
on 2026-09-20 at load 360-470.

Run on their own, each file passes **12/12** at both worker settings.

So this is not "these tests are flaky" in general and it is not machine load on
its own. It is contention **inside** one run: at 4 workers each worker carries
about 19 files instead of 5, its event loop stays busy for longer between test
files, and a real filesystem-watcher callback misses the wall-clock deadline the
test gives it. The worker cap (`260921-022119`) made an existing fragility
reachable; it did not create it, and a busier machine or a slower laptop would
reach it the same way.

## The fix direction

Make both deterministic rather than tolerant:

- **Await the event, do not wait out a clock.** The watcher case should resolve
  on the callback it is testing for, with the test's own timeout as the only
  deadline, instead of sleeping a fixed span and asserting afterwards.
- **Inject the clock** where the assertion is genuinely about elapsed time, so
  the test controls it rather than racing it.
- Do **not** raise the worker cap until they stop complaining, and do **not**
  reach for `VITEST_RETRY` here: local runs keep `retry: 0` on purpose so flake
  stays loud, and a retry would hide exactly the signal that found this.

`packages/relay/vitest.config.ts` already carries the history: both files were
reworked once before (DOR-1777, DOR-2012) to stop needing `VITEST_RETRY`, and
`access-control`'s watch was moved onto chokidar's polling backend for the same
class of reason. This is the next round of the same problem, now with a measured
trigger.

## If they start costing merges

They have **no recorded CI flake** — that is why this is `hygiene` and carries no
hypothesis. There is no catalogue metric for "a local suite run is trustworthy",
and naming a CI metric these two have never moved would be a guess dressed as a
baseline.

If that changes, they are candidates for the quarantine lane: `pnpm ci:flaky`
names tests that failed and then passed on the same merge-group tree, and
`pnpm ci:quarantine add` takes one out of the blocking path for 7 days while it
still runs and still reports. The lane refuses a test with no flaky evidence, so
it cannot be used pre-emptively from here — the evidence has to arrive first, and
`flaky-test-runs` (objective ≤ 1.5%, not yet measured) is the SLO that would show
it.

## Why this entry exists at all

So that "we now know these two are deadline-sensitive, and here is the exact
condition that reveals it" cannot evaporate. It is referenced from
`260921-022119`'s revert condition: a third file going red under the cap is the
signal to revert the cap, and whoever hits it should find this rather than
rediscover it.
