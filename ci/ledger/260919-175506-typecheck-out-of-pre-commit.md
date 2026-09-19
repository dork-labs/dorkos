---
id: 260919-175506
title: 'Typecheck leaves pre-commit, staying at push and in CI'
kind: experiment
status: proposed
actor: agent
gates:
  - lefthook.pre-commit.typecheck
prs: []
hypothesis:
  metric: 'hook.pre-commit.duration_p90'
  slo: 'local-commit'
  baseline: 210
  baseline_source: 'plan §3 today column (research 02): git commit hook wall time about 3.5 min'
  target: 20
  after_days: 14
ratchet-release: []
field-changes: []
---

Seeded proposal 7 of 14 from plans/ci-steward-plan.md §6.

Typecheck runs up to seven times per change; the commit hook is the most expensive place for it, and CI always runs it in full. Revert if typecheck reds on PRs rise enough to cost more than the commit time saved.
