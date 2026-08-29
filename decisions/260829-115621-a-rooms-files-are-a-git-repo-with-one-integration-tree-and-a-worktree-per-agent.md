---
id: 260829-115621
title: A room's files are a git repo with one integration tree and a standing worktree per agent
status: accepted
created: 2026-08-29
spec: project-rooms
superseded-by: null
amends: null
---

# 260829-115621. A room's files are a git repo with one integration tree and a standing worktree per agent

## Status

Accepted. Shipped 2026-08-28/29 (DOR-1591, DOR-1592, DOR-1596, DOR-1597).

## Context

A room is a place several agents work on one thing, and until this shipped it had no files. Everything
the members produced went into the conversation or into an attachment, so nothing could be a directory
tree, a script, or a codebase — the room could talk about work but could not hold it.

The obvious answer, one shared folder every member writes into, is the failure DOR-500 already cost us
in sessions: two agents mutating one tree corrupt each other, and the corruption is discovered late and
attributed wrongly. `AGENTS.md` states the rule the hard way — one checkout, one writer — and this repo
is itself the proof, because its own agents already collaborate through worktrees and a clean `main`.
The other obvious answer, one full clone per member, scales with the roster rather than with who is
actually working: a forty-member room would cost forty copies of the history.

There was also a shipped entity that looked like the answer and is not. `Workspace` (DOR-84) is a
sweepable unit-of-work checkout: provisioned per task, port-allocated, deleted when the work is done. A
room's files are the opposite kind of object — long-lived, like an agent's home.

## Decision

We will give a room that opts in **a git repo of its own** under the DorkOS data directory, laid out as
`{dorkHome}/rooms/<roomId>/repo/` with per-agent worktrees beside it in `worktrees/<agentSlug>/`, and we
will apply the DOR-500 boundary to it literally:

- **`repo/` is the integration tree and is never any agent's working directory.** The server is its only
  writer — merges and human saves. Its default branch is `main` and nothing else is created there.
- **Each participating agent gets one standing worktree on `room/<agentSlug>`**, created lazily on its
  first turn in that room and persisting across turns, so uncommitted work survives. Only that agent's
  turns run in it. Worktrees share one object database, so cost scales with active collaborators rather
  than with roster size.
- **Propagation is pull-based.** `main` advancing is instantly visible through the shared refs, but files
  change in an agent's tree only when that agent runs `git merge main` during its own turn. The server
  never reaches into a worktree.
- **The reap spares work rather than merely deferring to a timer.** A worktree is removed only when four
  independent gates agree: its agent is not mid-turn, git reports it neither dirty nor ahead of `main`,
  nothing in it was touched inside `rooms.repo.worktreeReapDays` (default 14), and `git worktree remove`
  and `git branch -d` both succeed without a force flag. A tree holding unmerged commits reports as
  `reapedTreeKeptBranch`, never as reaped.

We will **not** model this on `Workspace`. A room's repo is its own entity with its own store.

## Consequences

### Positive

- The one-writer invariant holds by construction. There is no code path in which two writers hold one
  tree, so the class of corruption DOR-500 named cannot occur in a room.
- An agent gets a full development loop — create, edit, delete, execute — in a directory that is only its
  own, using the tools it already has. Nothing new had to be taught.
- Cost tracks activity. A room with forty members and two active collaborators pays for two working
  trees.
- Work is never destroyed by a background sweep. Every gate has to agree, and each is read from git
  rather than from a DorkOS-maintained flag that could be stale.
- Losing an agent's membership does not lose its work: the worktree outlives the membership until it is
  clean, and is surfaced as stranded work until then.

### Negative

- Disk grows with active collaborators and is never reclaimed while anyone holds unmerged work. That is
  deliberate, and it means a room can accumulate stranded trees that only an operator can clear.
- Agents must now understand branches. Sync-before-edit is a real discipline, and an agent that never
  syncs keeps arriving behind `main` — the repeated-loser problem, bounded by convention rather than by
  a mechanism.
- Four reap gates are four things that can wrongly say "spare this", so the sweep is conservative by
  design and clutter outlives its window in the ambiguous cases.
- `worktreeReapDays` has a schema minimum of 1 for a load-bearing reason: a zero would make a
  just-created commit reapable, and the minimum is the only thing stopping it.

## Alternatives rejected

- **One shared folder every member writes.** The DOR-500 interleaving, reintroduced at room scale.
- **A full clone per member.** Cost scales with the roster, not with who is working.
- **Reusing the `Workspace` entity.** Workspaces are sweepable unit-of-work checkouts with port
  allocation and a `dork/<key>` branch; a room's files are long-lived. Borrowing the entity would have
  meant inheriting a sweep designed to delete.
- **The server syncing worktrees for agents.** It would make the server a second writer of a tree an
  agent may be mid-turn in, which is the invariant this decision exists to keep.

## Related

- `specs/project-rooms/02-specification.md` §3.1, §3.4, §3.5 — layout, worktree manager, cwd rung.
- `260829-115622` — the sidecar that records the binding, and why it sits outside the repo.
- `260829-115625` — merging is the only way an agent writes the integration tree.
- `260829-115626` — the server is the integration tree's only writer, and what happens when something
  else writes to it.
- ADR-0043 — file-first storage with a derived SQLite cache, the pattern the sidecar follows.
