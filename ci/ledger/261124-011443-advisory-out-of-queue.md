---
id: 261124-011443
title: harness-windows and site-build run after merge instead of in the merge queue
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.harness-windows.harness-windows
  - wf.site-build.site-build
prs: []
ratchet-release: []
field-changes: []
---

DOR-5130, workstream 1 (docs/plan-ci-efficiency.md in ci-steward's folder). Both checks are advisory, so
their merge_group runs gated nothing, yet each queue entry spent a runner on them: 3,527 + 2,746
runner-minutes in the week of Nov 16-22, competing with the queue's required shards. They now run
on push to main with the same path filters as their PR legs, and after-merge-alert.yml tells the
author of a merge that breaks them. PR runs are unchanged.

Baseline: 6,273 queue runner-minutes a week on these two.
Target: 0 in the queue; push runs well under that (one run per merge that reaches their paths).
Evaluate: Dec 1.

Revert if either is promoted to required (it needs merge_group back), or if a break they used to
show in the queue goes unnoticed on main for more than a day.
