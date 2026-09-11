---
id: 260911-200302
title: A canvas change never triggers a turn
status: proposed
created: 2026-09-11
spec: room-canvas
superseded-by: null
amends: null
---

# 260911-200302. A canvas change never triggers a turn

## Status

Proposed (extracted from spec `room-canvas`).

## Context

Giving a room a shared canvas creates a new class of event — "somebody changed the table" — and the
obvious thing to do with a new event is to wake people with it. The only thing that starts another
agent's turn in a room today is a committed `room_entries` row, so adding a canvas trigger would be a
deliberate second one.

Over-participation, not silence, is the failure users complain about (`meta/agent-etiquette.md`, E7:
silence must be free). The room already has the precedent for shared state that changes without
waking anyone: a merge moves the room's `main` and is announced as a durable, unaddressed, system-
voiced entry that triggers no turn (ADR `260829-115625`).

## Decision

We will make a canvas change reach other members through exactly three channels, none of which
triggers a turn, and we will add no fourth.

1. **A `canvas` section in every turn's room context** — each document's id, type, title, author,
   pinned flag and last change, plus the live viewer count. Document **content is never inlined**; an
   agent that wants it calls `read_canvas`. Free to receive, costs a few hundred tokens at the
   twelve-document ceiling, and wakes nobody.
2. **One coalesced room entry per turn** — "Ana opened the diff of `src/router.ts` and a preview of
   localhost:5173" — carrying a structured `canvas` body beside the existing `moment` and `merge`
   bodies. Durable, visible in history, addressed to nobody, mentions nobody, triggers nothing.
   **One per turn regardless of how many operations ran** (E17), and none for a turn that changed
   nothing.
3. **An ordinary `@mention`** in the agent's own reply when it actually wants somebody to look. That
   is the existing wake mechanism and it needs nothing new.

The coalesced entry takes the **merge** shape rather than a notice code, because notice codes are
refusal-shaped and deliberately damped, and a damped per-change event is a change nobody hears about.

## Consequences

### Positive

- A room can have a busy table and a quiet conversation at the same time, which is the outcome the
  etiquette document exists to produce.
- No agent pays for another agent's canvas activity: listening costs one bounded context section.
- The history still records what happened, so a person scrolling back sees the table's story.
- Asking for attention stays one mechanism — a mention — rather than two with different semantics.

### Negative

- An agent that puts something important on the table and says nothing is invisible until somebody's
  next turn. The teaching block has to tell agents to mention when it matters, and some will not.
- A person who is not looking at the room learns nothing in real time; the canvas is not a
  notification surface and will occasionally be wanted as one.
- "Coalesced per turn" means a turn that opened three documents produces one line, so the log is a
  summary rather than a transcript of the table.

## Alternatives rejected

- **A canvas change as a room trigger reason with its own dials.** It charges every member for
  listening and turns an active table into a cascade — the failure mode the room bounds exist to
  prevent.
- **One notice per operation.** Batching per turn is E17; per-operation is a running commentary.
- **Routing the announcement through notice codes.** Notices are damped by design; the merge ADR
  already established why per-change content must not ride a damper.
- **Inlining document content into the room context.** It is the largest prompt-injection surface in
  the feature and the largest per-turn cost, for something an agent can fetch on demand.
