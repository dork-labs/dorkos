---
number: 106
title: Convergence Effect for Optimistic TanStack Query State
status: proposed
created: 2026-03-10
spec: fix-chat-streaming-and-model-selector-bugs
superseded-by: null
---

# 106. Convergence Effect for Optimistic TanStack Query State

## Status

Proposed

## Context

When a user action requires an immediate UI update backed by a server PATCH (e.g., changing the model or permission mode), the codebase uses a `useState` optimistic override combined with a TanStack Query priority chain: `localValue ?? serverValue ?? default`. After the PATCH succeeds, the optimistic state must be cleared so the server-authoritative value takes over.

The intuitive approach — clearing the optimistic state in the PATCH success callback immediately after `setQueryData` — has a subtle timing bug: `setQueryData` updates the cache synchronously, but `useQuery` subscribers re-render asynchronously. For one render frame, `localValue` is null while `serverValue` still holds the stale pre-PATCH value, causing the UI to briefly revert to the old value.

## Decision

Use a **convergence effect** instead of eager clearing: hold the optimistic `localValue` until a `useEffect` observes that `serverValue === localValue`, then clear it. This ensures the optimistic override persists until the server-confirmed value has propagated through to the `useQuery` subscriber.

```typescript
// Clear optimistic state only when server data confirms the same value
useEffect(() => {
  if (localValue !== null && serverValue === localValue) {
    setLocalValue(null);
  }
}, [serverValue, localValue]);
```

Error paths still clear optimistic state eagerly (revert on failure).

## Consequences

### Positive

- Eliminates the one-frame render gap where the UI shows a stale value
- Data-driven and self-documenting — the clearing condition is explicit
- Works with any TanStack Query cache update pattern (setQueryData, invalidation, polling)
- Applicable to any optimistic override in the codebase (model, permissionMode, future fields)

### Negative

- If the server normalizes the value differently (e.g., different string format), convergence never fires and the optimistic state persists indefinitely — requires either exact server echo or a fallback timer
- Adds a `useEffect` with dependencies that fire on every query cache update, though the body is a trivial equality check
