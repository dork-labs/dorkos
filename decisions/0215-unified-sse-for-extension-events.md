---
number: 215
title: Unified SSE Stream for Extension Events
status: accepted
created: 2026-03-29
spec: linear-issue-status-extension
superseded-by: null
---

# 0215. Unified SSE Stream for Extension Events

## Status

Accepted

## Context

Server-side extensions need to push real-time events to browser clients (e.g., "issues updated"). Two approaches: per-extension SSE endpoints (`/api/ext/{id}/events`) or piggyback on the existing unified SSE stream (`EventFanOut` → `/api/events`). HTTP/1.1 browsers cap concurrent connections at 6 per origin — each SSE connection consumes one.

## Decision

Extension events flow through the existing unified SSE stream via `EventFanOut.broadcast()`. Events are namespaced as `ext:{extensionId}:{eventName}`. No new SSE connections needed. Client-side extensions filter by their ID prefix.

## Consequences

### Positive

- Zero additional SSE connections — no risk of exhausting the HTTP/1.1 connection pool
- Reuses existing `EventFanOut` infrastructure (heartbeat, client tracking, cleanup)
- Consistent with how `extension_reloaded` events already flow through the unified stream (ADR 206)
- Simpler server implementation — no per-extension SSE endpoint management

### Negative

- All extension events flow through one stream — noisy extensions could produce high-frequency events (mitigated: rate limiting can be added per-extension in v2)
- Client must filter events by prefix (trivial string comparison)
- No back-pressure per extension — one slow client blocks all extension events (same limitation as existing SSE)
