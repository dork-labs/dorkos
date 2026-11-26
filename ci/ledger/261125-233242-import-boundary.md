---
id: 261125-233242
title: 'The services import boundary: no new domain-to-domain import under services/'
kind: experiment
status: proposed
actor: agent
gates: [wf.lint.lint, wf.typecheck.typecheck, lefthook.pre-push.ratchets]
prs: []
hypothesis:
  metric: 'tracked.import-boundary-allowance'
  baseline: 2143
  baseline_source: 'pnpm check:import-boundary -- --init at base c07e1d4bc2: 89 domains, 578 pairs (113 both ways), 2143 import statements'
  target: 2143
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4924. Every domain under `apps/server/src/services/` (each folder under `core/` its own) could import any other, and the only walls were three hand-picked pairs and the computer wall's sides. At base `c07e1d4bc2` the non-test code there makes 2143 import statements across 578 domain pairs between 89 domains, 113 of them both ways (the ticket counted 549 pairs and 111 both ways on 2026-11-21). None may be added.

`apps/server/eslint-rules/import-boundary.js` is an ESLint rule in the server's lint (the required `lint` check): it resolves each import with the computer wall's own path classifier (`inServices`, `isTestPath`) and statement visitor (`importsOf`), and refuses a statement whose pair is not in `import-boundary.baseline.json`. Type-only imports and test files are free. `scripts/import-boundary/check-import-boundary.ts` measures the same pairs from TypeScript's syntax tree with the rule's `edgeOf`, refuses a pair's count grown, lowers counts (`--update`, never raises), and with `--base` refuses a pair added or raised by hand. The `typecheck` job runs it with `--base` beside the computer wall, on the same base; pre-push runs it at the branch point; its test (`scripts/__tests__/check-import-boundary.test.ts` › "the repo") runs in the queue's repo-wide suites. A pull request that moves a folder lowers this baseline and the wall's `sides.json` together.

The real measure is the allowance, the sum of the baseline's counts, which should only fall: `jq '[.edges[]] | add' apps/server/eslint-rules/import-boundary.baseline.json`. Target: never above 2143. The numbers above are from this branch's base; if main moves before merge, `pnpm check:import-boundary -- --init` rewrites the baseline, and the three numbers in the frontmatter and first paragraph are updated from its output line.

Revert or rework if baseline conflicts between concurrent PRs become a regular cause of DIRTY PRs, if the rule shows in the lint p90, or if callers work around it (a re-export through a third domain, or an `import type` widened into runtime use through a cast) instead of depending on a port.

Guard, not the hypothesis: the rule rides the required lint job, so it must not slow it. `gate.wf.lint.lint.duration_p90@pull_request` was 10.9 min (`wf.lint.lint@pull_request`, ci-steward-data snapshots 2026-11-19 to 2026-11-24, n=650 runs, as read for 261125-191359) and should stay at or under 11.0. The turn port's ratchet (261125-065516) and the computer wall (261125-191359) price the same kind of rule on the same job in overlapping windows, so a small move there may not be this one's; read the three verdicts together.
