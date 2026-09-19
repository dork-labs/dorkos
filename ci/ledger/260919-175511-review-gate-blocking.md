---
id: 260919-175511
title: 'The automated review becomes a blocking review-gate (plan §5.3)'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.claude-code-review.review
prs: []
hypothesis:
  metric: 'tracked.review-findings-unfixed-share'
  baseline: 0.58
  baseline_source: 'plan §5.1 (research/20260919_ci-pipeline-supporting/07-claude-review-effectiveness.md): only 42% of real Important findings were fixed before merge'
  target: 0.1
  after_days: 28
ratchet-release: []
field-changes: []
---

Seeded proposal 12 of 14 from plans/ci-steward-plan.md §6.

The largest measured quality gain: the review finds real defects with about 92% precision, but 58% of its real Important findings merge unfixed because the check cannot block. Revert if review-completes falls under its floor for two windows.
