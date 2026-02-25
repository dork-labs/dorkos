---
number: 18
title: Use Server-Side Subject Filtering for Relay SSE Streams
status: proposed
created: 2026-02-24
spec: relay-server-client-integration
superseded-by: null
---

# 0018. Use Server-Side Subject Filtering for Relay SSE Streams

## Status

Proposed (auto-extracted from spec: relay-server-client-integration)

## Context

The Relay SSE stream (`GET /api/relay/stream`) delivers real-time message events to connected clients. Clients may only care about a subset of subjects (e.g., `relay.agent.backend.*`). Two approaches were considered: (1) stream all events and let the client filter, or (2) accept a subject pattern query parameter and filter server-side before sending SSE events.

## Decision

Use server-side subject filtering via a `?subject=pattern` query parameter on the SSE endpoint. The server registers one `RelayCore.subscribe(pattern)` per SSE connection, so only matching events are sent over the wire. When no pattern is provided, the wildcard `>` is used to stream all events.

## Consequences

### Positive

- Reduces bandwidth — clients only receive events they care about
- Leverages RelayCore's existing NATS-style pattern matching (wildcards `*` and `>`)
- Simpler client code — no need to filter incoming events
- Scales better with many concurrent clients watching different subject trees

### Negative

- Changing the filter requires reconnecting the EventSource (new URL)
- Server manages one subscription per SSE connection (memory overhead per client)
- Pattern validation must happen server-side to prevent invalid subscriptions
