---
id: 260912-025249
title: The session canvas is server-owned, and the localStorage slice is retired
status: proposed
created: 2026-09-12
spec: canvas-agent-seat
superseded-by: null
amends: null
---

# 260912-025249. The session canvas is server-owned, and the localStorage slice is retired

## Status

Proposed (extracted from spec `canvas-agent-seat`).

## Context

A session's canvas lives in one browser's `localStorage`, written as one JSON blob per session and
LRU-capped at 50 sessions (`app-store-helpers.ts:252-268`, `constants.ts:9, 16`). So two tabs on one
session hold two different tables, a phone opening the same session sees none of it, clearing browser
data loses it, and no agent can read it: `get_ui_state` answers from `session.uiState`, which is the
snapshot the client last sent with a message (`context-assembler.ts:165-166`) with this turn's
commands folded in optimistically (`ui-tools.ts:224`). `session-stream.ts`'s own comment states the
consequence — a `ui_command` is "never re-projected from a cold snapshot; cross-reconnect canvas state
is restored from localStorage". The room canvas (ADR `260911-200301`) already proved the server-owned
shape on the same table, whose `scope` column reserved `session:<id>` for exactly this.

## Decision

We will move a session's canvas into `canvas_documents` under a `session:<sessionId>` scope, served by
a scope-generic `CanvasService` in a new `services/canvas/` domain, with `RoomCanvasService` reduced
to the room's policy over it. A new `canvas` member of `SessionEventSchema` carries each change live —
it carries a `seq` like every other session event, is ingested through the projector every runtime
already feeds, and is therefore replayed gap-free on a resume, so it needs no whole-set resync of the
kind the room stream requires. `SessionSnapshot` gains the table, decorated in `deliverSessionStream`
rather than in four runtime adapters. The client store keeps its shape and writes through the
Transport; `readCanvasSession`, `writeCanvasSession`, `use-canvas-persistence.ts` and the storage key
are deleted, after a one-time import that runs only when the server table is empty and deletes the
local entry either way.

## Consequences

### Positive

- One canvas per session on every device, surviving reloads, cache clears and a new browser.
- The agent reads what the person sees rather than a guess about a copy, which is what makes
  `get_ui_state` and `read_canvas_document` honest.
- A whole persistence path is removed rather than doubled, and the storage-quota and 50-session LRU
  failure modes go with it.
- The room and session canvases become one implementation with one dedupe rule and one LRU.

### Negative

- A canvas change is now a network write, so a canvas mutation can fail where before it could not;
  the client must revert its optimistic apply and say so.
- `canvas_documents.room_id` becomes nullable and its indexes move to `scope`, which on SQLite means a
  table recreate — a migration that has to be read rather than trusted.
- The one-time import is a migration in the client, running on people's machines, and its idempotence
  rests on an emptiness check plus a delete rather than on a transaction.
- Adding a `canvas` service domain means editing the `AGENTS.md` census and the test that guards it.
