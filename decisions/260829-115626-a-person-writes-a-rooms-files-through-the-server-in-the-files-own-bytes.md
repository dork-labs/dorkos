---
id: 260829-115626
title: A person writes a room's files through the server, in the file's own bytes, and an outside edit stops everything loudly
status: accepted
created: 2026-08-29
spec: project-rooms
superseded-by: null
amends: null
---

# 260829-115626. A person writes a room's files through the server, in the file's own bytes, and an outside edit stops everything loudly

## Status

Accepted. Shipped 2026-08-29 (DOR-1600, DOR-1601). This record carries the amendment to
`specs/project-rooms/` ideation Decision 17 and §3.10 made at implementation on 2026-08-29.

## Context

Agents write a room's files by merging from a worktree. A person should not have to. Fixing a typo in
`ROOM.md` is doc-sized work, and making it cost a branch, a commit and a merge would mean nobody does it.

But the room's integration tree already has exactly one writer, and that invariant is what makes the
whole design safe. Giving a person a worktree would add a writer who is not a turn, cannot be serialized
by the turn machinery, and has no session to attribute the work to.

Two further problems only became visible once the editor was real.

**The obvious editor was the wrong one.** DorkOS already has a markdown editor: the session canvas, which
edits through Blintz and therefore round-trips the document through ProseMirror's model. A room repo
exists for per-line provenance and honest diffs, and `ROOM.md` is read verbatim by every member agent
under a byte cap. Opening a file in the canvas and saving it could commit a wholesale reformat under a
person's name that they never typed and cannot see.

**The integration tree is on the operator's own machine, and nothing physically stops a text editor.**
A server that discovered a dirty `main` mid-merge could either guess at what the stray changes meant or
stop. Guessing is how a shared history gets corrupted quietly.

## Decision

We will let a person save a room's file through **`PUT /api/rooms/:id/files/content`**, serialized behind
the same mutex merges use, committed to `main` **authored as that person** ("Dorian edited ROOM.md").
The server remains the tree's only writer; the person's save is a request to it, not a write of their own.

- **Humans get no worktrees.** One save is one commit.
- **The route is people-only.** An agent calling it is refused `PEOPLE_ONLY` rather than 404, because it
  is already a visible member — merging is its write path, and this one is not.
- **Optimistic locking is on the file's own path, not on `main` moving.** The request carries the commit
  it was loaded at; the save is refused `FILE_CHANGED` only if `main` moved _and touched that path_. The
  refusal names who got there first and what they said they were doing, and offers the two honest
  choices: open their version, or save yours over it. Never a silent overwrite, and never silently
  discarding what the person typed.
- **The editor edits the file's own source text.** Byte fidelity outranks editor reuse here, so the room
  file editor is a source editor and not the canvas's rich editor. It is markdown-first: other text types
  are read-only for now.
- **A dirty integration tree stops both write paths loudly.** Any server git operation that finds `repo/`
  dirty, or on a branch other than `main`, refuses with `MAIN_CHECKOUT_DIRTY`, pauses merges and saves,
  and surfaces a room-level warning naming what changed. **DorkOS will not move a branch it did not
  move**, in case there is work on it.
- **The repair is an operator action with two named outcomes**, and no third: commit the stray changes as
  the operator, or discard exactly the files the operator ticks. Discarding is confirmed and says the
  change cannot be brought back. Nothing is corrected quietly.

## Consequences

### Positive

- A person can fix a room's file in the app, and the room can still say exactly who wrote every line.
- The one-writer invariant survives contact with human editing, because the human is not a writer — the
  server still is.
- A save never silently loses somebody's work in either direction. The conflict is a choice presented to
  the person who is standing there, with the other author named.
- A committed diff shows what the person actually changed. No reformat rides along under their name, and
  `ROOM.md` reaches agents as the bytes its author typed.
- An out-of-band edit becomes a visible, repairable state with two clear exits, instead of a merge that
  silently swallowed changes nobody meant to commit.

### Negative

- Editing is markdown-only today. Every other text file in a room is read-only in the app, which is a
  real limitation a reader will hit.
- Locking per path rather than per tree means two people editing different files never conflict — correct,
  and it also means a save can land on top of a `main` the person never saw.
- A dirty integration tree blocks **every** agent's merge in that room, not just the affected file. The
  blast radius of one stray edit is the whole room, deliberately.
- The repair panel is the only exit, and it is operator-only. A room whose owner is away is a room whose
  agents cannot merge.
- Refusing to reuse the canvas means two markdown editors exist in the product, with different
  capabilities, and a person will notice.

## Alternatives rejected

- **Giving people worktrees.** Branch ceremony for a typo, and a second writer of a tree the turn
  machinery cannot serialize.
- **Reusing the session canvas editor.** Its round-trip rewrites a document into its own spelling and
  attributes that to the person — the exact opposite of what a provenance-carrying repo is for.
  Adversarial review ruled for byte fidelity, reversing the original Decision 17.
- **Locking on `main`'s tip.** Every unrelated merge would invalidate an open editor, and the refusal
  would carry no information about the file being edited.
- **Last-write-wins.** Silent data loss, which is the one outcome a room built on provenance cannot have.
- **Auto-committing or auto-discarding a dirty `main`.** Both guess at intent; one of them is
  unrecoverable.
- **Moving the branch back to `main` automatically.** A branch DorkOS did not create may hold work, and
  moving off it would strand that work with no record of why.

## Related

- `specs/project-rooms/02-specification.md` §3.10 (amended 2026-08-29); ideation decisions 17, 18.
- `260829-115625` — the agent write path and the mutex both share.
- `260829-115621` — the one-writer boundary this preserves.
