---
number: 252
title: Optimistic Session Rename via Shared useMutation Hook
status: draft
created: 2026-04-13
spec: session-rename-fork
superseded-by: null
---

# 252. Optimistic Session Rename via Shared useMutation Hook

## Status

Draft (auto-extracted from spec: session-rename-fork)

## Context

Session rename currently uses a try/catch pattern in `SessionSidebar`: call `transport.updateSession()`, then `queryClient.invalidateQueries()`. This causes visible latency — the title doesn't update until the server responds and the query refetches. With rename/fork being wired to three different consumers (SessionSidebar, SessionsTab, DashboardSidebar), the handler logic would be duplicated.

## Decision

Extract a shared `useRenameSession` hook using TanStack Query's `useMutation` with optimistic updates. The hook optimistically updates the sessions query cache via `setQueryData` on mutate, rolls back on error, and always invalidates on settled. All three consumers call the same hook instead of duplicating transport + error + invalidation logic.

## Consequences

### Positive

- Instant UI feedback — title changes appear immediately without waiting for server response
- Automatic rollback on error preserves data integrity
- Single source of truth for rename logic shared across three consumers
- Follows TanStack Query best practices for mutations

### Negative

- Slightly more complex than the simple try/catch pattern
- Optimistic update must match the exact query key shape (`['sessions', cwd]`) or updates won't appear
- Brief window where UI shows a title that may not match server state (resolved on settled)
