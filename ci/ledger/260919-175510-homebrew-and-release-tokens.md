---
id: 260919-175510
title: 'Homebrew tap token, and a release-publishing token that triggers the cask'
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.update-homebrew.update-formula
prs: []
hypothesis:
  metric: 'gate.wf.update-homebrew.update-formula.failure_rate'
  baseline: 1.0
  baseline_source: 'phase-0 timing sample (gh api, 2026-08-22..09-14): 10 of 10 update-formula runs failed; research 01 §6.2: HOMEBREW_TAP_TOKEN is not set'
  target: 0
  after_days: 28
ratchet-release: []
field-changes: []
---

Seeded proposal 11 of 14 from plans/ci-steward-plan.md §6.

Every release since the workflow existed failed to update Homebrew, and the release: published path cannot fire because GITHUB_TOKEN publishes the release. Needs an operator-created token. Revert if the token grants more than the tap needs.
