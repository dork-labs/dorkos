---
id: 261111-184639
title: 'An own-module mock ratchet: no package may add vi.mock calls on our own code'
kind: experiment
status: proposed
actor: agent
gates: [wf.test.test-shard, lefthook.pre-push.own-mocks]
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p90@merge_group'
  baseline: 27.5
  baseline_source: 'test-shard jobs of the 10 newest green merge_group test.yml runs to 2026-11-11 (43077555259 … 42956099117), n=70, p50 21.65 min, p90 27.52 min'
  target: 27.6
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4190, cleanup phase 4. A test that `vi.mock`s a module we own tests the fake, not the code: it passes when the real module breaks and breaks when the real module is refactored. On 2026-11-11 there were 4,381 such calls in test files, 1,520 of them in `apps/client` (where 257 files fake the whole `@/layers/shared/model` barrel) and 2,612 in `apps/server`. The plan asks for a lint rule against it. An ESLint `error` would red every one of those files at once and a `warn` fails nothing, so this is a ratchet, built like the file-size one (ledger `261010-125652`).

`scripts/check-own-mocks.ts` counts, per package, the `vi.mock`/`vi.doMock` calls whose first argument names our own code (a relative path, the `@/` alias, `@dorkos/*`, `@dork-labs/*`). Third-party modules are edges and never count; comment lines are skipped. `scripts/own-mocks/baseline.json` holds each package's count: it may only fall, and a drop must be locked in with `--update`. The unit is the package, not the file, so two PRs in one package rarely conflict on the baseline.

No workflow is edited (workflows are frozen until DOR-4030). The gate is a test, `scripts/__tests__/check-own-mocks.test.ts` › "the repo", which runs in the `test` job's sweep on every queue build. Pre-push runs the script with `--base` at the branch point, which also refuses a baseline raised by hand; in CI that half is review's job until a workflow step can carry `--base`.

The real hypothesis is about the tests, and the collector cannot compute it, so the script is its measure: the total goes from 4,381 down each week and no package grows. Read it with `jq '[.packages[]] | add' scripts/own-mocks/baseline.json` on `main`. The scored metric is the price: the test reads text only and takes about 1.5 s, so the queue shards' p90 should stay at or under 27.6 min.

Revert or rework if `baseline.json` conflicts between concurrent PRs become a regular cause of DIRTY PRs, if the test's time shows in the shard p90, or if people work around it (a mock spelled through a variable, or a hand-rolled fake module) instead of using the real module.
