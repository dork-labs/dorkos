---
id: 261125-120637
title: The browser execution proof accepts specs another Playwright config collects (release-smoke)
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-test
prs: []
hypothesis:
  metric: tracked.merged-to-released
  baseline: null
  baseline_source: 'No commit since 1db24cf01 (Nov 24 23:06Z) has a green full browser run on main, so release-gate refuses every P; run 45600450037'
  target: 1440
  after_days: 7
ratchet-release: []
field-changes: []
---

#4366 added `apps/e2e/release-smoke/reply.spec.ts`, collected by its own `playwright.release-smoke.config.ts` and run by
Release Publish's smoke job. `scripts/assert-browser-tests-executed.sh` treats any `*.spec.ts` outside
`apps/e2e/tests` as stray, so every rolling browser-test run on main failed at "Prove the browser suite actually
executed" while all six shards and first-run passed. With no green full run, the daily release had no P to ship.

The assertion now excuses directories listed in `OTHER_COLLECTED_DIRS`, and only while that directory's own
`playwright.<dir>.config.ts` still declares it as `testDir`; otherwise the exception itself fails. Revert if a spec in
an excused directory stops being run by anything.
