---
id: 260911-200303
title: A room turn's canvas commands are routed by turn context, at the session-event seam
status: proposed
created: 2026-09-11
spec: room-canvas
superseded-by: null
amends: null
---

# 260911-200303. A room turn's canvas commands are routed by turn context, at the session-event seam

## Status

Proposed (extracted from spec `room-canvas`).

## Context

A room turn is an ordinary session turn, and `control_ui` is registered on every claude-code session
(`claude-code/mcp-tools/index.ts:234`), so an agent in a room can already call `open_canvas`. The
command lands on that agent's private session stream, which the client drops unless the operator
happens to be viewing that exact session (`stream-manager.ts:1002`). Nothing shows, and the tool
reports success anyway.

Every skill, `ui/*.widget.json` template and teaching block in the product emits these verbs. A
second `room_canvas_*` vocabulary would fork all of it on day one.

A `ui_command` also reaches the session projector from three different producers, and only one of
them is a tool handler: claude-code pushes it from `control_ui` (`ui-tools.ts:164`), **codex mints it
in its event mapper** because its `dorkos_ui` MCP server is session-less
(`codex/event-mapper.ts:644`), and the deterministic **test-mode** runtime yields one straight out of
a scripted scenario (`test-mode/demo-scenarios.ts:211-225`).

## Decision

We will keep the same `control_ui` verbs and route them by **turn context**, and we will apply them
at the **session-event seam** rather than in any runtime's tool handler.

`collectReply` (`room-turn-runner.ts:1262-1400`) already reads every event of a room turn off the
projector. It gains one branch that applies canvas-shaped `ui_command`s to `RoomCanvasService`, counts
them against `rooms.maxCanvasOpsPerTurn`, and composes the turn's single coalesced entry when it
settles. **That tap is the only writer**, so there is no dedupe question to answer, and all three
producers above work unchanged — which is what makes an end-to-end room-canvas browser test possible
with a scripted test-mode scenario, no model and no credential.

The claude-code handler learns it is in a room from a new per-turn `session.roomTurn`, lifted out of
the `room_context` additional-context entry exactly as `session.uiState` is lifted out of the
`ui_state` entry three lines away (`claude-code-runtime.ts:476-480`) — **assigned unconditionally,
including to `undefined`**, because a marker that is set and never cleared would make every later
direct turn in that session write to a channel. The handler uses it for two things only: an honest
result (`{ target: 'room', roomId, documentId, viewers }`, where `documentId` comes from a **pure**
`canvasDocumentId(roomId, sourceKey(content))` so the handler can name it without writing), and
refusals. Everything that is not one of the six canvas verbs is refused in a room, as an **allow-list**
so a twenty-third action is refused by default, with one plain sentence; a refused command never
reaches the event queue. `get_ui_state` in a room answers about the room's table.

## Consequences

### Positive

- Every existing skill and widget template works in a room the day this ships; nothing forks.
- One writer, so the op ceiling is spent once and the ordering is unambiguous.
- Canvas routing is runtime-neutral by construction rather than per-adapter: claude-code, codex and
  test-mode all reach the same tap.
- The room canvas gets a free, deterministic end-to-end test, which is the difference between a
  covered feature and a demo.
- `apply_layout` — the one `reaches-the-machine` action — is refused in a room, so a room turn cannot
  reach a person's disk through the UI path.

### Negative

- The tool result's `documentId` is a prediction made by a pure function rather than a read of the
  row that was written. It is only correct as long as the two implementations of the source key agree,
  which is why a shared-case-table test pins them.
- Content with no natural identity (`json`, `widget`) has no predictable id, so those results omit
  `documentId` — an asymmetry a tool author has to know about.
- On codex and test-mode there is no handler to refuse a non-canvas action, so it lands harmlessly on
  a private session stream instead of being explained. The teaching block carries the explanation.
- `collectReply` gains a responsibility beyond collecting the reply, which makes an already dense
  function denser.

## Alternatives rejected

- **New `room_canvas_*` verbs in the room capability domain.** It forks the vocabulary every skill and
  template already emits, to express a destination the turn already knows.
- **Write in the claude-code `control_ui` handler.** It serves one of three producers, and it is the
  producer least in need of help — codex and test-mode would both stay dark.
- **Both write, with a dedupe stamp on the event.** It works and it is two writers, two orderings and
  two places the op counter can be spent, for no capability the pure id function does not already
  provide.
- **A `target` field on `control_ui`.** Reserved for the follow-on spec; the default has to be "the
  room this turn is running in" either way, and that is the whole of the common case.
- **Deriving the room from `clientId === 'dorkos-room'`** (`constants.ts:388`). It says a room turn is
  running and does not say **which** room, which is the fact the writer needs.
