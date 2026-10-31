---
id: 261031-170302
title: eight more suites declare the files outside their package that their tests read
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

DOR-3518, the third layer, stacked on 261031-164008. A pull request now runs the
suites whose turbo hash its change moved, and a hash covers only declared
files. 261031-163500 declared ci-steward's reads. An audit of every unit test
outside `apps/e2e` found eight more suites reading files they never declared:
server (`docs/`, `blog/`, `decisions/`, `contributing/**`, `.github/**`,
`apps/client/src/**`, `apps/site/src/**`, `apps/desktop/src/**`, every package's
source, and a few single files), harness, test-utils, site, client, the CLI,
marketplace and evals. Each read is now an input of that suite's `#test` task.
Nothing is removed. A pull request that changes only one of those files used to
leave the reader's hash alone, so the plan skipped it and only the queue could
catch a break, as an ejection. The metric is the queue failure rate that
pull-request-side catches should lower, shared with 261031-164008.

Measured with `turbo test --dry=json` against the base `turbo.json`: exactly
nine test hashes move (the eight, plus ci-steward, which gains `turbo.json` and
the exclusion below). A one-line change to a `docs/` page moves server and site;
`contributing/ci.md` moves server; `apps/client/src/main.tsx` moves client,
desktop, the CLI and server; `meta/harness-smoke/`, `.agents/harness.manifest.json`
and `scripts/lib/space-server.mjs` move harness.

The trap this spells around: an explicit `$TURBO_ROOT$/…` glob hashes
GITIGNORED files, unlike `$TURBO_DEFAULT$`. Measured: a file under
`packages/evals/.turbo/` moved the server hash under `packages/**`, and vitest's
cache at `scripts/node_modules/.vite/vitest/results.json` sits under the
existing `scripts/**`. So the packages are named as source, scripts, manifests
and root config files, and `scripts/**` now excludes `scripts/node_modules/**`.
Probed afterwards: ignored files under `scripts/node_modules/`, a package's
`.turbo/` and a package's `dist/` move no hash. A guard,
`packages/ci-steward/src/__tests__/turbo-test-reads.test.ts`, refuses a glob over
a whole package directory.

Cost: the server suite now reruns on more pull requests (any docs, contributing
or client change), each on six shards, because it is the widest suite. That
widens the server share of 261031-164008's estimate of +3,400 runner-minutes a
week for escape-list PRs. Revert an entry if no test reads its path, or if
`gate.wf.test.test-shard.duration_p90@pull_request` rises with no fall in the
queue failure rate.
