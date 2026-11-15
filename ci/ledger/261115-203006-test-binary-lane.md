---
id: 261115-203006
title: the real-CLI binary suites run in their own job beside the test shards
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard
  - wf.test.test-binary
  - wf.test.test
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p90@merge_group'
  slo: 'queue-build'
  baseline: 27.9
  baseline_source: 'ci-steward-data snapshots 2026-11-08..14, gates["wf.test.test-shard@merge_group"].durations: n=1832, p90 1674 s (27.9 min); binary file times from run 43747929385 (test-time audit 2026-11-15, section 4: project-plugin-guard.binary 216 s, package-grants.binary 77 s, claude-code deny/guard binaries 44-55 s, 566 s of worker time over 20 files)'
  target: 27.2
  after_days: 14
ratchet-release: []
field-changes: []
---

The 20 `*.binary.test.ts` files outside `codex/` spawn a real CLI (the SDK-bundled `claude`, the
pinned `opencode`) and are the longest single files in the suite: 216 s, 77 s, then 44-55 s each,
566 s of worker time. They ran inside the six `test-shard` jobs, so whichever shards drew them
waited on them (DOR-4190, audit fix #5 / batch B3).

The change: both shard legs (queue and PR) widen `--exclude='**/codex/**/*.binary.test.ts'` to
`--exclude='**/*.binary.test.ts'`. A new `test-binary` job runs exactly those files (read with
`git ls-files`, minus `codex/`, which codex-sandbox keeps) in parallel with the shards, through the
same `turbo test`, runner, store and B1 build cache, with `--retry=1`, the flake reporter and the
quarantine gate on the queue and canary, and zero retries on a pull request. On a pull request it
runs when the test plan reaches the package that holds them, which is when the shards ran them.
`scripts/assert-binary-suites-ran.mjs` fails the job unless every planned file was collected, with
at least one test and none skipped. The `test` fan-in needs `test-binary` and requires `success`,
and the union check gains `--require-files`: every `*.binary.test.ts` in the tree must be in the
union by name (test-binary and codex-sandbox upload `shard-files-binary` / `shard-files-codex`).
No required check name changes.

Expected: the shards that drew a binary file lose it; the slowest shard is 30-50 s shorter, so
`test-shard` p90 falls by about 0.7 min (baseline 27.9). `test-binary` finishes in about 8 minutes
(2 of setup and cached builds, the 216 s file as its long pole), well before the slowest shard, so
the fan-in never waits on it. Job minutes per queue build rise by about 2-3 (one more job's
setup).

Confound: B1 (ledger 261115-201939) changes the same gate in the same window and should move the
p90 by more than this does. If both land within 14 days, read this verdict with that entry's; the
clean signal for this change is the per-file absence of the binary suites in the shards' reports and
`test-binary`'s own duration.

Watch beside it: `gate.wf.test.test-binary.duration_p90@merge_group` (must stay below
`test-shard`'s p50) and `gate.wf.test.test-binary.failure_rate@merge_group` (must not exceed the
shards'; the CLIs now share a runner with each other rather than with unit tests). Revert if
`test-binary` p90 exceeds the shard p50, if its failure rate is double the shards', or if any queue
build's union check reports a binary suite missing that the job did not also report.
