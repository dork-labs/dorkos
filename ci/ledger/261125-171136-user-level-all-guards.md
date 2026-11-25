---
id: 261125-171136
title: A user-level wrapper can give out-of-repo sessions all six PreToolUse guards in DorkOS (DOR-5285)
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Sessions homed outside this repo load none of `.claude/settings.json`; the user-level entry from #4415 gives them only
the heavy-command guard. `.claude/hooks/user-level-guards.sh` runs all six guards (file, git, process, merge,
pr-create, heavy) with the same DorkOS-only decision, and exits 0 silently in every other repository. Merging changes
nothing by itself: a user-level settings entry must point at it, which is the operator's decision (DOR-5285). Nov 25:
a helper homed outside the repo ran `git stash` in a DorkOS worktree. Revert if it ever refuses a command outside
DorkOS.
