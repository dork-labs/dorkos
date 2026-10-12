---
id: 261011-050222
title: 'The typecheck step gets an 8 GB Node heap, so the server tsc stops running out of memory'
kind: incident-fix
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
hypothesis:
  metric: 'gate.wf.typecheck.typecheck.failure_rate'
  baseline: 0.077
  baseline_source: 'gh run list, typecheck workflow, 2026-10-10T00:59Z to 2026-10-11T04:53Z, 15 failures in 194 finished runs (all causes)'
  target: 0.06
  after_days: 14
ratchet-release: []
field-changes: []
---

`tsc --noEmit` for `apps/server` uses about 4.4 GB (measured locally with `--extendedDiagnostics`: 4.35 to 4.53 GB on two branches of 2026-10-11 `main`). Node's default heap on the 16 GB runner is about 4 GB, so the step had no headroom: DOR-2797's PR #2741, which adds about 4% more types, failed `typecheck` twice in a row with `JavaScript heap out of memory`, while a sibling PR on the same base passed.

The step now runs with `NODE_OPTIONS=--max-old-space-size=8192`, the ceiling `test.yml` already gives its test job. The same line is in open PR #2673; this lands it alone so other PRs stop failing on it.

Why this metric: the fix removes a failure that only some PRs hit, so the honest measure is the step's failure rate, which should fall by at least the out-of-memory share. Revert if the job's duration p90 rises by more than 30 s (it should not: the heap ceiling only moves when the GC gives up).
