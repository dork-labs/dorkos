---
number: 162
title: Client-Side Activity Feed Aggregation Over Server-Side Event Stream
status: accepted
created: 2026-03-20
spec: dashboard-content
superseded-by: null
---

# 162. Client-Side Activity Feed Aggregation Over Server-Side Event Stream

## Status

Accepted

## Context

The dashboard's Recent Activity Feed composes events from multiple sources: sessions, Pulse runs, and Relay messages. The team considered whether to create a new server API endpoint for a unified event stream or to aggregate events entirely client-side using existing TanStack Query caches. All the underlying data is already available through existing entity hooks, so the question was whether to centralize aggregation server-side or keep it as a derived client-side computation.

## Decision

Derive activity feed events entirely from existing entity hooks (`useSessions()`, `useRuns()`), time-group them client-side, cap at 20 items, and track "since your last visit" via localStorage. No new server endpoint is introduced. The aggregation is ephemeral — recomputed on every dashboard render from cached entity data.

## Consequences

### Positive

- No server-side changes required; dashboard is genuinely read-only
- Entity cache invalidation automatically refreshes the feed
- Simple mental model: feed = derived view of existing data
- Reduces server coupling and API surface area

### Negative

- Feed logic (grouping, time bucketing, capping) adds client-side complexity
- Cannot pre-render the feed server-side or serve it to external tools without a new API
- Feed freshness depends on entity hook polling intervals, not dashboard-specific tuning
