---
id: 260919-175508
title: 'The six CI-only checks join pnpm verify'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
  - wf.lint.lint
prs: []
hypothesis:
  metric: 'gate.wf.typecheck.typecheck.failure_rate'
  baseline: null
  baseline_source: 'research/20260919_ci-pipeline-01-inventory.md §4: format:check, banned-words, vocab-gate, boundary, NUL-bytes and dead-doc-paths never run locally; the PR-leg failure rate they cause is not yet measured'
  target: 0.03
  after_days: 14
ratchet-release: []
field-changes: []
---

Seeded proposal 9 of 14 from plans/ci-steward-plan.md §6.

A green pnpm verify does not mean a green typecheck or lint context today. Running the same six checks locally moves those reds before the push. Revert if verify time grows past its budget.
