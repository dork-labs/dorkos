---
id: 260926-141755
title: A hard usage limit is a field on the session status, not a new lifecycle value
status: draft
created: 2026-09-26
spec: claude-account-fleet
superseded-by: null
---

# 260926-141755. A hard usage limit is a field on the session status, not a new lifecycle value

## Status

Draft (auto-extracted from spec: claude-account-fleet)

## Context

When an account hits a hard limit the session silently stopped. The session needs to say it is limited and when it resets.

## Decision

- `SessionStatus` gains `limit: { accountId, window, resetsAt, since } | null`, cleared at the next turn.
- `SessionLifecycle` is not extended; the turn settles to `error` as any failed turn does, and `sessionDisplayState()` reads `limited` off the field.
- The CLI's own limit notice is shown as an uncategorised error, the same on live and reload.

## Consequences

- Positive: older clients keep parsing snapshots; no exhaustive-switch churn across the client.
- Negative: consumers must call `sessionDisplayState` to see `limited` rather than reading `lifecycle` alone.
