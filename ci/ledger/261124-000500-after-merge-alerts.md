---
id: 261124-000500
title: A check that fails on main after merge comments on the PR and opens one issue per failure group
kind: hygiene
status: proposed
actor: agent
gates:
  - wf.after-merge-alert.alert
prs: []
ratchet-release: []
field-changes: []
---

Dorian, Nov 23 (DOR-5121): checks that rarely catch real failures move after merge, so their
failures must reach the author without anyone watching main. `after-merge-alert.yml` runs when a
push-to-main workflow finishes (scripts-test, CLI Smoke Test, Desktop Smoke, db-check today; more
as DOR-5125 moves checks). On a failure it comments once on the merged PR and opens or updates one
issue per workflow + job, labelled `after-merge-failure` and assigned to the author. On a pass it
closes that workflow's groups. The room ping stays with the red-main alarm.

Baseline (Nov 23): an after-merge failure reaches its author only if someone reads main's runs
(scripts-test red on main 83c296b6e4 was reported by hand).
Target: every after-merge failure on main gets its PR comment and issue within 10 minutes.
Evaluate: Nov 30, against the failed push runs on main that week.

Revert if it opens duplicate issues for one group, or comments on the wrong PR.
