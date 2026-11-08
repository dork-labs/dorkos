---
id: 261107-203000
title: Run the browser smoke subset before PRs enter the merge queue
kind: experiment
status: proposed
actor: agent
gates: [wf.browser-test.browser-smoke, wf.browser-test.browser-test]
prs: []
hypothesis:
  metric: gate.wf.browser-test.browser-test.ejections_caused
  baseline: 28
  baseline_source: 'ci-steward-data@22bd478ba6260a77e1a312e5f9883628f9d43377 snapshots/2026-10-31.json through 2026-11-06.json: browser-test ejections_caused = 4+15+3+0+5+1+0. latest.json reports collector-health failures from stale local-hook exports; these are the recorded queue counts, not an assertion that the collector is healthy.'
  target: 14
  after_days: 14
ratchet-release: []
field-changes: []
---

PM CI-health task #50: expose browser regressions on the PR before they eject a merge-queue build. Four PR-only shards run the existing Playwright `@smoke` subset, with the marketing-site leg off and the production leg on. The required `browser-test` fan-in requires their aggregate success on PRs, including refusing skipped or cancelled smoke. Queue builds and main canaries still require the full six shards, the first-run journey and the full execution proof.

The smoke command keeps the existing one CI retry, fails after five test failures, and gives Playwright 25 minutes to flush reports before its 28-minute step and 35-minute job backstops. Each shard must report at least one successful test; an empty or all-skipped selection cannot pass. Every PR smoke failure blocks, without consulting the quarantine lane. Traces and JSON reports are retained for seven days.

This adds four hosted jobs per PR push. It does not make a passing smoke subset a substitute for the combined-tree suite. The target is a 50% reduction in the recorded seven-day browser-test ejection count after 14 days; flakes and non-smoke regressions can still eject builds, so examine those separately alongside the flake census. Re-plan if smoke jobs regularly reach the inner deadline or PR feedback p90 worsens without fewer browser ejections. Do not loosen the queue gate to compensate.

Sizing: a collection-only run on base `86fd030cedafa7ef57cb5d153cd6ab3db604b84b`, with `E2E_SITE=0 E2E_PROD=1` and `--grep @smoke`, found 73 spec units. The existing measured-duration partition estimates 23.2 minutes of tests per shard at two shards, versus 11.6 minutes at four. Four preserves every tagged project while bringing the estimate, plus the existing approximately five-minute boot allowance, below the 25-minute inner deadline. This is a sizing estimate, not a measured hosted smoke duration; CI on this PR supplies that measurement.
