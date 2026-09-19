---
id: 260919-175512
title: 'A zero-cost second-opinion reviewer, only if escape data calls for it'
kind: experiment
status: proposed
actor: agent
gates:
  - wf.claude-code-review.review
prs: []
hypothesis:
  metric: 'tracked.escaped'
  baseline: null
  baseline_source: 'plan §5.1: of 12 traced escapes the review saw the defective code in 10 and flagged 1; escaped is not yet collected'
  target: 1
  after_days: 28
ratchet-release: []
field-changes: []
---

Seeded proposal 13 of 14 from plans/ci-steward-plan.md §6.

Run only if the blocking gate's escape data shows a class a different model family would catch (CodeRabbit or PR-Agent on a free tier). Withdraw if no such class appears in the first month of escape data.
