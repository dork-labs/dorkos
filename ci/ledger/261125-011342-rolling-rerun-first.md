---
id: 261125-011342
title: A rolling main run's first failure is re-run before the parent rule, so its bisect can start
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
rolling-bisect.yml starts only on a push run that failed at attempt >= 2, after auto-revert's one
re-run. But `auto-revert.sh decide` checked the parent first and answered `skip
red-before-this-merge` (a rolling run's parent almost never has a completed run of its own), so it
never re-ran the failed jobs, attempt 2 never came, the bisect never started, and nobody was named.

Now `decide` answers `rerun` for a failed push run on main of a ROLLING workflow at attempt 1 before
any rule about its head commit (subject, PR, parent). After the re-run fails it decides as before,
which mostly skips, and rolling-bisect.yml names the culprit and reverts it through `auto-revert.sh
revert` while `AUTO_REVERT` is on. Non-rolling workflows keep today's order (re-run only when the
parent was green). The rolling list (`ROLLING_WORKFLOWS` in `auto-revert.sh`) is pinned by
`test-auto-revert.sh` to rolling-bisect.yml's `workflows:`, auto-revert.yml's `workflows:` and
after-merge-alert.yml's ROLLING=1, so adding a rolling workflow in one place and not the others fails
the fixtures.

Measured through entry 261124-073000 (rolling bisect): its target needs this to start at all.
Revert if a rolling run's re-run ever cancels or delays a newer rolling push run in browser-test's
`gate` concurrency group.
