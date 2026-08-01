---
id: 260801-035912
title: A permission decision is recorded for every session, and overlaid back onto runtime-owned history
status: accepted
created: 2026-08-01
supersedes: null
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
   not at the route, which would have annotated the reload and left the cold open untouched.
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

- Disk grows for every claude-code session, where previously only room-driven ones wrote rows.
  Bounded by the same per-session trim, and constant per turn.
- The answers are flushed when the turn ENDS. A turn that dies mid-flight loses the answers given
  inside it, and a history reload fired at the `blocked` edge (an approval answered while another is
  still pending) sees rows that do not exist yet. The client-side carry still covers that window,
  and `approvalDisplayName` — the SDK's short label, which arrives on the pending request and is
  never recorded — remains client-only.
- The overlay matches by tool-call id, which is honest but not universal: OpenCode answers a
  `Permission.id` that is not any tool call's id, so its approvals annotate nothing and its history
  comes back unannotated rather than wrong.
- `session_events` now carries interaction rows for sessions whose history is read from elsewhere.
  Nothing folds them into history for those runtimes, and the mode a session enabled under is still
  the only thing that says what its rows are for.

## Relationships

- **Widens 260731-211050:** see Status.
- **Reuses 260710-024641 (durable session-event store):** the table, the turn-granular flush, the
  trim, and the `seq` counter restore are unchanged.
- **Implements `specs/trust-dial/04-design-decisions.md` §4** (the transcript is the audit trail),
  which #675 delivered for a live session only.
