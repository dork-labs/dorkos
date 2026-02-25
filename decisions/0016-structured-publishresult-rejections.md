---
number: 16
title: Use Structured PublishResult Rejections for Reliability
status: proposed
created: 2026-02-24
spec: relay-advanced-reliability
superseded-by: null
---

# 16. Use Structured PublishResult Rejections for Reliability

## Status

Proposed (auto-extracted from spec: relay-advanced-reliability)

## Context

When rate limiting, circuit breakers, or backpressure reject a message, the system needs to communicate this to the caller. Two approaches were considered: (1) send rejected messages to the dead letter queue (DLQ) with a reason, following the existing budget enforcement pattern, or (2) return structured rejection information in the `PublishResult` without touching the DLQ. The DLQ is currently used for delivery failures — messages that were attempted but failed at the Maildir level.

## Decision

Reliability rejections are reported via a `rejected` array in `PublishResult` with typed reasons (`'rate_limited' | 'circuit_open' | 'backpressure'`). They do NOT go to the dead letter queue. The DLQ remains reserved for actual delivery failures (Maildir write errors, handler throws). A `mailboxPressure` field is also added to `PublishResult` for proactive capacity signaling.

## Consequences

### Positive

- Clean separation: DLQ = delivery failures, PublishResult = policy rejections
- No disk I/O for reliability rejections (no DLQ writes during sustained backpressure)
- Callers get immediate, structured feedback they can act on programmatically
- DLQ doesn't fill with noise from sustained backpressure events
- Proactive `mailboxPressure` metric enables cooperative throttling

### Negative

- No durable audit trail for rejected messages (transient information only)
- Different rejection path than budget enforcement (which does use DLQ)
- Callers must check `PublishResult.rejected` to detect reliability rejections
