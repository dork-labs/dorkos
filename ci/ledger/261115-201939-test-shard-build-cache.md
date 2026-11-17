---
id: 261115-201939
title: test shards restore the main canary's turbo builds instead of rebuilding 19 packages each
kind: experiment
status: active
actor: agent
gates:
  - wf.test.test-shard
  - wf.scripts-test.fixtures
prs: [3814, 3849]
hypothesis:
  metric: 'gate.wf.test.test-shard.duration_p50@merge_group'
  slo: 'queue-build'
  baseline: 23.6
  baseline_source: 'ci-steward-data snapshots 2026-11-08..14, gates["wf.test.test-shard@merge_group"].durations: n=1832, p50 1416 s (23.6 min), p90 1674 s; build share from run 43747929385 (test-time audit 2026-11-15, section 2.1: build tasks 141-223 s per shard, Cached: 0 cached)'
  target: 21.0
  after_days: 14
ratchet-release: []
field-changes: []
---

Every `test-shard` job ran `turbo test` on an empty `.turbo/cache`, so each of the six shards
rebuilt the same ~19 packages: 141-223 s per shard, `Cached: 0 cached` in every turbo summary, about
13.5% of test.yml's job time (DOR-4190, audit fix #1 / batch B1).

The change: each shard restores `.turbo/cache` with `actions/cache/restore` (pinned by SHA) before
the sweep. Only the main canary (`schedule` / `workflow_dispatch` on `refs/heads/main`, 4 a day)
saves it, because `main`'s cache scope is the only one every queue build and pull request can
read. Before the save, `scripts/keep-build-cache-only.sh` deletes every entry that is not one of
that run's `build` or `generate:api-docs` tasks (read from the turbo run summary), so no `test`
result is ever handed on. Turbo's own task hash decides each hit; the key only picks which entry to
download (OS, arch, lockfile, newest canary first). The sweep line, the shard split, the quarantine
lane, `assert-tests-executed.sh` and `assert-shard-union.sh` are unchanged.

Expected: on a queue build whose packages have not changed since the last canary, the build tasks
show `Cached: N cached` and take under ~40 s per shard instead of 141-223 s; about 15 job-minutes
per queue run less. Builds changed since the last canary still rebuild, so the median gain is
smaller than the best case; the target (-2.6 min p50) assumes most of the 19 packages are quiet
between canaries.

Watch beside it: `tracked.cache-hit-rate` (the restore step should hit on most queue runs after
the first post-merge canary) and `gate.wf.test.test-shard.failure_rate@merge_group` (must not
rise). Revert if any queue shard fails "Prove the suite actually executed" with a replayed `test`
task (the trim leaked), if a failure is traced to a replayed build output that did not match its
sources, or if the p50 does not move by at least 1 minute after 14 days.
