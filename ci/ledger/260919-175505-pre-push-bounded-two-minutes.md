---
id: 260919-175505
title: 'Pre-push bounded to about two minutes'
kind: experiment
status: proposed
actor: agent
gates:
  - lefthook.pre-push.tests
prs: []
hypothesis:
  metric: 'hook.pre-push.duration_p90'
  slo: 'local-push'
  baseline: 601
  baseline_source: 'research/20260919_ci-pipeline-02-timings.md: git push in agent sessions, 7d median 59 s, p90 601 s, 18% hit the 10-minute tool ceiling'
  target: 120
  after_days: 14
ratchet-release: []
field-changes: []
---

Seeded proposal 6 of 14 from plans/ci-steward-plan.md §6.

A killed push loses the agent a turn and pushes it toward --no-verify. Bound the local gate and leave the rest to CI, which runs it anyway. Revert if red PR test legs rise because of what pre-push stopped catching.
