---
number: 207
title: Invalidate TanStack Query Caches on SSE Reconnect
status: accepted
created: 2026-03-27
spec: sse-connection-optimization-02-fetch-transport
superseded-by: null
---

# 207. Invalidate TanStack Query Caches on SSE Reconnect

## Status

Accepted

## Context

DorkOS SSE events serve as cache invalidation signals — they tell the client "something changed, refetch" rather than carrying the actual state. When `SSEConnection` disconnects (tab switch > 30s, network blip, server restart) and later reconnects, any events emitted during the disconnect window are lost. This leaves TanStack Query caches stale until the next refetch cycle, causing the dashboard, sessions, and relay state to show outdated information. Server-side event replay (buffering events with IDs and replaying on reconnect) was considered but rejected — it requires a replay buffer (ring buffer strategy, size policy, per-endpoint decisions) and only covers events with IDs, while cache invalidation covers all state universally.

## Decision

When `SSEConnection` transitions from `reconnecting` → `connected`, call `queryClient.invalidateQueries()` to refetch all active TanStack Query caches. This is implemented in `event-stream-context.tsx` by tracking the previous connection state and detecting the specific transition. Lazy `import()` of the query client avoids circular dependencies. Only the `reconnecting` → `connected` transition triggers invalidation — not the initial `connecting` → `connected` on page load.

## Consequences

### Positive

- Guarantees zero stale data after any disconnect, regardless of which events were missed
- Covers all query state universally — not limited to events with IDs
- Client-only implementation — no server changes, no replay buffer, no memory budget concerns
- Simple (~10 lines of code) and reliable — simpler than server-side event replay

### Negative

- Burst of ~5-10 refetch requests on every reconnect (acceptable for a once-per-disconnect event)
- Invalidates all active queries, not just those affected by missed events — a targeted approach would be more efficient but harder to maintain as event types evolve
- Does not help with ephemeral notifications missed during disconnect (e.g., "Agent X finished task Y") — those require a separate detect-and-notify pattern
