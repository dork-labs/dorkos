---
id: 261125-065516
title: "The turn port's ratchet: no space-side file may add an import of turn code"
kind: experiment
status: proposed
actor: agent
gates: [wf.lint.lint, wf.typecheck.typecheck, lefthook.pre-push.turn-port]
prs: []
hypothesis:
  metric: 'gate.wf.lint.lint.duration_p90@merge_group'
  baseline: 10.9
  baseline_source: 'wf.lint.lint@merge_group in ci-steward-data snapshots/2026-11-23.json, n=24 green runs, p90 about 655 s'
  target: 11.0
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-5232, step T5 of spec `turns-survive-restarts` (§3.4). Every space-side caller is to start, watch and stop a turn through one port, and they move to it one at a time. The ratchet holds the line while they do: at this branch's head on main (`752f248633`) the fourteen space-side domains hold 140 imports of turn code (`services/session/**` but chat messages, and `services/runtimes/**`) in 91 files, and none may be added.

`apps/server/eslint-rules/turn-port-boundary.js` is an ESLint rule in the server's lint (the required `lint` check). It resolves every import, export-from and literal `import()` against the file, type-only imports included, and holds each space-side file to its entry in `apps/server/eslint-rules/turn-port-boundary.baseline.json`: one more import fails, and so does one fewer until `--update` locks the drop in. It also refuses `services/runs` reaching past `session/turn-port/index.js`, and turn code importing `services/runs`, with no baseline. Tests are not checked.

`scripts/turn-port/check-turn-port-boundary.ts` measures the same thing with the rule's own classifier, lowers entries (`--update`, never raises), and with `--base` refuses an entry raised or added by hand. The `typecheck` job runs it with `--base` beside the file-size ratchet, on the same base (the merge commit's first parent on a PR, `merge_group.base_sha` in the queue), and pre-push runs it at the branch point; its test (`scripts/__tests__/check-turn-port-boundary.test.ts` › "the repo") runs in the test sweep.

The real measure is the baseline's total, which should fall with each caller that moves (T6 to T13) and reach zero at T17: `jq '[.files[]] | add' apps/server/eslint-rules/turn-port-boundary.baseline.json`. The scored metric is the price: the rule reads each file's imports once and should not move the lint job's queue p90 past 11.0 minutes.

Revert or rework if baseline conflicts between concurrent PRs become a regular cause of DIRTY PRs, if the rule shows in the lint p90, or if callers work around it (a re-export through a space-side file) instead of moving to the port.
