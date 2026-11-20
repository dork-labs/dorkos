---
id: 261116-214202
title: research-only pull requests skip the test shards too
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.test.test-shard
  - wf.test.test-binary
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50@pull_request'
  baseline: 21.1
  baseline_source: 'ci-steward-data snapshots/2026-11-15.json, gates["wf.test.test-shard@pull_request"].durations: n=1142, p50 1268 s (21.1 min). Research-only PR #3868 (one file under research/) ran all six shards'
  target: 21.0
  after_days: 14
ratchet-release: []
field-changes: []
---

`scripts/no-code-scope.sh` lets a pull request skip the shards' test step when every changed path
is changelog, docs, blog or a version line (ledger 261115-205154). Research reports were not on
that list, so #3868, which changed one file under `research/`, ran the suite on all six shards for
nothing (DOR-4579).

The change: `research/*` (the root folder only) joins the allow list. No test reads the repo's
`research/`; `contributing/` stays off the list because tests do read it. Fixtures cover a
research-only diff (skips) and a nested `.agents/skills/research/` folder (still runs).

Measure: research-only PR runs whose shards log "did not run here", about 13 minutes of suite saved
per shard. Research-only PRs are a small share of all PRs, so the scored p50 barely moves; expect
`inconclusive`. The direct reading is the count of skipped runs.

Revert if a queue ejection traces to a research-only change the PR leg skipped.
