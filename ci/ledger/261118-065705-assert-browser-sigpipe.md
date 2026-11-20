---
id: 261118-065705
title: The browser-test gate finds a quarantined test that ran, however long the run's id list
kind: incident-fix
status: proposed
actor: agent
gates: [wf.scripts-test.fixtures]
prs: []
hypothesis:
  metric: gate.wf.scripts-test.fixtures.failure_rate@pull_request
  baseline: 0.0074
  baseline_source: origin/ci-steward-data snapshots/2026-11-16.json, wf.scripts-test.fixtures@pull_request (1 failure in 136 completed runs)
  target: 0.0074
  after_days: 14
ratchet-release: []
field-changes: []
---

`scripts/assert-browser-tests-executed.sh` checked membership with
`printf '%s\n' "$list" | grep -Fxq -- "$id"` under `set -o pipefail`, in
`is_quarantined` and in the "quarantined but did not run" loop. `grep -q`
leaves at the first match; when the list is longer than a pipe buffer, the
`printf` still writing it dies of SIGPIPE (141), and pipefail turns a found
test into a missing one. Both sites now read a here-string instead.

Seen locally (DOR-2021): 1 false red in 62 `pnpm test:scripts` runs under load
on 2026-11-17. No collected metric counts local suite outcomes, so the
hypothesis names the narrowest one that can see the same script in CI, the
fixtures gate's PR leg, and claims only that it does not get worse. The real
evidence is the new fixture case: a 200KB id list with the match on line one
red 5 times in 5 on the old code (each site alone reds it) and green 5 in 5
on the new.

No retry, skip, shard, worker cap, required check, steward or judge changes.
The gate is no looser: an id that is truly absent still reds (the existing
`qAbsent` and `qSkipped` cases). Revert if a quarantined test that did not run
ever passes the gate.
