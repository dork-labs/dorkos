---
id: 261123-194610
title: main saves the test and browser build caches after every merge, not only from the scheduled canary
kind: experiment
status: proposed
actor: agent
gates:
  - wf.build-cache.test-builds
  - wf.build-cache.browser-builds
  - wf.build-cache.prune
  - wf.test.test-shard
  - wf.browser-test.browser-shard
  - wf.scripts-test.fixtures
prs: []
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50@merge_group'
  slo: 'queue-build'
  baseline: 21.3
  baseline_source: 'ci-steward-data snapshots 2026-11-16..22, gates["wf.test.test-shard@merge_group"].durations: n=2736, p50 1276 s (21.3 min), p90 24.9 min. Cache state behind it (DOR-4627 re-measure, 2026-11-16 15:18Z..11-17 14:09Z, 366 test-shard jobs): 0 exact restore hits, 246 restored an entry built for an older lockfile, turbo replayed 1.2% of merge_group tasks; a recent queue shard replayed 4 of 20 builds and spent 173 s building. Canary rounds delivered twice a day (02:xx and 14:xx UTC, 2026-11-18..22).'
  target: 19.5
  after_days: 14
ratchet-release: []
field-changes: []
---

DOR-4627 (broadened by Dorian, Nov 23), DOR-4190 program. Follows 261115-201939, 261116-091832,
261117-184500 and 261118-140000, which made one build entry serve every test job and every browser
job, but left the scheduled canary as the only writer on `main`.

Only `refs/heads/main` may save a cache that every pull request and queue build can read. The only
runs on `main` that saved the turbo build caches and pnpm stores were the canary rounds of
`test.yml` and `browser-test.yml`, and GitHub delivered two of the four daily slots. So a queue
build restored builds up to half a day and a dozen merges old, and rebuilt most packages.

The change: new `build-cache.yml` runs on every push to `main` (and on dispatch, `main` only).
`test-builds` (ubuntu-latest) runs `scripts/build-test-deps.sh` with no filters, as the queue
shards do, and saves `turbo-test-builds-<os>-<arch>-<lock>-<sha>` and the ubuntu-latest pnpm
store. `browser-builds` (ubuntu-24.04, `NODE_ENV=development`) runs browser-shard's build line and
saves `turbo-browser-builds-…` and the 24.04 pnpm store. Each restores the previous merge's entry
first, trims to its own build step's entries with `keep-build-cache-only.sh` before saving, and
saves nothing on an exact hit. `prune` (its own job, the only one with `actions: write`, builds
nothing) runs the new `scripts/prune-main-build-caches.sh`, which keeps the newest three entries of
each of the two families on `main` and deletes the rest, so a save per merge stays inside the
10 GB budget (the repo held 9.8 to 14.1 GB on Nov 16..22). The restore keys already end with an
OS-and-arch-only prefix (since 261118-140000), so a lockfile change still falls back across
lockfiles; nothing changes on the restoring side. The canary's own saves stay; when this workflow
already saved that SHA they find the key taken and skip.

Pinned by `scripts/__tests__/build-cache-workflow.test.ts` (build lines, hashed env, images and
keys read from the live `test.yml` and `browser-test.yml`; never a required context; the write
token in `prune` only) and `scripts/test-prune-main-build-caches.sh` (registered in `test:scripts`
and scripts-test.yml).

Cost: no money (public repo). About 2-3 runner-minutes a job when the store and the previous
merge's builds hit, so about 5 a merge, about 225 a day at 45 merges; one concurrency group per ref
cancels a superseded push. DOR-5114 then drops one of the two delivered canary rounds a day, about
320 job-minutes.

Expected within 14 days: queue shards log `Cache restored from key: turbo-test-builds-…` with the
current lockfile on most runs, `Cached:` near the build count on their build step, and the shard
p50 down by most of the remaining build time. Watch
`gate.wf.browser-test.browser-shard.duration_p50@merge_group` beside it, and
`gh api repos/dork-labs/dorkos/actions/caches` for `main` holding at most three entries of each
family. This shares its gate and window with 261118-140000, so the computed verdict may be
`inconclusive`; read the restore lines too. Revert if total cache use stays over 10 GB because of
these entries, if `prune` ever deletes anything but an older turbo build entry on `main`, or if a
queue shard passes on a stale build.
