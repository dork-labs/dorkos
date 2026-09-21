---
id: 260921-040000
title: Record the browser global-setup boundary
kind: hygiene
status: active
actor: agent
gates:
  - wf.browser-test.browser-shard
prs: []
ratchet-release: []
field-changes: []
---

DOR-2189 follows queue run 35526950995: 5m33 before the first test plus
24m17 of completed tests exhausted the 30-minute global deadline. The unchanged
requeue 35528785038 passed in 25m19 with all 150 tests. The preceding passing
run 35526613869 took 18m23. The census has grown from the workflow's historical
328 tests to 452, and equal test counts did not give equal test durations.

The smallest supported change is measurement. Global setup records its start,
finish, elapsed milliseconds and outcome in the existing Playwright JSON report's
`config.metadata.globalSetupTiming`. The report already carries suite start,
duration, first-test timestamps, test counts, project/spec identity and individual
durations. Together they distinguish the runner/server startup phase from the
onboarding and client warm-up phase, without adding a reporter or artifact upload.
An interrupted setup remains `running`; absent metadata means setup was not
observed, never a zero-second startup.

This is observability hygiene. No deadline, retries, shards, coverage, gate
verdict or required status changes. The six-shard experiment
`260919-175503` stays proposed: one timeout followed by an unchanged pass does
not establish that a budget change is needed. The 2026-09-19 CI Steward snapshot
(collected 2026-09-20, healthy) names queue-green as the constraint (0.7481).

Verify using real isolated Playwright runs with a throwaway server and no browser
or inference. Both a passing setup and an intentional setup failure must preserve
metadata in the JSON report, retain the original verdict and error, and order
timestamps correctly. Collect queue reports after merge before selecting a
startup or shard-distribution intervention. Revert if timing changes suite
behavior or prevents the existing reporter from flushing.
