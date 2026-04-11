---
number: 219
title: Cursor-Based Pagination for Activity Feed
status: proposed
created: 2026-03-29
spec: activity-feed
superseded-by: null
---

# 0219. Cursor-Based Pagination for Activity Feed

## Status

Proposed

## Context

The activity feed needs pagination for potentially thousands of events over a 30-day retention window. The existing codebase uses offset-based pagination for Pulse runs (`limit`/`offset` in `ListRunsQuery`) and cursor-based for Relay messages (`cursor`/`limit` in `listRelayMessages`). Offset-based pagination is simpler but produces inconsistent results when new events are inserted between page loads — items can shift or be duplicated. This is especially problematic for an activity feed where new events are continuously written.

## Decision

Use cursor-based pagination with the `occurred_at` timestamp as the cursor. The API accepts a `before` parameter (ISO timestamp) and returns `nextCursor` in the response. The query fetches `limit + 1` rows to detect whether more pages exist. "Load more" button UX (not infinite scroll) preserves user orientation when scanning hours of agent activity.

## Consequences

### Positive

- Stable pagination across concurrent inserts — new events don't shift existing pages
- Consistent with the Relay messages pattern already in the codebase
- "Load more" UX preserves scroll position and orientation (NNGroup research)
- Simple implementation: `WHERE occurred_at < cursor ORDER BY occurred_at DESC LIMIT N+1`

### Negative

- Cannot jump to arbitrary pages (no "page 5 of 12")
- Requires ULID-based IDs or compound cursors if multiple events share the exact same timestamp (ULID's millisecond-sortable property mitigates this)
- Slightly more complex client implementation (first `useInfiniteQuery` in the codebase)
