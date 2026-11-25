---
id: 261125-181836
title: The release gate and the daily pick also require P's full unit run on main to be green
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.release-publish.gate
prs: []
ratchet-release: []
field-changes: []
---

#4257 moved the full unit sweep to a rolling push run on main, so P has its own full unit result, not only its
merge-queue build. `FULL_RUN_WORKFLOWS` (release-gate.sh, daily-release.sh and release-publish.yml's gate job) now
lists `browser-test.yml test.yml`: the daily pick takes the newest main commit with BOTH full runs green, and the gate
re-proves both. Measured before the change: the last 20 rolling `test` runs on main were 8 green, 0 red and 10
cancelled while pending (a newer push replaced them), so it will not stall the pick on its own. Revert if P goes stale
because the unit run is red or slow while the browser run is green.
