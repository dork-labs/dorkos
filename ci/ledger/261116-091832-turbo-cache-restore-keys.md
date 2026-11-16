---
id: 261116-091832
title: queue shards restore main's newest build cache even after a lockfile change
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50@merge_group'
  slo: 'queue-build'
  baseline: 23.6
  baseline_source: 'ci-steward-data snapshots 2026-11-08..14, gates["wf.test.test-shard@merge_group"].durations (n=1832, p50 23.6 min, as ledger 261115-201939 read it); unchanged since #3814 because no queue shard has restored an entry yet: runs 43822808186 and 43832945817 shard 1/6 "Cache not found", "Cached: 0 cached, 49 total"'
  target: 21.0
  after_days: 7
ratchet-release: []
field-changes: []
---

The fix for ledger 261115-201939 (#3814, DOR-4190 B1), which never got a hit in the queue. The
main canary saves turbo's build cache under `turbo-test-builds-<os>-<arch>-<lockfile hash>-<sha>`,
and every restore asked only for that lockfile hash. On 2026-11-16 the canary saved at 01:38Z under
lockfile `5fe6073b…` (run 43785655424, 57 files for 19 build hashes); #3610 changed
`pnpm-lock.yaml` at 03:00Z, so queue runs 43822808186 and 43832945817 looked for `b5faffb…-`, found
nothing, and every shard rebuilt from empty. GitHub delivers the canary about twice a day (01:xx
and 12:xx-14:xx UTC for the last 8 days), so any lockfile change on `main` turned the cache off
for half a day.

The change: the restore in `test-shard` and `test-binary` adds a last restore key without the
lockfile hash, `turbo-test-builds-<os>-<arch>-`, so a run falls back to `main`'s newest entry.
Turbo still decides every hit from its own task hash (each package's resolved dependencies, files
and env), so only packages whose dependencies changed rebuild. Unchanged: only `main` saves, the
build-only trim before the save, `assert-tests-executed.sh` and `assert-shard-union.sh`. Pinned by
`scripts/__tests__/turbo-build-cache-restore.test.ts`.

A second limit this does not fix: every `build` depends on `//#heavy-slot` (#3368), and turbo
always hashes the root `package.json` and `turbo.json` into that root task, so a change to either
file since the canary changes every build hash (measured with `turbo run build --dry=json`: one
added root script changed `@dorkos/icons#build` from `722b6d1b…` to `0da450fd…`; negating them in
`inputs` does not remove them). Three queue runs that did restore the canary's entry before the
lockfile change (43788991004, 43790299474, 43794818748) still logged `Cached: 0 cached, 49 total`
for that reason: root `package.json` changed 21 times on `main` from 2026-11-09 to 11-16. Until
that coupling is resolved separately, hits come only in the windows where neither file changed
since the last canary, so the target may not be reached by this entry alone.

Expected: queue shards log "Cache restored from key: turbo-test-builds-…" and turbo
`Cached: N cached` with N most of the build tasks, and the build phase under ~40 s per shard
instead of 141-223 s. This shares its gate and window with 261115-201939, so the computed verdict
may come out `inconclusive` for confounding; watch `tracked.cache-hit-rate` beside it. Revert if a
queue shard fails "Prove the suite actually executed" on a replayed `test` task, or if a failure is
traced to a replayed build output from an older lockfile.
