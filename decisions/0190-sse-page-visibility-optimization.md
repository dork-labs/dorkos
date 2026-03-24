---
number: 190
title: Close SSE Connections on Tab Background with Grace Period
status: draft
created: 2026-03-24
spec: sse-resilience-connection-health
superseded-by: null
---

# 190. Close SSE Connections on Tab Background with Grace Period

## Status

Draft (auto-extracted from spec: sse-resilience-connection-health)

## Context

SSE connections to the DorkOS server consume resources: each connection holds a file watcher (chokidar), a connection slot (max 500), and server memory. Users often have multiple DorkOS tabs open, and background tabs maintain idle SSE connections indefinitely. The `@microsoft/fetch-event-source` library popularized the pattern of closing SSE when tabs are hidden. DorkOS already has a `useTabVisibility` hook and uses it for TanStack Query polling intervals, establishing precedent for visibility-aware behavior.

## Decision

SSE connections will be closed after a 30-second grace period when the browser tab becomes hidden. When the tab becomes visible again, connections reconnect immediately. TanStack Query refetch catches up on any missed sync events during the disconnected period. The 30-second grace period prevents close/open churn during brief tab switches (Alt+Tab).

We chose this over keeping connections alive in background because DorkOS is a local-first app where the server runs on localhost — server resources are the user's own machine resources, and accumulating zombie connections across many tabs degrades the experience.

## Consequences

### Positive

- Reduces server resource usage proportional to background tabs
- Prevents zombie connection accumulation
- Leverages existing `useTabVisibility` infrastructure
- No data loss — TanStack Query refetch catches missed invalidation signals

### Negative

- Brief window after tab switch where sync events may be missed (caught by refetch)
- Adds complexity to SSEConnection state machine (visibility-aware transitions)
- User returning to a tab sees a brief "Connecting..." state before reconnection completes
