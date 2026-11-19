---
id: 261118-140000
title: test jobs build with no test arguments, then run their suites with --only
kind: experiment
status: proposed
actor: agent
gates:
  - wf.test.test-shard
  - wf.test.test-binary
prs: []
hypothesis:
  metric: 'tracked.cache-hit-rate'
  baseline: 0.12
  baseline_source: 'merge_group run 44135819867 (2026-11-17, first queue run after #3900): shards 2-4 restored their own per-shard entry and logged `Cached: 6 cached, 49 total`; shards 1, 5 and 6 missed. Local `turbo --dry=json` on main: `@dorkos/shared#build` is 021e0f55… from `turbo run build`, f45d40ab… under `turbo test -- --run --shard=1/6`, 1493bf38… under 2/6.'
  target: 0.8
  after_days: 7
ratchet-release: []
field-changes: []
---

DOR-4625, DOR-4190 program. Follows ledger 261117-142230 (#3900, per-shard keys).

Turbo hashes `turbo test`'s `--` arguments into every task of the run, the `^build`
dependencies included. Per-shard keys (#3900) made each queue shard hit only its own shard's
canary builds, and the pull request leg and test-binary, with their own argument lists, never
hit. A build only replays when its own inputs are unchanged since the canary, so the hits that
remained were few: 6 of 49.

Now every test job builds first with the new scripts/build-test-deps.sh. It reads the build set
from `turbo test <filters> --dry=json`, the same filters as the suite line, and runs
`turbo run build --summarize --concurrency=1` over exactly those packages with no `--`
arguments. The suite lines then take `--only`. Locally the `--only` run lists the same 33 `test`
tasks as before and no build, and the explicit build set matches the 24 packages the test run
built. So:

- builds hash the same in all six shards, the pull request leg and test-binary;
- one cache entry (`turbo-test-builds-<os>-<arch>-<lockfile>-<sha>`, no shard) serves them all.
  The canary's shard 1 saves it, after keep-build-cache-only.sh trims to the build step's own
  run summary (passed explicitly, since the sweep's summary under `--only` holds no build task);
- assert-tests-executed.sh still reads the sweep's summary, which still holds every `test` task.

The build steps carry no step `if:`; they gate in the script, and the census stays `ok`. The
pull request leg builds inside its suite step, so `steps.noscope.outputs.run` still gates
exactly one step. scripts/test-build-test-deps.sh pins the helper and is registered in both
`test:scripts` and scripts-test.yml.

Expected within 7 days: queue shards log `Cached:` near the build count on their build step
whenever the canary is recent, and the shard p50 drops by most of the remaining build time.
Watch `gate.wf.test.test-shard.duration_p50@merge_group`. Revert if a queue shard ever passes
on a stale build. Turbo's hashes should prevent that, but if it happens, the build step's
summary will show it.
