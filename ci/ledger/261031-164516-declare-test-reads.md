---
id: 261031-164516
title: every suite declares the files outside its package that its tests read, so a turbo hash sees them
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.failure_rate@merge_group'
  baseline: 0.0362
  baseline_source: 'ci-steward-data snapshots 2026-10-24..30: wf.test.test-shard@merge_group, 51 failed or timed out of 1,410 that finished (1,434 runs, 24 cancelled or skipped)'
  target: 0.03
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-3518 step 1, part one. A turbo task hash is what decides whether a suite's
result can be replayed, and next (ledger 261031-165048) what decides which
suites a pull request runs. A hash only covers the files a task declares, and
nine suites read files outside their package that they never declared: the
ci-steward suite reads `.github/workflows/` and `ci/` (so a workflow-only change
moved no hash at all), the server suite reads `docs/`, `contributing/`,
`apps/client/src/` and every package's source, and seven more read smaller sets.
This adds each read to that suite's `#test` inputs in `turbo.json`. Entries are
only added; none is removed.

An explicit input glob hashes gitignored files too (measured: a file under
`packages/evals/.turbo/` moved the server hash under `packages/**`). So the
server's read of the packages is spelled as their source, scripts, manifests
and root config files, never `packages/**`, which would pull in `dist/`,
`node_modules/` and turbo's own logs.

Measured with `turbo test --dry=json` before and after: exactly the nine edited
suites change hash, and a one-line change to `.github/workflows/lint.yml`,
`ci/ledger/*.md`, `contributing/capabilities/runtimes.md` or `lefthook.yml`
now moves at least one suite's hash where before it moved none or not the
reader.

On its own this changes no CI run: this repository has no remote cache, and
`turbo --affected` ignores `inputs`. What it changes today is a local turbo
cache, which no longer replays a stale green after a workflow or doc edit. The
metric is shared with 261031-165048, which uses these hashes to pick a pull
request's tests: fewer queue reds that the pull request could have caught.

Cost and revert condition: the server suite now hashes more of the tree, so
local cache hits for it drop. Revert an entry if a measured local hook run gets
slower because of it and no test reads that path.
