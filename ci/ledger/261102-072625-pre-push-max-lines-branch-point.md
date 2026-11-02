---
id: 261102-072625
title: Pre-push max-lines compares with the branch point, not today's main
kind: hygiene
status: proposed
actor: agent
gates:
  - lefthook.pre-push.max-lines
prs: []
ratchet-release: []
field-changes: []
---

The pre-push `max-lines` check passed `--base origin/main`. Once main lowered a file's baseline after a branch was cut, the branch's older `baseline.json` read as raising it, and a push that touched none of those files was refused. That happened twice on 2026-11-02 (#3422, and #3418 before it). DOR-3643 moves it to `git merge-base origin/main HEAD`, the base `ledger-coverage` beside it already uses. On the stale #3422 head `4427638bf0`, the old base reports 5 problems and the branch point reports none.

A branch that really raises a baseline is still refused, because the check compares the branch's baseline with the one at its own branch point. CI's `typecheck` ratchet is unchanged. No new fetch and no new step. Revert if a raise ever gets past the branch point and is caught only in CI.
