---
id: 261119-002145
title: pnpm verify:preopen, a lighter local check before a PR opens
kind: experiment
status: proposed
actor: agent
gates: []
prs: []
hypothesis:
  metric: tracked.first-run-green-share
  baseline: 0.757
  baseline_source: 'ci-steward count for DOR-4728: 103 of 136 PRs whose first run falls 2026-11-15T19:00Z to 2026-11-18T14:50Z had typecheck, test and browser-test all green on their first pull_request run. Reference window 2026-11-12T20:00Z to 2026-11-15T19:00Z: 116 of 151 = 0.768.'
  target: 0.75
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4728. The full `pnpm verify` runs the scripts suite, `eslint .`, the affected
typecheck and lint, and the affected package tests. On a busy Mac the test sweep is
the slow part, and CI's six test shards run the same tests at the exact head anyway.

The change: `pnpm verify:preopen` runs the affected typecheck and lint under the same
lock, base pin and heap; the scripts suite only when the change can reach it (the
scope in `scripts/scripts-test-scope.sh`, plus `.agents/`, `.claude/`, `.github/` and
the root `package.json`); and ESLint on the changed files in place of `eslint .`. It
never runs the package tests. Its proof is a separate file, `<sha>.preopen`, at level
`preopen`. `check <sha>`, which arming uses, reads only the full proof and refuses any
other level, so a preopen proof never arms. `pnpm verify` itself is unchanged.

Hypothesis: the lighter check does not cost first-run green. Metric: the share of PRs
whose first CI run has `typecheck`, `test` and `browser-test` all green. Unit: each PR
branch's first `pull_request`-event run of each of those three workflows, cancelled
runs excluded (if a branch's first run was cancelled, its next non-cancelled run
counts); a PR passes only if all three are green. Baseline 103/136 = 0.757.

Guardrail: `test.yml` runs with event `merge_group` in the same window,
failure / (failure + success), cancelled excluded: 10/188 = 5.3% at baseline.

Day 0 is when DOR-4728 and DOR-4729 (the CI scope pin) have both merged. Readout at
day 14 by ci-steward (owner since 2026-11-18). Revert DOR-4728 if the metric is below
0.75 at day 14 or the guardrail is above 5.3%.
