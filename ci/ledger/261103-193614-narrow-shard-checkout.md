---
id: 261103-193614
title: Test shards and openapi-fresh stop fetching every branch and tag
kind: experiment
status: active
actor: agent
gates: [wf.test.test-shard, wf.docs-openapi-check.openapi-fresh]
prs: []
hypothesis:
  metric: gate.wf.test.test-shard.duration_p90@merge_group
  slo: headroom
  baseline: 25.8
  baseline_source: 'Hand sample from the GitHub API: the newest 12 queue test runs per day, 2026-10-28..2026-11-03, 428 green shards. Job p90 25.8 minutes, job minus checkout p90 25.2, checkout p90 0.6, worst 4.7. The worst on a PR run was 15.6.'
  target: 25.2
  after_days: 7
ratchet-release: []
field-changes: []
---

`fetch-depth: 0` makes every shard and `openapi-fresh` fetch all branches and tags of a 600 MB repo. On 2026-11-03 that went from under a minute to as much as 15.6, and it was part of four shards being cut at their limit and of `openapi-fresh` being cut at 10 minutes.

What each job really reads:

- **A shard** reads HEAD, plus the newest release tag for the DOR-339 migration guard, which reads nothing older (`latestRelease` in `migration-safety.ts`). So: depth 1, then one small step that fetches that one tag. Measured from a Mac: 34 seconds and 150 MB for the clone, 3.5 seconds for the tag.
- **`openapi-fresh`** reads the PR's base for its scope diff. On a test-merge commit that is `HEAD^1`, the same merge base `origin/<base>...HEAD` found. So: depth 2.

Tried and dropped: all tags at depth 2 pull 468 MB, because old tags hold old blobs. `filter: blob:none` makes that 6 MB but makes the guard fetch files one at a time, and one such read took 11.5 seconds, which risks its test timeout.

The shards also now print the CPU model, so the next read can tell a slow runner from a slow suite.

The metric is a weak fit. On a normal day checkout is under a minute, so p90 can only fall about 0.6, and the suite is still growing. Entry 261103-182757 changes the same gate in the same window, so this verdict may read inconclusive. Also read by hand when the window closes: checkout minutes per shard, and shards or `openapi-fresh` cut at a limit. The target there is checkout under 1 minute and no cuts.

Not proven here: only the merge queue runs the full sweep, so a test that needs older history shows up there first. Revert, or fetch what that test needs, if one does. Eight other workflows keep `fetch-depth: 0`, and `version-outranks-base` was cut at its 10-minute limit during checkout on 2026-11-03. Each has its own reason for history, so they get their own read. DOR-3769 tracks that, and an eighth shard waits for these numbers.
