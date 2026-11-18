---
id: 261117-173045
title: a root README-only pull request skips the test shards too
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard-count
  - wf.test.test-shard
  - wf.test.test-binary
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50@pull_request'
  baseline: 18.7
  baseline_source: 'ci-steward-data snapshots/2026-11-16.json, gates["wf.test.test-shard@pull_request"].durations: n=874, p50 1123 s (18.7 min)'
  target: 18.6
  after_days: 14
ratchet-release: []
field-changes: []
---

Follow-up to ledger 261115-205154 (DOR-4484). `scripts/no-code-scope.sh` lets a pull request skip
the PR leg of `test-shard` and `test-binary` when every changed path is prose: `CHANGELOG.md`,
`VERSION`, `changelog/`, `docs/`, `blog/`, or a version-only `package.json`. The root `README.md`
was not on that list, so a PR that only edits it ran the whole suite on every shard for nothing.

The change adds the literal root `README.md` (no glob) to the prose list. A package's `README.md`
still runs the shards: a package can pack, read or assert on its own. Safe because no shard test
reads the root README (every `README.md` in a test is a fixture name in a temp directory), and it is
in no turbo `globalDependencies` or task `inputs`. The merge queue and canary still run the full
suite on everything.

Measure: README-only PRs are rare, so the scored p50 will not visibly move; expect `inconclusive`.
The direct reading is a README-only PR's shards logging "did not run here". Revert if a queue
ejection traces to a README-only change this skipped.
