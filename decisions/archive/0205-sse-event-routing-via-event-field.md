---
number: 205
title: Use SSE event Field for Multiplexed Stream Routing
status: archived
created: 2026-03-27
spec: sse-connection-optimization-01-consolidate
superseded-by: null
---

# 0205. Use SSE event Field for Multiplexed Stream Routing

## Status

Draft (auto-extracted from spec: sse-connection-optimization-01-consolidate)

## Context

When consolidating multiple SSE streams into one, the client needs a way to route events to the correct handler. Two approaches were considered: (1) using the SSE spec's built-in `event:` field for type discrimination, or (2) wrapping all events in a JSON envelope with a `type` field and routing by parsing the envelope.

## Decision

Use the SSE spec's `event:` field for routing. Each event retains its original event name (e.g., `tunnel_status`, `extension_reloaded`, `relay_message`). The `SSEConnection` class already registers handlers by event name via `EventSource.addEventListener(eventType, handler)` — this pattern works without modification.

## Consequences

### Positive

- Zero parsing overhead — browser handles event-name routing natively
- Matches the existing `SSEConnection` event handler pattern exactly
- SSE spec-compliant — no proprietary envelope format
- Simpler server code — `sendSSEEvent` already supports named events

### Negative

- Less flexible than a JSON envelope for metadata (e.g., timestamps, sequence numbers) — but these aren't needed for the current use case
- Adding new event metadata later requires changing the data payload rather than adding envelope fields
