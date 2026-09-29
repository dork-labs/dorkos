---
id: 260926-180308
title: A clean room worktree is fast-forwarded when its agent's turn launches; otherwise the turn is told what moved
status: accepted
created: 2026-09-26
spec: agent-home-desk
superseded-by: null
amends: [260829-115621]
---

# 260926-180308. A clean room worktree is fast-forwarded when its agent's turn launches; otherwise the turn is told what moved

## Status

Accepted (spec `agent-home-desk`; designed in #2153). Shipped in #2218 (DOR-2411): the launch-time
fast-forward behind `prepareLaunch`, the "what moved" heads-up for a held copy, and a copy left
alone (`held: unsafe-config`) while the room's shared git settings name a program. It builds on the
`prepareLaunch` hook added in #2197 (DOR-2410).

It amends **260829-115621**, which stays `accepted`: retired are the
Decision sentence "The server never reaches into a worktree" and the Alternatives bullet "The server
syncing worktrees for agents". Pull-based propagation stands for any worktree holding work.

## Context

Agents only see `main` move when they run `git merge main` themselves, so an agent with nothing in
progress still starts its next turn on old files. The room context only says "N commits behind" — not
who changed what, and not whether the agent's own work overlaps.

## Decision

We will fast-forward an agent's room worktree at the moment its room turn launches, before the runtime
is called, only when: no session bound to that (room, agent) has a turn running; the worktree is on its
own branch with no tracked or untracked changes and no commits `main` lacks; and no ignored or
untracked file sits at, inside, or above a path the fast-forward would touch. Otherwise the worktree is untouched, and
the turn's room context lists what moved on `main` since the branch point (first-parent history, named
from the room log) and any file the agent has also changed.

## Consequences

### Positive

- Agents that are not mid-work start on current files with no git ceremony.
- An agent that is mid-work is told what it is racing before a merge is refused `BEHIND_MAIN`.

### Negative

- The server now writes a worktree in one narrow case. The safety rests on git reads made at launch;
  a bug in any of them could move a tree that held work. Each is pinned by a negative test, including
  the ignored-file overwrite git itself allows.
- The refresh depends on a truthful "is any bound session busy" answer from the dispatcher.
- Diff baselines from earlier turns would misattribute moved files; the refresh forgets them.

## Alternatives rejected

- **Refresh by merging.** Can conflict and needs an author; that is the agent's job.
- **Refresh when the turn is placed.** A turn can wait behind another turn on the same session, and
  the files would move under it.
- **Refresh mid-turn.** Files would change under a running agent.

## Related

- `specs/agent-home-desk/02-specification.md` §6.
- `260829-115623` — the turn-start `ROOM.md` pin whose boundary the refresh shares.
