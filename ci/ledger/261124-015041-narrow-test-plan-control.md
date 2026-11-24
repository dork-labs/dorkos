---
id: 261124-015041
title: a pull request that touches only ledger entries, other workflows, script fixture suites or prose under .github/, ci/ or scripts/ runs the suites that read them, not every suite
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.test.test-shard-count
  - wf.test.test-shard
prs: []
ratchet-release: []
field-changes: []
---

DOR-5130, step 6a of the CI efficiency plan. `scripts/pr-test-plan.sh` (ledger 261031-164008) runs
every suite when a pull request touches a "control" path: `.github/`, `scripts/`, `ci/`, any
`package.json`, the lockfile, the workspace, `.npmrc`, `turbo.json` or the root vitest config. In
the week of Nov 16-22, 41% of merged pull requests (130) hit one, and 67 of those touched only
files that choose and run no test: ledger entries, workflow files, the scripts' fixture suites. Each
paid the full suite on six shards (about 19 minutes, about 110 runner-minutes).

The change: these paths stop being control paths and are planned by turbo hash like any other file,
so the suites that declare them as inputs run (ci-steward for `ci/**` and `scripts/**`, the server
for `.github/**`) and the rest do not. `ci/ledger/**`; `.github/workflows/*.yml` except `test.yml`,
`security-gate.yml` and `build-cache.yml`; `scripts/__tests__/**` and `scripts/test-*.sh` (never a
`scripts/test-*/` folder); and Markdown under `.github/`, `ci/` and `scripts/`. Any `package.json`
stays a control path wherever it sits. Everything else on the list is unchanged. The merge queue
and the canary still run every suite.

Baseline (Nov 16-22): 41% of merged pull requests forced the full PR suite.
Target: at most 25% of merged pull requests force it, and a ledger- or fixture-suite-only pull
request runs one suite on two shards.
Evaluate: Dec 1, from the "running every suite" reasons in test-shard-count's logs.

Revert if a queue ejection or a red main canary traces to a suite this skipped on a pull request
that touched only these paths.
