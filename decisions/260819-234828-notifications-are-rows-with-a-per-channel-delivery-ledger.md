---
id: 260819-234828
title: Activity notifications are SQLite rows with a per-channel delivery ledger; standing attention stays derived and is stored only on resolution
status: accepted
created: 2026-08-19
spec: notification-system
superseded-by: null
---

# 260819-234828. Activity notifications are SQLite rows with a per-channel delivery ledger; standing attention stays derived and is stored only on resolution

## Status

Accepted 2026-08-22 — implemented across DOR-1383..DOR-1391 (PRs #1146–#1155).
The `notifications` and `notification_deliveries` tables live in
`packages/db/src/schema/notifications.ts`; the service in
`apps/server/src/services/notifications/`.

## Context

An Inbox needs history, read state, and "did this reach me?" — none of which a
purely derived model can answer. But DorkOS's standing "needs you" state (asks,
parked schedules, errors) is already derived correctly from domain stores with
addressed SSE, and duplicating it into rows would create two sources of truth
for the most safety-critical state in the app. Escalation ("get louder if
unacknowledged") requires knowing per channel whether a notification was sent,
seen, or acted on — the piece notification systems skip early and regret.

## Decision

Activity notifications persist as rows in a `notifications` SQLite table
(prune-on-write: 30 days / 1000 rows), each with `notification_deliveries`
ledger rows per channel (`sentAt` / `seenAt` / `actedAt`). Standing Attention
kinds are never stored while pending — they remain derived from the existing
interaction/task stores — and the service writes a single history row at
resolution carrying the outcome (answered, expired, approved, rejected). The
escalation service is driven by the ledger and domain resolution events, not by
a parallel state machine.

## Consequences

### Positive

- One source of truth per state: domain stores for standing, rows for history.
- Read state and lenses (per-agent, per-session) are trivial queries.
- The ledger makes escalation, "seen on desktop, not on phone", and future
  digest logic possible without re-architecture.

### Negative

- Two storage disciplines to understand (derived-while-standing vs
  row-on-event) — the registry documents which each kind uses.
- Prune-on-write means old history is genuinely gone (accepted for a
  single-operator local tool).
