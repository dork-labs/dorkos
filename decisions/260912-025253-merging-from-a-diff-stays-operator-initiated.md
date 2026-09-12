---
id: 260912-025253
title: Merging from a diff stays operator-initiated and server-mediated
status: proposed
created: 2026-09-12
spec: canvas-agent-seat
superseded-by: null
amends: null
---

# 260912-025253. Merging from a diff stays operator-initiated and server-mediated

## Status

Proposed (extracted from spec `canvas-agent-seat`).

## Context

`specs/project-rooms/` left "PR-style review gates" as follow-up P4. Every part now exists: a room
canvas row records which tree a document came from and how far ahead of main it is
(`treeKind`, `aheadOfMain`), the diff-review feature already renders a two-document comparison with a
per-chunk gutter and writes rejections through an optimistically-concurrent file write, and
`RoomMergeService.merge` already holds the room's mutex, runs the symlink-escape, file-size and
repo-cap refusals, and posts a line that wakes nobody. The temptation is to let an agent complete the
loop — review its own diff and merge — or to run the merge in the client where the diff already is.

## Decision

We will render a worktree-backed `diff` document as worktree-versus-main, put a "Merge into the room"
action on the diff header **for the operator only**, and have it call the existing server-mediated
`RoomMergeService.merge`. Per-hunk reject writes to the agent's own working copy through the ordinary
file path, against the row's stored `resolvedCwd`. Agents gain no new merge verb. When the worktree is
behind main, the merge service's own refusal sentence is shown and the button is not, and the operator
is told to ask the agent to catch up rather than to run git in somebody else's working copy.

## Consequences

### Positive

- Review and merge become one flow, in the panel, out of parts that already work and are already
  tested.
- The merge keeps every guarantee it has: one writer under the room's mutex, its own escape and size
  refusals, and a line that triggers nobody.
- No git runs in the client, and no new merge path exists to keep consistent with the old one.
- An agent cannot approve its own work, because the affordance is not reachable from a tool.

### Negative

- The review gate is only as good as the operator's attention; nothing here enforces that a diff was
  read before it was merged.
- "Accept" remains a client-side dismissal that writes nothing, so accept-then-merge and
  reject-then-merge are asymmetric operations that look alike in the interface.
- The merge acts on the whole branch, not on the hunks shown, so a diff the operator scrolled past is
  merged along with the one they read.
- It depends on the room-canvas client landing first, which puts this behind a phase in another spec.
