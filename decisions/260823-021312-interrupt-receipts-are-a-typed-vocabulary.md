---
id: 260823-021312
title: Every stop-shaped verb answers with a typed interrupt receipt, and DorkOS never settles a turn it did not observe end
status: accepted
created: 2026-08-23
spec: runtime-interrupt-receipts
superseded-by: null
amends: null
---

# 260823-021312. Every stop-shaped verb answers with a typed interrupt receipt, and DorkOS never settles a turn it did not observe end

## Status

Proposed — specified by `specs/runtime-interrupt-receipts/02-specification.md` (DOR-1303).

## Context

`AgentRuntime.interruptQuery` answered with a boolean, and every stop-shaped verb in the
product ended in it: the composer's Stop, a room's halt, a task run's stop, the stall
watchdog. That boolean was `true` both when the CLI acknowledged the stop and when DorkOS
gave up on the graceful path and killed the process, and `false` for three unrelated
endings — the turn had already finished, the runtime declined with the turn still running,
and the call threw. The adapter already knew the difference (`ControlAck` is a tri-state)
and discarded it at the route; the client then discarded what was left. So the cockpit
could only ever say "stop requested", a room halt said nothing at all, and OpenCode's
"I did not abort it" was indistinguishable from "it had already finished" (DOR-1299).
`MessageDeliveryOutcome` had already settled the shape of the answer for the sending half
of the same boundary (ADR `260816-143752`): report what was requested and what actually
happened, and never degrade in silence.

## Decision

**We will make every stop-shaped verb answer with one typed `InterruptReceipt` —
`acked | closed | not-running | unconfirmed | failed`, with an optional reason — and we will
never fabricate a turn ending DorkOS did not observe.** The receipt is produced by every
runtime adapter, gated by `runtimeConformance`, carried on the POST response and on a
durable `turn_stopped` session event so every window and every cold reload agree, and it is
the sole authority for whether the UI may say "stopped" rather than "stop requested".
`closed` — DorkOS ended the process itself — is a success with a cost named in words, not a
failure. When a runtime cannot confirm the stop landed (OpenCode's `abort` answering
`false`), DorkOS reports `unconfirmed`, leaves the turn open and keeps Stop pressable,
rather than settling a turn that may still be producing text.

## Consequences

### Positive

- The four distinctions a person needs after pressing Stop survive to the UI, on every
  runtime, instead of collapsing into one boolean at the route.
- One vocabulary covers session Stop, room halt and task stop, so the three cannot drift;
  a new adapter must map its stop into it to pass conformance.
- The durable `turn_stopped` event makes a stop a fact of the session rather than a fact of
  the window that pressed it: a second window learns of it, and a cold hydrate can draw a
  stop marker for a turn whose runtime transcript never recorded one — without writing
  synthetic transcript bytes (ADR-0310 holds).
- The pump's "a deliberate close is a crash" bug (DOR-1302) becomes a mapping, not a
  heuristic: the windower is handed the whole receipt instead of guessing at it.
- The vocabulary forces the runtimes to be honest about their own endings: codex's and
  opencode's aborts, which today settle as ordinary completions, must name an interrupted
  terminal reason for a receipt over them to be true.

### Negative

- A breaking interface and route change with no compatibility window: `interruptQuery`,
  `stopTask`, the interrupt response, the OpenAPI schema and the SSE protocol doc all move
  together.
- Five outcomes is a vocabulary future runtimes must fit; a sixth genuine ending would be a
  new decision, not a free-text field.
- `unconfirmed` deliberately leaves an unresolved state in front of the person — a turn that
  may or may not be running, with the button still live. That is more honest and less tidy
  than a fabricated end, and it will read as a rough edge on OpenCode until the sidecar
  offers a per-session force-abort.
- The receipt is derived from `ControlAck` rather than aliasing it, so the claude-code
  adapter now maintains two related vocabularies.
- Durability is bought by riding the turn rather than by a new flush path, so a receipt
  whose turn never ends before the process does is lost with the rest of that turn — and
  one outcome, `not-running`, is deliberately never persisted at all.
