---
id: 260801-035912
title: A permission decision is recorded for every session, and overlaid back onto runtime-owned history
status: accepted
created: 2026-08-01
amends: 260731-211050
superseded-by: null
---

# 260801-035912. A permission decision is recorded for every session, and overlaid back onto runtime-owned history

## Status

Accepted. **Widens** [260731-211050](260731-211050-a-room-driven-claude-code-turn-leaves-a-record.md)
(a room-driven claude-code turn leaves a sparse record in `session_events`): `'record'` persistence
stops being a room-only opt-in and becomes what every non-log-backed session does, and the set of
events it keeps gains `interaction_resolved`. That ADR's shape — a mode, a constant number of rows
per turn, never a hydrate source — is unchanged and is what this reuses.

## Context

A tool-approval receipt (`specs/trust-dial/04-design-decisions.md` §4: the transcript is the audit
trail) is meant to be permanent: the one-line record of what an agent asked for and what the person
answered, sitting where the ask happened. As shipped in #675 it lasted exactly as long as a loaded
session. The reason is structural, not a bug: a permission prompt is raised, answered, and retired
entirely inside DorkOS, while completed history is runtime-owned. claude-code derives history from
SDK JSONL, which records that a tool ran or did not and nothing about anybody having been asked
first. Reopening a conversation therefore showed the tools with no sign they had ever been gated —
and a denied tool came back as a plain failure.

Two facts made this worse than a missing nicety. Ordinary claude-code sessions persisted **nothing**
to `session_events` (260710-024641's opt-out, narrowed but not removed by 260731-211050), so the
answer existed only in the browser tab that gave it. And the client-side carry that kept receipts
across the turn-end reconcile was, by construction, incapable of surviving a reload.

## Decision

**The answer is recorded on the server, and put back at the history read.**

1. `'record'` persistence keeps `interaction_resolved` alongside the turn boundaries and errors, and
   every turn-starting caller now selects its mode through one helper (`persistenceModeFor`):
   `'history'` when the runtime declares `logBackedHistory`, `'record'` otherwise. No session opts
   out. The rows stay a small constant per turn — no `text_delta` is ever written for claude-code —
   so 260710-024641's hot-path objection still does not transfer.
2. A log-backed runtime needs no overlay: `reconstructHistoryFromEvents` folds the resolution onto
   the tool call it gated, because for those runtimes the event stream IS the transcript.
3. For a runtime with its own transcript, `overlayApprovalReceipts` re-applies the recorded answers
   onto assembled history by tool-call id. It is composed in the adapter's `getMessageHistory` —
   the single point BOTH history consumers pass through (`GET /api/sessions/:id/messages` and the
   cold-open snapshot, which loads history through the same method). It is deliberately not inside
   `transcript-reader`, which owns JSONL parsing and must not learn about DorkOS interactions, and
   not at the route, which would have annotated the reload and left the cold open untouched. It
   cannot throw: it sits on a path that was a pure JSONL read, and `SQLITE_BUSY` on a machine
   running several agents must cost the annotations rather than the conversation.
4. One shared definition of what a resolution earns (`approvalOutcomeOf` in `@dorkos/shared`) is
   used by the client's live fold, the log-backed reconstruction, and the overlay, so a reopened
   conversation rebuilds the identical line rather than a similar one.

## Consequences

### Positive

- The receipt is permanent, which is what the design said it was. Reopening a conversation shows
  every ask and answer, including an expiry and how long it waited.
- Every session — not just room-driven ones — now leaves durable evidence that a turn ran and how it
  ended, which is DOR-784's legibility win generalised at no extra cost per turn.
- The client's carry stops being the mechanism and becomes a narrow patch over one window (see
  Negative), so a bug in it can no longer lose the record.

### Negative

- The answers are flushed when the turn ENDS. A turn that dies mid-flight loses the answers given
  inside it, and a history reload fired at the `blocked` edge (an approval answered while another is
  still pending) sees rows that do not exist yet. The overlay reads the live projector's OPEN turn
  to cover the second case; the client-side carry covers it too, and `approvalDisplayName` — the
  SDK's short label, which arrives on the pending request and is never recorded — remains
  client-only.
- The overlay matches by tool-call id, which is honest but not universal: OpenCode answers a
  `Permission.id` that is not any tool call's id, so its approvals annotate nothing and its history
  comes back unannotated rather than wrong.
- `session_events` now carries interaction rows for sessions whose history is read from elsewhere.
  Nothing folds them into history for those runtimes, and the mode a session enabled under is still
  the only thing that says what its rows are for.

### Costs and residual risks, named

- **A rename that fails to migrate strands the receipts before it.** Rows key by the id held at
  flush time and the overlay asks exactly one id, so a session the SDK renames — which it does on a
  resume, not only on the first turn — needs its rows moved with it. `rekeyProjector` does that
  (`SessionEventStore.rekeySession`, `UPDATE OR IGNORE`), and a failure is warned and swallowed
  because a broken rename is worse than missing annotations. The residual is therefore narrow and
  real: if that one statement fails (a locked database at exactly that moment), the decisions before
  the rename are stranded under the retired id and no later read finds them. `UPDATE OR IGNORE` also
  leaves a row behind rather than throwing if the target id already holds the same seq, which needs
  a rename ONTO an id that already has rows of its own — not something the SDK does.
- **Read-side cost, which the hot-path argument above does not cover.** That argument is about
  WRITES. This adds a read to every history load: one indexed, `LIKE`-filtered query for a session's
  resolution rows, plus a walk of the open turn when one exists. Both are deliberately narrow —
  `readAll` would materialize and JSON-parse up to 5,000 rows to find the two that matter, and
  `replayFrom(0)` would merge-and-sort the whole event log — but it is not free, and it runs once
  per turn-end reload for a transcript's whole life.
- **The table has no age-based expiry, on purpose, and no deletion path.** Rows are capped per
  session (the same `EVENT_LOG_MAX_EVENTS` trim), so the growth is with the NUMBER of sessions on
  the machine, unbounded over an install's life. Age-based pruning was considered and rejected as
  self-defeating: a receipt is meant to last as long as the conversation, so deleting rows at 90
  days would delete exactly what this decision promises, silently, from conversations a person can
  still open. The right bound is deletion-follows-session, and it cannot be wired today because
  DorkOS has no session-deletion path — `SessionEventStore.deleteSession` exists and its only caller
  is the test-reset control route. Filed as follow-up; until then the honest statement is that the
  table grows with session count and each session's share is capped.

## Relationships

- **Widens 260731-211050:** see Status.
- **Reuses 260710-024641 (durable session-event store):** the table, the turn-granular flush, the
  trim, and the `seq` counter restore are unchanged.
- **Implements `specs/trust-dial/04-design-decisions.md` §4** (the transcript is the audit trail),
  which #675 delivered for a live session only.
