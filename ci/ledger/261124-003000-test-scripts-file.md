---
id: 261124-003000
title: The scripts suite list moves out of the root package.json, so a CI-only PR keeps its turbo cache
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.typecheck.typecheck
  - wf.lint.lint
prs: []
ratchet-release: []
field-changes: []
---

Under DOR-4190. Registering a scripts suite edited `test:scripts` in the root package.json, which
Turborepo hashes into every package. So a CI-only PR (#4192, Nov 23) put all 34 packages in
scope with no cache: typecheck took 8m07s (6m09s in the turbo step), and lint about as long. The
list now lives in `scripts/run-scripts-suites.sh` (renamed Nov 24 from `test-scripts.sh`, which the parity test took for a fixture suite), one suite per line; package.json only calls it, and
`shell-suite-parity.test.ts` pins the delegation and reads the file. The long line was also the
merge-conflict hot spot between parallel CI PRs (three times on Nov 23).

Baseline: #4192 typecheck 8m07s, lint over 7 minutes, on a PR touching no package.
Target: a PR that registers a new suite and touches no package finishes typecheck and lint under
3 minutes.
Evaluate: Nov 30, on the next CI PRs that register a suite.

Revert if `pnpm verify` stops running a suite that CI runs (the parity test should catch it).
