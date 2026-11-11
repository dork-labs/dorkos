---
id: 261111-184639
title: 'An own-module mock ratchet in the typecheck job: no package may add vi.mock calls on our own code'
kind: experiment
status: proposed
actor: agent
gates: [wf.typecheck.typecheck]
prs: []
hypothesis:
  metric: 'gate.wf.typecheck.typecheck.duration_p90'
  baseline: 9.4
  baseline_source: 'gh run list --workflow typecheck.yml --status success, the 60 newest runs to 2026-11-11 (pull_request n=48 p90 9.42 min, merge_group n=11 p90 9.22 min)'
  target: 9.6
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4190, cleanup phase 4. A test that `vi.mock`s a module we own tests the fake, not the code: it passes when the real module breaks and breaks when the real module is refactored. On 2026-11-11 there were 4,381 such calls in test files, 1,520 of them in `apps/client` (where 257 files fake the whole `@/layers/shared/model` barrel) and 2,612 in `apps/server`. The plan asks for a lint rule against it. An ESLint `error` would red every one of those files at once and a `warn` fails nothing, so this is a ratchet, built like the file-size one (ledger `261010-125652`).

`scripts/check-own-mocks.ts` counts, per package, the `vi.mock`/`vi.doMock` calls whose first argument names our own code (a relative path, the `@/` alias, `@dorkos/*`, `@dork-labs/*`). Third-party modules are edges and never count; comment lines are skipped. `scripts/own-mocks/baseline.json` holds each package's count: it may only fall, a drop must be locked in with `--update`, and with `--base` the baseline may not be raised or added to by hand. The unit is the package, not the file, so two PRs in one package rarely conflict on the baseline. It rides the `typecheck` job (already required, unfiltered, reports on `merge_group`) and pre-push, so no new required check.

The real hypothesis is about the tests, and the collector cannot compute it, so the script is its measure: the total goes from 4,381 down each week and no package grows. Read it with `jq '[.packages[]] | add' scripts/own-mocks/baseline.json` on `main`. The scored metric is the price: the step reads text only and takes under a second, so the job's p90 should stay at or under 9.6 min.

Revert or rework if the p90 passes 9.6 min because of this step, if `baseline.json` conflicts between concurrent PRs become a regular cause of DIRTY PRs, or if people work around it (a mock spelled through a variable, or a hand-rolled fake module) instead of using the real module.
