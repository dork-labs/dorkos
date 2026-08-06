---
id: 260731-211050
title: A room-driven claude-code turn leaves a sparse record in session_events, never a history
status: accepted
created: 2026-07-31
amends: [260710-024641, 260726-170125]
superseded-by: null
---

# 260731-211050. A room-driven claude-code turn leaves a sparse record in `session_events`, never a history

## Status

Accepted. **Retires one clause of**
[260710-024641](260710-024641-durable-session-event-store.md) (Durable SQLite session-event store
for log-backed runtimes): "the **policy** (persist or not) is opt-in per session by the owning
runtime — claude-code opts out", together with the Negative bullet that restates it as an invariant
future runtime authors must keep ("claude-code must not persist"). Everything else in that ADR
stands — the table, the turn-granular flush, the trim, the hydrate-and-restore-`counter` behaviour
for log-backed runtimes, and the rule that the mechanism is shared while the policy is per-caller.

It also corrects one sentence of
[260726-170125](260726-170125-a-room-is-a-membership-scoped-durable-stream.md): "Claude Code — the
default runtime — never writes to `session_events`." The conclusion that ADR draws from it is
unaffected, and is the reason this decision is narrow: the room log is still a DorkOS-owned store,
and these rows are not it.

(2026-08-06 audit) Amended by 260801-035912: 'record' mode now applies to every session for permission-receipt permanence, not only room-triggered turns.

## Context

A room triggers an agent turn and then nobody watches it. Everywhere else in DorkOS a person is
holding `GET /api/sessions/:id/events` while the turn runs, so a failure is on their screen; a room
posts a message and the turn happens in the dark. On 2026-07-31 an agent went quiet in a room for
forty-one minutes and there was no way, afterwards, to tell whether its turn had run and failed,
been refused, or never started at all: `session_events` held zero rows, because the default runtime
is claude-code and 260710-024641 had claude-code opting out of that table entirely.

That opt-out was right for the reason it was written. claude-code's history is SDK JSONL, so
persisting its event stream would store the same conversation twice and put a write on the hot path
of every `text_delta`. What it did not anticipate is a caller that needs **evidence a turn
happened**, which is a different question from **what the turn said** and is answered by two events
rather than by hundreds.

## Decision

We will replace the per-session `persist: boolean` flag with a mode,
`ProjectorPersistenceMode = 'history' | 'record'`. `'history'` is 260710-024641's behaviour,
unchanged, for the log-backed runtimes. `'record'` is opted into by the room turn runner for a
claude-code session, and differs in exactly two ways: it flushes only the turn's boundary and error
events (`turn_start`, `turn_end`, `error` — three rows a turn, whatever the model said), and it
never hydrates the in-memory `EventLog` from the store. Both callers restore the `seq` counter past
the durable maximum on enable, because `appendTurn` is `INSERT OR IGNORE` on `(session_id, seq)` and
a projector that did not would flush onto seqs a previous process had used and lose the turn
silently.

Nothing reads `'record'` rows as history. `SessionStateProjector.buildSnapshot` takes its `messages`
loader by injection, and claude-code keeps passing the JSONL-backed one.

## Consequences

### Positive

- A room turn that fails leaves durable evidence naming what triggered it and how it ended — the
  one thing the 2026-07-31 incident could not produce.
- Cost is a constant per turn rather than a function of output length, so the hot-path objection in
  260710-024641 does not transfer: no `text_delta` is ever written for a claude-code session.
- The conversation is still stored once. JSONL remains the only history for claude-code, and the
  no-hydrate rule is what keeps it that way.

### Negative

- `session_events` now holds two kinds of rows with different meanings, and only the mode a session
  was enabled under says which. A reader that folded every row into history would be right for
  codex and wrong for a room-driven claude-code session.
- The first enable wins the mode, so a session opened under one mode keeps it for the process. This
  is safe only because the two callers are disjoint (log-backed runtimes ask for `'history'` on
  their own read paths; the room runner asks for `'record'` only when the runtime is not
  log-backed), which is an invariant held by convention rather than by the type.
- Disk grows for room-bound claude-code sessions where it previously did not, bounded by the same
  per-session trim.
- A room-driven session that a client resumes with a stale cursor now takes the cold snapshot
  rather than a replay, because the `EventLog` is deliberately empty. That is the correct outcome —
  a sparse replay would be a turn with its middle missing — but it is a behaviour change worth
  knowing.

## Relationships

- **Retires one clause of 260710-024641 (durable session-event store):** see Status. That ADR stays
  `accepted`; its mechanism is what this reuses.
- **Corrects one sentence of 260726-170125 (a room is a membership-scoped durable stream):** the
  claim that claude-code never writes to `session_events`. Its conclusion — that a room's record
  lives in a DorkOS-owned store and not in the session log — is untouched, and these rows are
  diagnostic rather than a room log.
- **Comes out of DOR-784** alongside the room-binding convergence work in the same change. That half
  keeps a room pointed at the session holding its conversation; this half makes a room turn legible
  after the fact. No ADR is filed for the first: following the projector's own rekey announcement is
  the mechanism 260710-024641's registry already publishes, not a new decision.
