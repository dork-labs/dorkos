---
id: 261120-144920
title: Worktree janitor never prunes the shared pnpm store
kind: hygiene
status: proposed
actor: agent
gates: []
prs: []
ratchet-release: []
field-changes: []
---

Comment only, no behavior change. A hand-run disk cleanup on 2026-11-20 ran `pnpm store prune` while lanes were active. Every worktree shares one store, so the next install in each live worktree downloaded everything again: about 12 GB, more than the cleanup had freed. The janitor's header now says never to add it there or run it by hand while lanes are active. Revert only if the janitor ever owns a store prune that first checks no lane is active.
