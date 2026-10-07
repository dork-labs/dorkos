---
id: 261006-235241
title: Docs people and agents write together are Yjs documents; chat stays a server-ordered log
status: accepted
created: 2026-10-06
spec: null
superseded-by: null
amends: [0293, 260911-200301]
---

# 261006-235241. Docs people and agents write together are Yjs documents; chat stays a server-ordered log

## Status

Accepted (operator decision, 2026-10-06; Linear DOR-2735). Direction: live shared docs are the last after-launch step, so today's canvas still saves whole documents.

**Amends** (each stays Accepted):

- [0293](0293-canvas-persistence-editor-owns-document-host-owns-file.md): retires, for docs edited together, the negative consequence "surfaces conflicts to the user (Reload or Overwrite) rather than auto-merging … not a CRDT". Editor-owns-the-document, host-owns-the-file, boundary checks and atomic writes stand.
- [260911-200301](260911-200301-a-rooms-canvas-is-server-owned-and-rides-the-room-stream.md): retires whole-document state as the way a shared doc's text changes travel. The server-owned `canvas_documents` table, the no-`seq` canvas frame and the resync stand for every other document kind, and for a doc's place on the table.

## Context

Shared docs today are whole files. Two writers, a person and an agent or two agents, take turns: the second save gets a 409 and a Reload-or-Overwrite banner. That works for one person watching one agent. It does not work for a team of people and agents drafting a plan together, which is a core use of a workspace.

## Decision

We will make docs that people and agents write together **live documents using Yjs**, a CRDT (a data type that merges edits from many writers without conflicts). People and agents edit the same doc at once. **Chat does not use a CRDT**: rooms and threads stay a server-ordered log. Where the Yjs endpoint runs and how docs are stored is left to the spec.

## Consequences

### Positive

- People and agents can edit the same doc at once, with no lost work and no conflict banner.
- Chat keeps the simple ordering and cursors it already has.

### Negative

- A second sync model beside the ordered log, with its own storage, compaction and access checks.
- Plain files on disk are no longer the only truth for a shared doc; writing a doc back to a file needs an explicit export.
- The editor needs a Yjs binding, which ties the editor choice to Yjs support.
