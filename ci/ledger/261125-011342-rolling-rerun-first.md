---
id: 261125-011342
title: A rolling main run is bisected from its first failure, re-testing its head in its own run instead of a re-run
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.auto-revert.decide
  - wf.rolling-bisect.next
prs: []
ratchet-release: []
field-changes: []
---

Incident, Nov 25: browser-test's rolling push run on main failed at 7878dda (00:27Z, attempt 1).
rolling-bisect.yml started only on a push run that failed at attempt >= 2, after auto-revert's one
re-run. But `auto-revert.sh decide` checked the parent first and answered `skip
red-before-this-merge` (a rolling run's parent almost never has a completed run of its own), so it
never re-ran the failed jobs, attempt 2 never came, the bisect never started, and nobody was named.

Re-running first would not have been safe either: a re-run of an old push run has the same event and
ref as a new one, so it joins browser-test's `gate` concurrency group
(`browser-test-refs/heads/main-gate`), where it cancels the pending newest-main run or is cancelled
by the next merge (and then ends `cancelled`, which starts no bisect).

Now: `auto-revert.sh decide` answers `skip rolling` for every failed push run of a ROLLING workflow
(no re-run, no revert). rolling-bisect.yml starts on the first failure (its `if:` drops
`run_attempt >= 2`), and its first probe re-tests H in a dispatched bisect run, which has a
concurrency group of its own per merge. H passing is a flake (`inconclusive head-passed-on-re-test`,
one note, no culprit). H failing in the same job family is its second failure, and the bisect of the
range proceeds as before; a range of one merge is named by the probe alone. Non-rolling workflows keep
the re-run-once rule. The rolling list (`ROLLING_WORKFLOWS` in `auto-revert.sh`) is pinned by
`test-auto-revert.sh` to rolling-bisect.yml's `workflows:` and after-merge-alert.yml's ROLLING=1.

Measured through entry 261124-073000 (rolling bisect): its target needs this to start at all. Cost:
one extra full browser run per rolling failure (the probe of H), against the re-run it replaces.
Revert if a probe of H ever waits behind, cancels or delays a rolling push run.
