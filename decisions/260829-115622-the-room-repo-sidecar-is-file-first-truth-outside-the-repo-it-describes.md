---
id: 260829-115622
title: The room-repo sidecar is file-first truth, and it lives outside the repo it describes
status: accepted
created: 2026-08-29
spec: project-rooms
superseded-by: null
amends: null
---

# 260829-115622. The room-repo sidecar is file-first truth, and it lives outside the repo it describes

## Status

Accepted. Shipped 2026-08-28 (DOR-1591, DOR-1592).

## Context

Something has to record that a room has files: which room, in which mode, made by whom, under which
byte caps. Two questions had to be answered, and they are independent.

**Where does the truth live?** `rooms` already had a `workspace_id` column, added speculatively and read
by nothing (`specs/rooms/` §9 punted on its fate). Making it the binding record would have put the
whole fact in SQLite, where a rebuilt or restored database is the only record that a room's git history
belongs to anybody. ADR-0043 settled the same question for agents the other way: `.dork/agent.json` on
disk is the truth and the `agents` table is a cache the reconciler may delete and rebuild.

**Where does the record sit relative to the repo?** A room's repo holds member-written content. If the
record of the grant — the mode, the caps, who enabled it — sat inside the repo, then merging a file
could rewrite the terms under which merging is allowed. `specs/channel-workspace/` §3.1 reached this
conclusion first, for a repo that only distributed conventions; it is strictly more load-bearing for one
agents execute in.

## Decision

We will keep a **`room-repo.json` sidecar at `{dorkHome}/rooms/<roomId>/`, outside `repo/`**, as the
file-first truth for a room having files, with a thin `room_repos` table as a derived cache.

- **Write order is sidecar first, row second; delete order is row first, sidecar last.** In both
  directions the sidecar is the last word, so an interruption leaves a state a reconciler can heal
  rather than one where the truth vanished and a derived row is the only evidence a binding existed.
  This is deliberately the opposite of `WorkspaceStore.remove`'s ordering.
- **A reconciler rebuilds the rows from the sidecars** on the same five-minute cadence the mesh and
  workspace reconcilers use. An orphaned sidecar — a room whose row cascaded away while its directory
  did not — is counted, logged, and **left alone**. That directory holds the room's git history, every
  agent's unmerged work, and its attachments, and a missing row is not proof anybody asked for that.
- **The cache table is thin on purpose**: `room_id`, `mode`, `created_at`, `last_merge_seq`. The caps,
  the default branch and the enabling author live only in the sidecar, because git is most of the truth
  and no repo state of substance may live only in SQLite.
- **The caps are copied into the sidecar at creation.** Config seeds them; the sidecar remembers them, so
  a later config change cannot retroactively make an existing room's contents illegal.
- **`rooms.workspace_id` is dropped by migration** (`0081`). It was inert, and leaving a column that
  looks like this feature's record beside the record that actually is would be exactly the homonym
  `AGENTS.md` forbids.
- **`mode` carries the whole `'owned' | 'linked'` vocabulary and then refuses everything but `'owned'`.**
  Linked repos are designed for and not built, and keeping the name in the union is what lets a sidecar
  written by a later build be refused by name rather than with a shape error an operator has to decode.

## Consequences

### Positive

- A room's binding survives a database rebuild, a restore, and a cache wipe, because the fact lives next
  to the bytes it is about.
- A repo can never rewrite its own grant. Nothing a member merges can widen the caps, change the mode,
  or claim a different author for the enablement.
- An interrupted enable or delete is a healable state with a documented direction, not a coin flip.
- A room keeps the bounds it was made under, so tightening the global caps does not retroactively
  invalidate rooms that were legal when they were written.
- `specs/rooms/` §9's open question about `workspace_id` is closed by removing the column rather than by
  finding it a job.

### Negative

- Two stores to keep in agreement, and a five-minute window in which the cache can be stale. Every
  correctness-critical read therefore goes to the sidecar, and the row exists for listing and joins.
- An orphaned sidecar accumulates rather than being cleaned up. That is the deliberate trade — the
  destructive half belongs on the delete path, where the intent is — but it means a room home can
  outlive its room until an operator removes it.
- Caps frozen per room means two rooms on one install can enforce different ceilings, and reading the
  config no longer tells you what a given room will refuse.

## Alternatives rejected

- **Repurposing `rooms.workspace_id` as the binding record.** SQLite-only truth for a fact about files on
  disk, and it inherits a column name that means something else.
- **Putting the sidecar inside `repo/`.** It would make the grant editable by the thing it governs.
- **Deleting an orphaned room home during the sweep.** A restored backup and a bug look identical to a
  sweep, and the cost of being wrong is a room's entire history.
- **Refusing `'linked'` by omitting it from the enum.** A sidecar written by a later build would fail
  with a shape error instead of a sentence saying what is not built yet.

## Related

- `specs/project-rooms/02-specification.md` §3.1, §3.2; resolved question 4.
- ADR-0043 — file-first agent storage with a derived cache; the pattern this follows.
- `specs/channel-workspace/02-specification.md` §3.1 — where the sidecar-outside-the-repo argument was
  first made.
- `260829-115621` — the repo and worktree layout the sidecar sits beside.
