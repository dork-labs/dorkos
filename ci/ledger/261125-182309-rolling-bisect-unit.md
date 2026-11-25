---
id: 261125-182309
title: The rolling full unit run on main is bisected and auto-reverted like the browser suite
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.rolling-bisect.next
  - wf.rolling-bisect.report
  - wf.rolling-bisect.revert
prs: [4442]
ratchet-release: []
field-changes: []
---

DOR-5254, the follow-up 261124-073000 (DOR-5122) left open. `test.yml`'s push run on main has been
rolling since #4257 (one run in flight, so one run covers several merges), but only `browser-test`
was bisected: a red `test` push run listed every merge in its range (after-merge-alert, ROLLING=1)
and named none.

Now `test.yml` takes the same `bisect_sha` / `bisect_of` dispatch inputs as `browser-test.yml`: every
checkout takes the bisected merge, each job first refuses a sha that is not on main, the run is
titled `bisect <sha> for run <id>`, it gets a concurrency group of its own per merge (never the
rolling `gate` group), and shard 1 never saves the turbo build cache under main head's sha. A
dispatch already runs the full sweep on ten shards with no plan, like the canary. `test` joins
`ROLLING_WORKFLOWS` in `scripts/auto-revert.sh` and `rolling-bisect.yml`'s `workflows:`, so a red
`test` push run is re-tested at its head, bisected, named on the culprit's PR and the failure-group
issues, and reverted while `AUTO_REVERT` is on, through the same path as browser-test.
`auto-revert.yml` does not list `test`: it skips rolling workflows (261125-011342), so a listing
there would only start a skipped run per `test` completion. `scripts/rolling-bisect.sh` needed no
change: it reads the workflow file from the run's path, and a failure family is a failed job of that
run with its `(i/N)` suffix and the `test` fan-in dropped.

The fixtures prove a `test` failure is bisected and that rolling-bisect.yml's own decide step,
read from the workflow, dispatches `test.yml` on main with both inputs. Budget per red `test` run:
one full unit sweep for the probe of H plus at most ceil(log2 N) (N <= 16), about 10 shards each.

Revert (drop `test` from both lists) if a `test` bisect names a merge a person shows was innocent,
or if its dispatches delay or cancel a rolling `test` push run. A known edge to watch: each shard
fetches the newest release tag for the DOR-339 migration guard, so a bisected merge older than that
tag is checked against a release cut after it.
