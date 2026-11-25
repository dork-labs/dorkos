---
id: 261125-145904
title: A user-level hook holds sessions homed outside this repo to the heavy-command guard, in DorkOS only
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Sessions homed outside this repo (agent homes and the helpers they start) load none of `.claude/settings.json`, so
their heavy commands in DorkOS worktrees skipped the load gate. `.claude/hooks/user-level-heavy-guard.sh` is what a
user-level `settings.json` runs for every Bash call: it runs `heavy-command-guard.mjs` only when the payload cwd, or a
leading `cd`, is inside a checkout sharing this repo's git common dir, skips sessions homed in DorkOS (their project
hooks already guard them), and exits 0 silently everywhere else, so other repos on the Mac keep their own tsc and
vitest. The operator wires it into each Claude config dir; a running session keeps the hooks it read at start, so it
applies to sessions started after that (checked Nov 25 with Claude Code 2.1.330). Revert if it ever blocks a command
outside DorkOS.
