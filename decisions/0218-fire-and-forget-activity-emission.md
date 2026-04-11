---
number: 218
title: Fire-and-Forget Activity Event Emission
status: proposed
created: 2026-03-29
spec: activity-feed
superseded-by: null
---

# 0218. Fire-and-Forget Activity Event Emission

## Status

Proposed

## Context

Activity events are written as side effects of primary operations (e.g., after a Pulse run completes, after an adapter is added). If the activity write fails — due to a database error, schema issue, or disk problem — the question is whether the primary operation should also fail. Activity logging is an observability feature, not a data integrity requirement.

## Decision

`activityService.emit()` is fire-and-forget: it catches all errors internally, logs a warning, and never throws. Primary operations are never blocked or failed by activity tracking. The activity service is a best-effort audit trail, not a transactional guarantee.

## Consequences

### Positive

- Primary operations (schedule execution, adapter configuration, agent registration) are never degraded by activity logging failures
- Simpler error handling at instrumentation points — just call `emit()` and move on
- No risk of cascading failures from a corrupted or locked activity table

### Negative

- Activity events can be silently lost if the database is unavailable
- Gaps in the activity feed are possible (though warnings are logged for debugging)
- No guarantee of exactly-once event recording
