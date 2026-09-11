---
id: 260911-200301
title: A room's canvas is server-owned and rides the room stream as whole-document state
status: proposed
created: 2026-09-11
spec: room-canvas
superseded-by: null
amends: null
---

# 260911-200301. A room's canvas is server-owned and rides the room stream as whole-document state

## Status

Proposed (extracted from spec `room-canvas`).

## Context

A session's canvas lives in one browser's `localStorage`, keyed by session id
(`app-store-canvas.ts`, `app-store-helpers.ts`, `constants.ts:9`). Registering that same surface on
room routes would show each viewer their own private documents and call them shared, which is a demo
rather than a feature. A room's canvas has to be one thing that every member — and every agent — sees
the same way.

The room stream already carries three frame kinds. Two of them settled the shape of this question
before it was asked: an `entry` is durable and carries the reader's only cursor, and a `reaction` is
durable state that deliberately carries **no** `seq`, because "the cursor is the highest ENTRY this
reader holds… inventing one would put two numbers in one cursor" (`room-stream-delivery.ts:53-64`,
and `RoomReactionEventSchema`'s own reasoning at `room-schemas.ts:1929-1975`).

## Decision

We will keep a room's canvas documents in a server-owned `canvas_documents` table, scoped
`room:<roomId>`, cascading with the room, capped at twelve unpinned documents LRU with pins that
never evict — and we will publish changes as a fourth room-stream frame kind, `canvas`, modelled on
`reaction` rather than on `entry`.

A `canvas` frame carries the affected document's **whole current state** (or its id and `closed:
true`), carries **no `seq` and no `id:` line**, and is made gap-correct by two things: the cold
snapshot carries the entire table, and a stream resume re-sends every live document as a **canvas
resync**, the exact parallel of the reaction resync. Ordering between two frames for one document is
the row's own monotonic `rev`, which is explicitly not a stream cursor. Because a close is a deletion,
the resync is authoritative as a set: a client replaces its table from it rather than merging, which
is what makes a close missed while disconnected self-correct.

The `session:<id>` scope is reserved and never written by this work; migrating the session canvas is a
separate decision.

## Consequences

### Positive

- Every viewer of a room sees one table, on web, desktop and phone, and it survives a reload.
- An agent can read the same table a person is looking at, because there is a server-side truth to
  read.
- The room stream keeps exactly one cursor, so no client can mis-pack two numbers into
  `Last-Event-ID` and silently skip real messages.
- A reader that missed frames is correct after the next one it receives, and correct after a resume
  regardless of what it missed.

### Negative

- A second durable store to keep consistent with the client, and a resync path to keep in step with
  the reaction resync — the two are now parallel mechanisms that must not drift.
- The session canvas and the room canvas are two different stores until the follow-on spec migrates
  the first, so the same concept has two implementations for a while.
- Whole-document frames are larger on the wire than deltas would be; bounded by the twelve-document
  cap and the per-turn ceiling, and chosen deliberately because a delta stream cannot survive a gap.

## Alternatives rejected

- **Keep `localStorage` and add a room key.** Shared only by accident; the feature's entire premise
  fails.
- **Give the `canvas` frame a `seq` and replay it like an entry** (what the ideation proposed). It
  puts a second number in a one-number cursor — the mistake the reaction event's own design notes
  already talk a future reader out of.
- **Carry canvas state on `signal` frames.** Signals are lossy by design and never replayed; state
  needs the snapshot.
- **Tombstone closed documents.** Nothing needs them once a reconnecting viewer hydrates from a
  snapshot and a resync rather than from a delta log.
