---
id: 260919-175513
title: 'Visual and runtime checks for the escapes a diff review cannot see'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.browser-test.browser-shard
  - wf.desktop-smoke.packaged-runtime
prs: []
hypothesis:
  metric: 'tracked.escaped'
  baseline: null
  baseline_source: 'plan §5.1: most traced escapes were layout, CSS, Electron timing or wrong assumptions about outside tools (for example #1893, lost font weight on every assistant message); escaped is not yet collected'
  target: 1
  after_days: 28
ratchet-release: []
field-changes: []
---

Seeded proposal 14 of 14 from plans/ci-steward-plan.md §6.

These escapes are a testing gap, not a reviewer gap: no diff reviewer catches them well. Add screenshot and runtime assertions for the classes seen. Revert a check whose false-red rate exceeds its catches.
