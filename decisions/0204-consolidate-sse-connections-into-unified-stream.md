---
number: 204
title: Consolidate SSE Connections into Unified Event Stream
status: accepted
created: 2026-03-27
spec: sse-connection-optimization-01-consolidate
superseded-by: null
---

# 0204. Consolidate SSE Connections into Unified Event Stream

## Status

Accepted

## Context

The DorkOS client opens 4-5 persistent SSE connections per tab (tunnel, extensions, relay, session sync, plus the active message stream). Browsers limit HTTP/1.1 to 6 connections per origin. When all slots are consumed, HTTP requests (tool approvals, API polling) are queued by the browser and never reach the server, causing 30-second timeouts and a frozen UI. The `EventSource` API is inherently HTTP/1.1-only — even with HTTP/2 on the server, EventSource connections don't multiplex.

## Decision

Consolidate the 3 global SSE connections (tunnel, extensions, relay) into a single `GET /api/events` endpoint. The server fans out events from existing EventEmitters into one stream, using the SSE spec's built-in `event:` field for type discrimination. The client creates one `SSEConnection` instance at the app shell level and routes events to consumers by name. The session-scoped sync stream stays separate. This reduces persistent connections from 4 to 2.

## Consequences

### Positive

- Directly fixes the tool approval timeout bug by freeing 2 connection slots
- Reuses all existing infrastructure (SSEConnection class, stream-adapter helpers, EventEmitter patterns)
- No new dependencies required
- Single connection point simplifies resilience (one reconnection, one heartbeat, one visibility optimization)

### Negative

- All event types are sent to all clients regardless of whether they need them (acceptable given low volume)
- Single point of failure — if the unified stream disconnects, all three event sources are affected simultaneously (mitigated by SSEConnection's existing reconnection logic)
- Old endpoints must be deprecated carefully if external consumers use them directly
