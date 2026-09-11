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

A `ui_command` also reaches the session projector from three producers, and only one is a tool
handler: claude-code pushes it from `control_ui` (`ui-tools.ts:164`), **codex mints it in its event
mapper** because its `dorkos_ui` MCP server is session-less (`codex/event-mapper.ts:644`), and the
deterministic **test-mode** runtime yields one straight out of a scripted scenario
(`test-mode/demo-scenarios.ts:211-225`).

## Decision

We will keep the same `control_ui` verbs and route them by **turn context**, with
`RoomCanvasService.apply({ roomId, authorId, turnId, command })` as the **single writer and the
single enforcement point** — ceiling, refusals, dedupe and the archived-room rule all live in it —
reached by two callers.

**Caller one, synchronous: the claude-code `control_ui` handler**, when `session.roomTurn` is set. It
returns `apply`'s real result (the applied `documentId`, `rev` and the live viewer count, or the
refusal sentence) and only then pushes the `ui_command` event, stamped with a server-only
`applied: { documentId, rev }`. That stamp is data the client never reads; its only job is dedupe.

**Caller two, runtime-neutral: the `collectReply` tap** (`room-turn-runner.ts:1262-1400`), which
already reads every event of a room turn off the projector. It calls the same `apply` for every
`ui_command` carrying **no** stamp — codex, test-mode, and any future producer.

`session.roomTurn` is lifted out of the `room_context` additional-context entry exactly as
`session.uiState` is lifted out of the `ui_state` entry three lines away
(`claude-code-runtime.ts:476-480`) — **assigned unconditionally, including to `undefined`**, because a
marker that is set and never cleared would make every later direct turn in that session write to a
channel. It carries the room id, the agent's room author id and the turn's dispatch id, because
`apply` needs all three and none may be taken from the model.

Everything that is not one of the six canvas verbs is refused in a room, as an **allow-list** so a
twenty-third action is refused by default, with one plain sentence. Codex refuses through the seam it
already has — `isUiActionRefusedOnCodex` / `uiActionRefusalMessage` in `codex/ui-command-consent.ts`,
applied in `event-mapper.ts:631-640` — which gains a room-aware sibling rather than a second
mechanism.

Because `update_canvas` carries only `content` (`schemas.ts:5281-5284`) and `close_canvas` carries
nothing (`:5285`), while a room deliberately has no shared active document, both verbs gain an
**optional `documentId`** (additive; the session client ignores it when absent) and a stated default:
the author's **own** most recently opened-or-updated document in that room, persisted on the row so it
survives a restart, and a plain refusal when they have none.

## Consequences

### Positive

- Every existing skill and widget template works in a room the day this ships; nothing forks.
- The per-turn ceiling can actually refuse, because the enforcement point is reached synchronously by
  the call that answers the model.
- One writer, so the ceiling is spent once, the ordering is unambiguous, and a new producer inherits
  every refusal for free.
- Canvas routing stays runtime-neutral: claude-code, codex and test-mode all end at the same `apply`,
  which is what makes a deterministic end-to-end room-canvas browser test possible with no model
  spend.
- `apply_layout` — the one `reaches-the-machine` action — is refused in a room on both runtimes that
  have a refusal seam, so a room turn cannot reach a person's disk through the UI path.
- An operation that was not applied is not claimed applied anywhere: no row, no frame, no line in the
  turn's coalesced entry.

### Negative

- Two callers means a stamp, and a stamp means an optional field on an event schema that exists only
  for server-side bookkeeping. It has to be documented as "the client never reads this", and pinned
  by a test, or someone will read it.
- On codex and test-mode a ceiling refusal still cannot reach the model mid-turn; the honest
  guarantee there is narrower — unapplied means unclaimed — and the agent learns the table's real
  state from its next turn's context.
- `collectReply` gains a responsibility beyond collecting the reply, and three new fields on its
  `bounds`, which makes an already dense function denser.
- The room's default target ("your last document") is a piece of hidden state an agent has to be
  taught about; `get_ui_state` names it for exactly that reason.

## Alternatives rejected

- **The tap as the only writer** (this ADR's own first draft, rejected in adversarial review). The
  claude-code handler returns synchronously and the tap runs after the projector has already streamed
  the event, so a ceiling or a refusal there would contradict a success the model had already been
  given. `rooms.maxPostsPerTurn` only works because `postFromTool` is the same synchronous call that
  answers the model (`room-posting.ts:258-271`).
- **The handler as the only writer.** It serves one of three producers, and leaves codex and
  test-mode dark — including the test-mode path that makes the feature testable without spending.
- **New `room_canvas_*` verbs in the room capability domain.** It forks the vocabulary every skill and
  template already emits, to express a destination the turn already knows.
- **Predicting the document id from a pure function instead of returning the written row's id.** It
  worked only for content with a natural source key and had to omit the id for `json` and `widget`;
  with `apply` synchronous there is nothing to predict.
- **Making `documentId` required on `update_canvas`.** It is a breaking change to a shipped session
  verb for a room-only problem; optional plus a stated default costs nothing on the old surface.
- **Defaulting a bare `update_canvas` to the room's most recent document, whoever opened it.** It
  silently edits somebody else's work; the author's own last document is the only default that cannot.
- **Deriving the room from `clientId === 'dorkos-room'`** (`constants.ts:388`). It says a room turn is
  running and does not say **which** room, nor who the agent is in it.
