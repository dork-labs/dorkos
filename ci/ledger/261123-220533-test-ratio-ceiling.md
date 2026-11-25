---
id: 261123-220533
title: A per-package test budget, and pass-count floors that never charge for a deliberate deletion
kind: experiment
status: proposed
actor: agent
gates: [wf.typecheck.typecheck, lefthook.pre-push.test-ratio]
prs: []
hypothesis:
  metric: 'gate.wf.typecheck.typecheck.duration_p90@merge_group'
  baseline: 10.67
  baseline_source: 'typecheck jobs of the 10 newest green merge_group typecheck.yml runs to 2026-11-23 (45270942711 … 45260770150), n=10, p50 9.63 min, p90 10.67 min'
  target: 10.8
  after_days: 14
ratchet-release: []
field-changes: []
---

On 2026-11-23 the repo held about 1.68M non-blank lines of test against 1.60M of source (1.05 to 1), with `apps/server` at 1.31 and `apps/space` at 4.56. Agents write tests faster than anyone reads them, and nothing pushed the other way: the pass-count floors in `ci/ratchets.yaml` only stop a count falling, and the quarantine lane is the one place that ever says "delete".

Two changes. First, `scripts/test-ratio/check-test-ratio.ts` holds each package with at least 1,000 lines of source to a test budget in `scripts/test-ratio/baseline.json`: a count of test lines and a ratio of test lines per source line. A package fails only past both, that is, when it adds tests faster than source, so deleting dead code never fails and a source-only PR never touches the baseline. Each budget is set 300 lines of test above today, so ordinary PRs rarely cross it. Budgets only tighten (`--update`, never below 0.5; `--package` lowers one so prune PRs do not collide), a package new to the file starts at 1.0, and the test tiers `apps/e2e` and `apps/space` are not measured because their specs test other packages. As with the own-mocks ratchet (ledger `261111-184639`), the gate is a test, `scripts/__tests__/check-test-ratio.test.ts` › "the repo", listed in `REPO_WIDE_SUITES` (`scripts/vitest.repo.config.ts`), so the required `typecheck` job runs it on every PR and queue build; pre-push runs the script with `--base` at the branch point, which also refuses a budget loosened or removed by hand. No workflow is edited. Second, the `vitest-passed` and `playwright-passed` descriptions now say a deliberate deletion lowers the mark with no release, so when `ratchet-assert` is built (phase 2) it catches tests that silently stopped running and never charges for pruning. `quarantine.test.ts` pins that sentence the way it pins the quarantine one.

The real hypothesis is about the tests, and the collector cannot compute it, so the script is its measure: `pnpm check:test-ratio -- --report` shows the repo line falling each week as the `pruning-tests` skill runs from @dorkos-qa's heartbeat, and no package rising. The scored metric is the price: the test reads text only, about 4 s, so the `typecheck` job's p90 should stay at or under 10.8 min.

Revert or rework if `baseline.json` conflicts become a regular cause of DIRTY PRs, if the budget pushes people to cram assertions into fewer, larger tests instead of deleting weak ones, or if prune PRs start deleting regression tests that later turn out to have been the only guard.
