---
id: 261126-090338
title: One registry and one pnpm ratchet step for every baseline that only falls
kind: experiment
status: proposed
actor: agent
gates: [wf.typecheck.typecheck, lefthook.pre-push.ratchets]
prs: []
hypothesis:
  metric: 'gate.wf.typecheck.typecheck.duration_p90@pull_request'
  baseline: 10.68
  baseline_source: 'ci-steward-data snapshots 2026-11-18 to 2026-11-24, wf.typecheck.typecheck@pull_request durations, n=741 (p50 9.35 min)'
  target: 10.9
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4948. Nine ratchets (a count in a committed baseline file that may only fall) each had their own wiring: six were separate steps of the required `typecheck` job, six were separate pre-push commands, own-mocks and test-ratio reached CI only as repo-wide tests (which compare the tree with the baseline but cannot see a baseline raised by hand), and knip ran nowhere. `scripts/ratchets/registry.ts` now lists all nine with the role that keeps each and the ticket that lowers it, and `pnpm ratchet` (`scripts/ratchets/ratchet.ts`) runs each one's own script, unchanged, at once, and prints a line per ratchet. Each baseline file stays separate. `scripts/__tests__/ratchets.test.ts` fails on a baseline under `scripts/` or `apps/server/eslint-rules/` that the registry does not list, or a listed file that is gone.

The change: in `typecheck`, the file-size, turn port, computer wall, import boundary, API lint and design-token steps become one `Ratchets (DOR-4948)` step with the same bases (`HEAD^1` on a PR and the canary, `merge_group.base_sha` plus `--queue` for api-lint in the queue). own-mocks and test-ratio gain `--base` in CI; knip joins as advisory (reported, never failing) until DOR-4629 decides. The step sits after the typecheck step, because knip reads the package output `turbo typecheck`'s `^build` leaves. At pre-push, the six ratchet commands become one `ratchets` command, `pnpm ratchet --pre-push`, on the branch point as before; design-tokens (its rule guard needs a PR label) and api-lint stay CI-only, as they were. The eight live ledger entries that named the old pre-push ids now name `lefthook.pre-push.ratchets`.

Measured 2026-11-26 on the operator Mac, three runs each: the full `pnpm ratchet` 15.5 to 16.5 s, bound by max-lines (about 18 s alone, 17 to 19 s in CI per ledger 261124-003748); knip about 6 s once the packages are built; `--pre-push` about 17 s, the same as the six commands lefthook ran in parallel. Each ratchet's output inside `pnpm ratchet` matched its standalone run line for line on a clean tree.

Hypothesis, as a guard: the six steps ran one after another (about 25 s); the one step runs them at once with own-mocks, test-ratio and knip added, so `typecheck`'s pull-request p90 should not move, and must stay at or under 10.9 min. `hook.pre-push.duration_p90` should not move either.

Revert or rework if the typecheck p90 passes 10.9 min, if a ratchet fails in the step but passes standalone (or the reverse), or if knip's advisory line stops being read because it is always red: on 2026-11-26 it reports 1,401 findings over its baseline, which is DOR-4629's question.
