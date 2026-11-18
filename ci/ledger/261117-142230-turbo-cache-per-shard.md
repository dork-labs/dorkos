---
id: 261117-142230
title: each test shard saves and restores its own turbo build cache, because its --shard argument is in every build hash
kind: incident-fix
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50@merge_group'
  slo: 'queue-build'
  baseline: 23.6
  baseline_source: 'ledger 261116-091832 baseline (ci-steward-data 2026-11-08..14, n=1832); queue runs 44079701443, 44053515732, 44047422734, 44047215523 restored canary 44015008724 entry (78557f7e) and shards 1/6-5/6 logged 0 cached; 44047215523 shard 6/6 logged "Cached: 6 cached, 49 total"'
  target: 21.0
  after_days: 7
ratchet-release: []
field-changes: []
---

Follows 261115-201939 (#3814), 261116-091832 (#3849), 261116-114302 (#3850) and 261116-114104
(#3852). After those, queue shards restored the canary's entry and still logged `Cached: 0 cached`.

Cause: turbo 2.10.13 passes the `--` arguments of `turbo test` to every task in the run, the
`build` dependencies included, and hashes them in. The sweep's arguments carry `--shard=N/6`, so
each shard's build hashes differ from every other shard's. Measured with `turbo test --dry=json`
at `9ddabb4a7f`: `@dorkos/keep-awake#build` is `5999388a3348713a` under `--shard=1/6` and
`1f2e68091c093e52` under `--shard=6/6`, and `cliArguments` is the only field of the task that
differs; with no `--` arguments it is `6439dada9c965710`, the same as `turbo run build`. In
canary 44015008724 shard 1/6 logged keep-awake build `0de90618a828109e` and shard 6/6
`7ebd185cf5129c5d`; shard 6/6 saved first, so only queue shard 6/6 could hit. Queue run
44047215523 (`e9aefe32`, a different SHA and event) computed `0de90618…` again on shard 1/6, so the
hash is stable across SHAs and events; only the shard number moved it. Shard 1/6 shared 6 of 19
build hashes with the canary's shard 1/6 and replayed none of them because it had restored shard
6/6's entries.

The change: `test-shard`'s restore and save key gains `shard<N>-` after the arch, so each canary
shard saves its own trimmed entry (about 23 MB, so about 140 MB per canary) and each queue shard
restores the same shard's. `test-binary` keeps its key and falls through to the last prefix; its
own `--` arguments differ, so it misses as before. The pull request leg also runs different
arguments and still misses. Unchanged: only `main` saves, the build-only trim,
`assert-tests-executed.sh`. Pinned by `scripts/__tests__/turbo-build-cache-restore.test.ts`.

Not done here: moving the builds out of the argument-carrying run (a `turbo run build` step and
`turbo test --only`) would let every shard, the PR leg and `test-binary` share one entry, but it
drops the `@dorkos/heavy-slot#slot` dependency from the test run and is a bigger change.

Expected: after a canary, each queue shard logs "Cache restored from key:
turbo-test-builds-Linux-X64-shard<N>-…" with its own N, and `Cached: K cached` with K the build
tasks whose inputs did not change since the canary, on all six shards. Revert if a queue shard
fails "Prove the suite actually executed" on a replayed `test` task, or if cache storage pressure
evicts the pnpm store on `main`.
