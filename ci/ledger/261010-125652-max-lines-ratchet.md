---
id: 261010-125652
title: 'A 500-line ratchet in the typecheck job: no file over the limit may grow'
kind: experiment
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
hypothesis:
  metric: 'gate.wf.typecheck.typecheck.duration_p90'
  baseline: 7.18
  baseline_source: 'ci-steward-data snapshots 2026-10-03 to 2026-10-09, typecheck pull_request + merge_group legs, n=679 (p50 6.18 min)'
  target: 7.8
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-2822. `max-lines` (500, blank lines and comments skipped) has been `warn` since it was written, and a warning fails nothing, so files kept growing. Measured with ESLint's own count and each package's own exemptions on 2026-10-10: 165 files over the limit (test files excluded, as the ticket asks), `apps/server/src/index.ts` at 4,324 counted lines. (The ticket's "about 395" counted raw lines and test files.)

`scripts/check-max-lines.ts` holds them to a baseline (`scripts/max-lines/baseline.json`): a baselined file may not grow, a new file may not pass 500, a file that shrinks must lower its entry (`--update`), and with `--base` the baseline itself may not be raised or added to by hand. It rides the `typecheck` job, which is already required, unfiltered and reports on `merge_group`, so no new required check.

The real hypothesis is about the code, and the collector cannot compute it, so the script is its measure: over-limit files go from 165 to fewer each week, and none grows. Read it with `jq '.files | length' scripts/max-lines/baseline.json` on `main`. The scored metric is the price: the step adds about 15 to 20 s locally, so the job's p90 should stay at or under 7.8 min.

Revert or rework if the p90 passes 7.8 min because of this step, if conflicts in `baseline.json` between concurrent PRs (each shrink edits it) become a regular cause of DIRTY PRs, or if people work around it (raising the baseline under a rename, or splitting files into meaningless pieces) instead of shrinking files.
