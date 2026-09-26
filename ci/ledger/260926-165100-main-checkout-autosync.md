---
id: 260926-165100
title: Session start keeps the main checkout's main level with origin/main
kind: hygiene
status: proposed
actor: agent
gates: [claude.SessionStart.session-maintenance, wf.scripts-test.fixtures]
prs: []
ratchet-release: []
field-changes: []
---

Nothing in this repo moves local `main`: work lands through PRs and the merge
queue, worktrees branch from `origin/main`, and `git fetch` never touches
`main`. The main checkout sat 38 commits behind on 2026-09-26 while
`pnpm dev` and `pnpm dev:dogfood` served its stale tree.

`session-maintenance.sh` now calls `.claude/hooks/sync-main-checkout.sh`, which
fast-forwards the main checkout's `main` to the `origin/main` this clone
already has when a session starts (never on resume, `/clear` or compaction)
and it is behind with no tracked changes, warns in one line when it is dirty or
diverged, and starts a background fetch for the next session. It never waits
on the network (0.09s measured), reads status without taking `index.lock`, runs
one fetch at a time that gives up after a 20s stall (measured against a server
that never answers), and `git config dorkos.mainSync warn|off` pauses it per
clone. `scripts/test-sync-main-checkout.sh` pins every refusal beside the
fast-forward and runs in the `fixtures` job: a no-op hook fails 14 of its 41
checks, and removing any single guard fails at least one.

Hygiene, not an experiment: no gate timing or failure rate should move.
Revert if a fast-forward ever lands under someone's work, or set
`dorkos.mainSync warn` to keep the report without the move.
