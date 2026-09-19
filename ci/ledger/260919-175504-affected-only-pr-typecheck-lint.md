---
id: 260919-175504
title: 'Affected-only PR typecheck and lint, and a single prettier check'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
  - wf.lint.lint
prs: []
hypothesis:
  metric: 'pr-feedback'
  baseline: 14.3
  baseline_source: 'plan §3 today column (research 02): pr-feedback p50 14.3 min over the 7 days to 2026-09-19'
  target: 10
  after_days: 14
ratchet-release: []
field-changes: []
---

Seeded proposal 5 of 14 from plans/ci-steward-plan.md §6.

The PR legs of `typecheck` and `lint` run the full monorepo although the queue re-runs them in full on the combined tree, which is where cross-PR interactions are caught. The verdict reads pr-feedback p50, since the queue legs stay full by design. Revert if a type or lint error reaches the queue that the PR leg would have caught.
