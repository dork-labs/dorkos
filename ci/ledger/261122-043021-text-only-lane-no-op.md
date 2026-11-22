---
id: 261122-043021
title: a change outside every package suite takes the text-only lane as a no-op instead of failing it
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.test.test-shard
  - wf.test.test
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.failure_rate@pull_request'
  baseline: 0.0543
  baseline_source: 'origin/ci-steward-data:snapshots/2026-11-20.json (latest.json at fetch), wf.test.test-shard@pull_request: 34 failures in 626 completed, non-cancelled runs (592 success, 48 cancelled). Read before #4100 merged, so it is the rate this fix restores, not the broken one.'
  target: 0.05
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-5024. Since #4100 (DOR-4834, ledger 261120-043306), a pull request whose changed files are
all Markdown outside every package with a test suite (only `meta/`, `plans/`, `research/`) fails
the required `test` check. #4110 is the proof (run 44983553528): the classifier answers "text
only", so the one shard runs `scripts/text-only-tests.sh`, which found no owning package and
exited 1 with "no file belongs to a package with a test suite, so nothing would run". The script
treated that list like a lost one. It is not: the files are real, and no package suite can see
them.

The change: that case prints why nothing runs and exits 0. An empty list, or one that is not a
JSON array of paths, still exits 1, and a package handed a test file still runs without
`--passWithNoTests`. No workflow edit: in test-shard-count `tests=false` is forced by
`text_only=true`, so honouring `tests` first in the shard step would change nothing. The shards
would run nothing for these files either (turbo runs package suites only; root `scripts/` tests
run in scripts-test.yml), and the merge queue still runs every suite on every entry.

Measure: test-shard's pull-request failure rate at or under 0.05, about one failed run in twenty
and a little under the 0.0543 measured before #4100, since docs-only pull requests stop adding
failures that point at no defect. This incident is rare (it hits only pull requests whose every
file sits outside the package suites), so the rate may move little and an `inconclusive` verdict
is likely. Revert if a queue ejection traces to a change this no-op let through on its pull
request.
