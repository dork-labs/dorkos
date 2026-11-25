---
id: 261124-003748
title: The 500-line ratchet holds test files too, in their own baseline
kind: experiment
status: proposed
actor: agent
gates: [wf.typecheck.typecheck, lefthook.pre-push.max-lines]
prs: []
hypothesis:
  metric: gate.wf.typecheck.typecheck.duration_p90@merge_group
  baseline: 10.82
  baseline_source: 'typecheck job of the 20 newest green merge_group typecheck.yml runs to 2026-11-23 (45270942711 … 45097297125), n=20, p50 10.35 min, p90 10.82 min; the "File-size ratchet (DOR-2822)" step in the same jobs: p50 17 s, p90 19 s, max 20 s'
  target: 11.2
  after_days: 14
ratchet-release: []
field-changes: []
---

The file-size ratchet (ledger `261010-125652`) left test files out, and `@dorkos/eslint-config/test` switches `max-lines` off for them, so nothing stopped a test file from growing. Measured with the same ESLint count on 2026-11-23: 627 of 6,575 test files are over 500 lines (885 by raw lines).

`scripts/check-max-lines.ts` now holds TypeScript test files (`.ts`, `.tsx`; `.mjs` tests are not measured) to a second baseline, `scripts/max-lines/test-baseline.json`: a listed test may not grow past its entry, a new one (or one whose entry was removed) may not pass 500, and `--base` refuses an entry raised or added by hand. Unlike source files, a stale test entry (shrank, split or deleted) is noted, not failed: many PRs are splitting big tests at once, and failing each until it ran `--update` would red them all and make them conflict on neighbouring lines. `--update` locks those shrinks in, in the weekly `pruning-tests` run by @dorkos-qa, or by anyone. The accepted gap: until `--update` runs, a shrunk test may regrow up to its old entry. A test in a path ESLint ignores is still held, counted with the TypeScript parser alone. Same step, same command, same pre-push hook; the only workflow edit is the comment above the step. Its own file because each entry is one line and git refuses two edits on neighbouring lines; in one sorted list a test sits beside its source file, so PRs splitting big tests would conflict with PRs shrinking source files in the same folder.

Growth is judged per change. With `--base`, a file over its entry (or a new one over 500) that was already that long at the base is a note: the lines came in with another change. In the merge queue the base is the previous entry, so a PR is never failed for one ahead of it. Without this the baseline could not land: four queue runs in a row failed because PRs ahead added a few lines to listed tests. It applies only while the change leaves that file's entry as the base had it (or the base had no baseline yet), so deleting or lowering an entry still fails, and one line added by the change itself still fails. The same rule holds for source files, where every PR was already held, so it changes nothing there in practice.

The real hypothesis is about the tests, and the collector cannot compute it, so the script is its measure: the count goes from 627 down each week and none grows. Read it with `jq '.files | length' scripts/max-lines/test-baseline.json` on `main`. The scored metric is the price: locally the script went from 12.6 s to 25.2 s under load, so the step should add 15 to 20 s and the job's p90 stay at or under 11.2 min.

Revert or rework if the p90 passes 11.2 min because of this step, if `test-baseline.json` conflicts between the PRs splitting test files become a regular cause of DIRTY PRs, if people split tests into meaningless pieces instead of by subject, if unlocked shrinks pile up for more than a week, or if big tests escape by moving out of `__tests__` into a source path whose config switches `max-lines` off (such as `shared/ui`), a known gap left open on purpose.
