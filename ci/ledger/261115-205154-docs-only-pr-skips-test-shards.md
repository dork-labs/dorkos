---
id: 261115-205154
title: docs-only pull requests skip the test shards, as the no-code scope check intended
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.test.test-shard-count
  - wf.test.test-shard
  - wf.test.test-binary
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50@pull_request'
  baseline: 20.8
  baseline_source: 'ci-steward-data snapshots 2026-11-08..14, gates["wf.test.test-shard@pull_request"].durations: n=2615, p50 1247 s (20.8 min), p10 13.6 min. Docs-only PR #3714, run 43724482110: six shards 762-853 s each (81 job-minutes), every log "cannot diff this pull request against its base (no test-merge commit); running the shards", test step ~779 s per shard'
  target: 20.4
  after_days: 14
ratchet-release: []
field-changes: []
---

The no-code scope check (ledger 261028-231741, 261029-011938) never skipped anything. It ran
inside `test-shard`, whose checkout is `fetch-depth: 1` (DOR-3769), so the test-merge commit's
parents were not in the clone, `HEAD^2` never resolved, and every pull request logged "cannot diff"
and ran the suite on all six shards, docs-only and version-bump PRs included (DOR-4484).

The change: the decision moves, unchanged, to `test-shard-count`, whose checkout is already
depth 2 and diffs the test-merge commit against `HEAD^1` for the shard count and the test plan. It
runs `scripts/no-code-scope.sh` from the base commit and publishes `tests=true|false`.
`test-shard`'s "Decide whether this change can affect a test" step now only reads it: on
`pull_request`, the literal `false` skips the PR test step; anything else (empty, missing, an
error) runs it; every other event always runs. `test-binary` honours the same `false` the same way.
The shard jobs still run and report success, so the required `test` fan-in passes exactly as the
check was designed to. The merge queue and canary never skip. The shards keep `fetch-depth: 1`, so
no job's checkout grows. What counts as docs-only is unchanged.

Measure: per docs-only or version-only PR run, shards whose log says "did not run here" instead of
"cannot diff", and the job-minutes saved: about 13 minutes of suite per shard (~78 per push on six
shards), plus `test-binary`'s suite. About 2% of merged PRs are docs-only (6 of the last 300), so
the scored p50 barely moves. The direct reading is the count of skipped runs. B1 and B3 (ledger
261115-201939, 261115-203006) move the same gate in the same window, so expect `inconclusive`.

Revert if a queue ejection traces to a change this skipped that the PR leg would have caught, or if
a PR run with a code path in its diff skips its shards.
