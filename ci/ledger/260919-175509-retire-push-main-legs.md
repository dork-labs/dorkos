---
id: 260919-175509
title: 'Retire push-to-main legs that re-test the queue tree'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.db-check.db-check
  - wf.cli-smoke-test.build-tarball
  - wf.desktop-smoke.packaged-runtime
  - wf.scripts-test.fixtures
prs: []
hypothesis:
  metric: 'main-green'
  baseline: null
  baseline_source: 'plan §3 today column: a few red main episodes per 28 days; research 01 §9: push-to-main runs db-check, CLI smoke (5 jobs), scripts-test and desktop smoke, none of which can gate a merge'
  target: 1
  after_days: 28
ratchet-release: []
field-changes: []
---

Seeded proposal 10 of 14 from plans/ci-steward-plan.md §6.

The queue already tested the exact tree content that lands on main (squash rewrites the SHA, not the content), so a push-to-main re-run can only report, never gate, and each red one is a main-green episode. Move what only push can see into the queue instead. Revert if a defect the push legs used to catch reaches a release.
