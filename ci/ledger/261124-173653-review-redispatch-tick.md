---
id: 261124-173653
title: review-redispatch ticks after each push instead of sleeping on a runner
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.review-redispatch.redispatch
prs: []
ratchet-release: []
field-changes: []
---

Follow-up to ledger 261124-161126 (#4286), which measures the result through
`tracked.timed-slot-misses`. #4286 woke `review-redispatch.yml` after a failed review and had a
`wait` job sleep on a runner until the retry ladder's next rung, for up to 45 minutes per failure.
Runners are the scarcest resource now (queue builds wait 4 to 7 minutes for one), and a quota
outage would fail many reviews at once and park many runners. Instead the scan ticks on
`workflow_run` of CLI Smoke Test on main, after every push (about every 16 minutes on a working
day). The ladder decides skip or retry, and the scan's job-level concurrency group collapses ticks.
The `claude-code-review` trigger and `review-redispatch-wait.sh` are gone.

Revert to a timed wait only if failed reviews on a day with pushes still go more than 15 minutes
past their rung without a scan.
