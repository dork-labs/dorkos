---
id: 260923-234432
title: Install bsdtar so the archive cross-checks run in CI
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: [2055]
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p90@merge_group'
  slo: 'queue-build'
  baseline: 17.8
  baseline_source: 'measured 2026-09-23 with `gh run view --json jobs` over the 12 latest successful test.yml merge_group runs: 48 test-shard jobs, p50 16.2 min, p90 17.8 min'
  target: 18.3
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-2294 adds ZIP64 export primitives to `apps/community`, and AC-2 of
`specs/community-export-any-size/` requires the archives to open in Info-ZIP `unzip`, `bsdtar` and
Python's `zipfile`. `zip-cross-tools.test.ts` runs those tools; locally a missing one is skipped with
a logged reason, but under `CI` a missing one now fails, so the check cannot silently disappear. The
ubuntu runner ships `unzip` and `python3` but not `bsdtar`, so without this step every shard would
have gone red.

The change: one step in `test-shard` after `pnpm install` installs `libarchive-tools` (and `unzip`
or `python3` only if a future image drops them). apt runs only for what is missing.

Why this metric: the step adds work to every shard, so the honest measure is what it costs. An
`apt-get update` plus one small package is about 10 to 20 seconds; the target allows half a minute
on the p90. Revert, or cache the package, if the p90 rises past 18.3 minutes because of this step.
