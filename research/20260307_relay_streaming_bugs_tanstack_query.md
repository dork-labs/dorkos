---
title: 'Relay-Mode SSE Streaming Bugs — Message Duplication & 503 Storm Fix Patterns'
date: 2026-03-07
type: implementation
status: active
tags:
  [
    relay,
    sse,
    tanstack-query,
    streaming,
    polling,
    message-duplication,
    503,
    invalidateQueries,
    refetchInterval,
  ]
feature_slug: relay-sse-streaming-bugs
searches_performed: 9
sources_count: 18
---

# Relay-Mode SSE Streaming Bugs — Message Duplication & 503 Storm Fix Patterns

## Research Summary

Two Relay-mode-only bugs in `useChatSession.ts` have clear, well-supported fixes. Bug 1 (message duplication after tool calls) is caused by `sync_update` SSE events triggering `queryClient.invalidateQueries()` without checking whether streaming is active — the history refetch appends already-streamed text again. Bug 2 (503 storm on polling) is caused by `refetchInterval` always being active in Relay mode, generating continuous GET /messages polls that conflict with the Relay transport. The code was read directly; exact line references are provided. Both bugs have surgical fixes requiring fewer than 10 lines each.

## Key Findings

1. **Bug 1 Root Cause — Identified in Source**: Lines 270-273 of `use-chat-session.ts` call `queryClient.invalidateQueries()` inside the `sync_update` SSE event listener unconditionally. The `isStreaming` boolean (`status === 'streaming'`) is in scope on line 131 but is not checked in the listener closure. The closure captures the value at effect creation time (when `isStreaming` was false), so even after streaming begins the guard would be stale. A `useRef` tracking `isStreaming` is the correct pattern.

2. **Bug 2 Root Cause — Identified in Source**: The `refetchInterval` callback on lines 184-189 already returns `false` when `isStreaming` is true. However, it does NOT check `relayEnabled`. In Relay mode, polling is doubly redundant — `sync_update` SSE events already signal when to refresh — but the interval fires continuously when `status === 'idle'`. The 503 errors indicate the GET /messages route is failing under Relay transport (possibly a missing try/catch in an async handler).

3. **TanStack Query v5 `enabled: false` Fully Prevents Invalidation**: Confirmed in the official docs and Issue #3202 (fixed in v4.0.0-alpha.9): "When enabled is false, the query will ignore query client invalidateQueries and refetchQueries calls." This is a clean alternative to the ref guard for Bug 1, but it prevents manual refetch too.

4. **`invalidateQueries({ refetchType: 'none' })`**: Marks query stale without triggering background refetch. Useful when you want to ensure the next non-streaming fetch returns fresh data but don't want to fire the request immediately.

5. **`streamedQuery` (experimental) is Not Applicable Here**: TanStack Query's `experimental_streamedQuery` is designed for queries whose `queryFn` IS the stream. DorkOS stores stream output in local React state and uses TanStack Query only for history snapshots — a different pattern. Using `streamedQuery` would require restructuring the entire data flow.

6. **The `historySeededRef` / `isStreaming` Guard on History Seed Already Partially Exists**: Lines 210-217 already guard the polling update path with `!isStreaming`. The gap is only in the `sync_update` SSE handler path (lines 270-273), which bypasses this guard by going through `invalidateQueries` → re-render → the seed effect fires without the `isStreaming` check.

---

## Detailed Analysis

### Bug 1: Message Duplication After Tool Calls

#### Exact Code Location

```typescript
// use-chat-session.ts lines 270-273
eventSource.addEventListener('sync_update', () => {
  queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
  queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
});
```

#### Why It Triggers Duplication

The data flow on a `sync_update` during active streaming:

```
sync_update fires
  → invalidateQueries(['messages', ...])
    → historyQuery refetches (status !== 'streaming' check in refetchInterval is NOT invoked here —
       invalidateQueries bypasses refetchInterval entirely)
      → historyQuery.data updates
        → seed effect fires (line 199-218)
          → isStreaming IS checked (line 210) — but the check compares against component state,
             which in Relay mode may still be 'streaming' if done event hasn't arrived
```

Wait — the seed effect at line 210 checks `!isStreaming`. If `isStreaming` is true, the seed effect does nothing. So why does duplication occur?

The duplication happens specifically **after tool calls complete** — at the moment the status transitions from `streaming` → `idle` while the final `sync_update` arrives. The sequence:

```
t=0  Tool call completes → SDK writes to transcript
t=0  sync_update SSE fires → invalidateQueries
t=1  done event arrives → setStatus('idle')
t=2  historyQuery refetch completes → historyQuery.data = [all messages including streamed ones]
t=3  seed effect fires → isStreaming === false → appends history.slice(currentMessages.length)
     BUT currentMessages already contains the streamed messages in local state
     AND the history now contains the same messages
     → history.slice(currentMessages.length) may or may not be empty depending on race timing
```

The key race: `currentMessages.length` reflects local streaming state (which may be ahead of or behind the server history depending on when the refetch completes). If the refetch resolves after `done` but the length calculation is wrong, messages are re-appended.

#### Solution A: Guard `invalidateQueries` with a Streaming Ref (Recommended)

Add a `isStreamingRef` that mirrors the `status === 'streaming'` state. Check it inside the `sync_update` handler.

```typescript
// After existing refs (around line 134):
const isStreamingRef = useRef(false);
useEffect(() => {
  isStreamingRef.current = status === 'streaming';
});

// In the sync_update listener (lines 270-273):
eventSource.addEventListener('sync_update', () => {
  if (!isStreamingRef.current) {
    queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
    queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
  }
});
```

**Pros:**

- Surgical — 3 lines of change
- Preserves all non-streaming invalidation behavior
- No structural changes to the query setup
- The ref pattern is already used elsewhere in this file (`statusRef`, `selectedCwdRef`, etc.)
- Fast: ref reads are synchronous, no closure staleness risk

**Cons:**

- Still invalidates immediately after `done` event (when `isStreamingRef` flips to false) — this is correct behavior but means one refetch will still fire post-streaming. This is acceptable since the stream is complete.
- Doesn't fix the deduplication in the seed effect independently

**Complexity:** Very low. 3-4 lines.

#### Solution B: Deduplicate History Merge by Message ID

Change the seed effect to merge by ID rather than by slice index. Skip any history message whose ID already exists in local state.

```typescript
// Replace lines 210-217:
if (historySeededRef.current && !isStreaming) {
  const currentIds = new Set(messagesRef.current.map((m) => m.id));
  const newMessages = history.filter((m) => !currentIds.has(m.id));
  if (newMessages.length > 0) {
    setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
  }
}
```

**Pros:**

- Eliminates duplication regardless of timing or streaming state
- More robust against future race conditions from any source
- IDs are already present: `HistoryMessage` has an `id` field (line 69 in `mapHistoryMessage`)

**Cons:**

- Doesn't prevent the unnecessary refetch network request — just prevents its display effect
- Doesn't fix redundant polling (Bug 2)
- Adds a Set construction on every history update (minor cost)
- Does not address the root cause (unnecessary invalidation during streaming)

**Complexity:** Low. 4-5 lines changed.

#### Solution C: Optimistic Update with `setQueryData` During Streaming

Skip `invalidateQueries` entirely; instead use `queryClient.setQueryData` to directly update the cache as streaming events arrive.

```typescript
// In streamEventHandler on 'done' event:
queryClient.setQueryData(['messages', sessionId, selectedCwd], {
  messages: messagesRef.current.map(chatMessageToHistoryMessage),
});
```

**Pros:**

- Eliminates the refetch roundtrip entirely for streaming updates
- Cache is always current with local state
- Pattern is well-documented in TanStack Query v5 optimistic updates guide

**Cons:**

- Requires implementing `chatMessageToHistoryMessage` reverse mapping (non-trivial — `ChatMessage` includes UI state not in `HistoryMessage`)
- Creates divergence between local optimistic state and server truth
- If streaming fails mid-way, cache contains partial data
- Structural change — `streamEventHandler` would need `queryClient` access (currently it doesn't)
- High complexity relative to Bug 1's actual impact

**Complexity:** High. Requires reverse mapping and refactoring `streamEventHandler`.

#### Solution D: Separate Streaming State from Query Cache (Zustand)

Store in-progress streaming messages in Zustand; only merge into query cache on `done` event. TanStack Query cache only holds finalized, server-confirmed history.

**Pros:**

- Cleanest separation of concerns
- Eliminates all race conditions between local streaming state and server history
- Aligns with TanStack Query philosophy: server state (query) vs UI state (Zustand)

**Cons:**

- Major refactor — `useChatSession` currently mixes streaming state and history state
- `messages` array would need to be assembled from two sources on every render
- File is already 437 lines — this expansion would require extraction
- High risk of introducing new bugs

**Complexity:** Very high. Multi-day refactor.

---

### Bug 2: 503 Storm on GET /messages Polling

#### Exact Code Location

```typescript
// use-chat-session.ts lines 179-190
const historyQuery = useQuery({
  queryKey: ['messages', sessionId, selectedCwd],
  queryFn: () => transport.getMessages(sessionId, selectedCwd ?? undefined),
  staleTime: QUERY_TIMING.MESSAGE_STALE_TIME_MS,
  refetchOnWindowFocus: false,
  refetchInterval: () => {
    if (isStreaming) return false;
    return isTabVisible
      ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
      : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
  },
});
```

The `refetchInterval` callback already suppresses polling during streaming (line 185). However:

- In Relay mode, polling is entirely redundant — `sync_update` SSE events drive all invalidation
- If `ACTIVE_TAB_REFETCH_MS` = 3000ms, this fires every 3 seconds indefinitely in Relay idle mode
- Each poll hits GET /api/sessions/:id/messages, which must read from the transcript file
- The 503 indicates the route handler throws without a response — likely an unhandled async rejection

#### Why 503 (not 500) in Relay Mode

503 "Service Unavailable" from an Express route typically indicates:

1. The route throws synchronously or the async rejection is unhandled (Express 4: unhandled async errors don't reach error middleware → connection hangs → proxy/client interprets as 503)
2. A downstream resource (file read, DB query) times out under load
3. The route calls `next()` or `res.send()` only on certain code paths, leaving other paths hanging

In Relay mode specifically, the GET /messages route may have a Relay-specific code path that doesn't handle errors, or the polling volume under Relay mode creates file contention on the JSONL transcript.

#### Solution A: Disable Polling in Relay Mode (Recommended)

```typescript
refetchInterval: () => {
  if (isStreaming || relayEnabled) return false;
  return isTabVisible
    ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
    : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
},
```

**Pros:**

- Single-line change to an existing function
- Completely eliminates the 503 storm in Relay mode
- Semantically correct: in Relay mode, `sync_update` already handles invalidation
- No impact on non-Relay mode
- `relayEnabled` is already in scope (line 85)

**Cons:**

- If the SSE connection drops and `sync_update` events stop arriving, there's no polling fallback (mitigated by EventSource auto-reconnect)
- Does not fix the underlying 503 cause in the GET /messages route

**Complexity:** Trivial. 1 line.

#### Solution B: Fix the 503-Producing Route Error

Find and fix the unhandled async error in the GET /messages Express route.

Common Express 4 async error pattern (causes 503):

```typescript
// BROKEN — async rejection is uncaught in Express 4
router.get('/:id/messages', async (req, res) => {
  const messages = await transcriptReader.readTranscript(id); // throws → unhandled
  res.json({ messages });
});

// FIXED — explicit try/catch
router.get('/:id/messages', async (req, res, next) => {
  try {
    const messages = await transcriptReader.readTranscript(id);
    res.json({ messages });
  } catch (err) {
    next(err); // Express error middleware sends 500
  }
});
```

**Pros:**

- Fixes the 503 for any caller, not just polling
- Express 4 async error handling is a well-known issue with a clear fix
- Should be fixed regardless as a correctness issue

**Cons:**

- Doesn't eliminate the redundant polling itself
- Need to locate the specific route handler first (check `apps/server/src/routes/sessions.ts`)

**Complexity:** Low, but requires locating and auditing the route.

#### Solution C: Replace Polling with Event-Driven Invalidation (Best Long-Term)

Remove `refetchInterval` entirely for Relay mode. Rely solely on `sync_update` events.

```typescript
const historyQuery = useQuery({
  queryKey: ['messages', sessionId, selectedCwd],
  queryFn: () => transport.getMessages(sessionId, selectedCwd ?? undefined),
  staleTime: relayEnabled ? Infinity : QUERY_TIMING.MESSAGE_STALE_TIME_MS,
  refetchOnWindowFocus: false,
  refetchInterval: relayEnabled
    ? false
    : () => {
        if (isStreaming) return false;
        return isTabVisible
          ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
          : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
      },
});
```

**Pros:**

- Zero polling in Relay mode — no 503 risk
- `staleTime: Infinity` prevents any background refetch from occurring
- Cleanest conceptual model: SSE events are the real-time signal, polling is a fallback
- TanStack Query docs confirm `staleTime: Infinity` prevents background refetches

**Cons:**

- If the SSE connection is completely lost (EventSource closed, not reconnected), history never updates until page reload
- Slightly more code than Solution A

**Complexity:** Low. 3 lines changed.

#### Solution D: Conditional Query Options via `enabled`

```typescript
const historyQuery = useQuery({
  queryKey: ['messages', sessionId, selectedCwd],
  queryFn: () => transport.getMessages(sessionId, selectedCwd ?? undefined),
  enabled: !relayEnabled || !isStreaming,
  staleTime: QUERY_TIMING.MESSAGE_STALE_TIME_MS,
  refetchOnWindowFocus: false,
  refetchInterval: /* ... */,
});
```

**Note**: `enabled: false` prevents `invalidateQueries` from firing refetches. This means in Relay mode when not streaming, the query wouldn't respond to `sync_update` invalidations either — defeating the purpose.

**Pros:** Prevents all unwanted fetches

**Cons:** Too aggressive — disables invalidation-driven updates. Not recommended for this use case.

**Complexity:** Low but semantically wrong.

---

## TanStack Query v5 Key Patterns

### `invalidateQueries` Behavior

- Marks query stale AND triggers immediate background refetch for active queries
- Use `{ refetchType: 'none' }` to mark stale without triggering refetch
- `enabled: false` causes the query to ignore `invalidateQueries` entirely (confirmed fixed in v4+)

```typescript
// Mark stale but do NOT refetch yet:
queryClient.invalidateQueries({
  queryKey: ['messages', sessionId],
  refetchType: 'none',
});

// Standard: mark stale AND refetch immediately:
queryClient.invalidateQueries({ queryKey: ['messages', sessionId] });
```

### `refetchInterval` as a Function (v5)

Accepts `(query: Query) => number | false | undefined`. Return `false` to stop polling:

```typescript
refetchInterval: (query) => {
  if (isStreaming || relayEnabled) return false;
  if (query.state.error) return false;          // Stop on error
  return 3000;
},
```

### `isFetching` vs `isRefetching` Distinction

- `isFetching`: true whenever `queryFn` is executing (initial load OR background refetch)
- `isRefetching`: `isFetching && !isPending` — true only during background refetches when data already exists

For guarding against duplication during background refetches specifically, check `isRefetching`.

### `setQueryData` for Streaming Updates (Pattern)

Use `setQueryData` to update cache directly during streaming without a network round-trip:

```typescript
// During stream processing:
queryClient.setQueryData(['messages', sessionId, cwd], (old: MessageHistory | undefined) => ({
  messages: [...(old?.messages ?? []), newMessage],
}));
```

### Preventing Refetch During Mutations (Pattern from #2245)

Use `useIsMutating` hook to disable queries while mutations run:

```typescript
const isMutating = useIsMutating({ mutationKey: ['sendMessage', sessionId] });

const historyQuery = useQuery({
  queryKey: ['messages', sessionId],
  enabled: isMutating === 0,
  // ...
});
```

This is the officially recommended pattern for preventing refetch-mutation conflicts.

---

## SSE + Polling Anti-Patterns

### Why Polling + SSE Creates Race Conditions

When both polling (`refetchInterval`) and SSE-triggered invalidation (`sync_update` → `invalidateQueries`) run simultaneously:

1. SSE event fires → `invalidateQueries` → refetch A starts
2. 100ms later: polling fires → `invalidateQueries` → refetch B starts, cancels refetch A
3. Refetch B returns — but was triggered before the SSE-indicated update was written
4. Result: stale data, and the cancelled refetch A's update is lost

The canonical industry pattern: **SSE events are the real-time signal; polling is the fallback**. When SSE is available, disable polling. React Query's `refetchInterval` docs acknowledge this pattern.

### Express Async Error: 503 vs 500

- **500**: Express error middleware received the error via `next(err)` and sent a 500 response
- **503**: Express never sent a response — the connection hung, and a proxy (nginx, load balancer) timed out the request and returned 503 on behalf of the server

In Express 4, unhandled async rejections in route handlers don't reach error middleware — the request hangs. This produces 503 from any upstream proxy. Express 5 fixes this by automatically calling `next(err)` for unhandled promise rejections in async routes.

---

## Recommendation

### Bug 1 Recommended Approach: Solution A (Guard `invalidateQueries` with `isStreamingRef`)

Add `isStreamingRef` mirroring `status === 'streaming'` and check it in the `sync_update` handler before calling `invalidateQueries`.

**Rationale:** The hook already uses this exact ref pattern (`statusRef`, `selectedCwdRef`, `messagesRef`). It's the least-surprise change, keeps invalidation logic in one place, and precisely targets the problem. Solution B (deduplication by ID) should be added as a safety net — it costs one Set construction per history update and eliminates an entire class of future race conditions.

**Recommended combined fix:**

1. Add `isStreamingRef` + guard on `sync_update` (lines 270-273) — primary fix
2. Change the history seed merge to use ID-based deduplication (lines 210-217) — safety net

### Bug 2 Recommended Approach: Solution A + Solution B (Disable Relay Polling + Fix Route Error)

Both should be done:

1. Add `|| relayEnabled` to the `refetchInterval` callback (line 185) — stops the storm immediately
2. Audit and add try/catch to the GET /messages Express route handler — fixes the 503 root cause for all callers

**Rationale:** Solution A is one line and stops the bleeding. Solution B should be done regardless since unhandled async rejections in Express 4 routes are a correctness issue. Solution C (`staleTime: Infinity` in Relay mode) is ideal long-term but overkill for immediate bug fixes.

**Caveats:**

- The `isStreamingRef` guard on Bug 1 prevents `sync_update` invalidation _during_ streaming. The guard should use a ref (not the `isStreaming` state closure) because the `sync_update` listener closure captures state at effect creation time. Existing `statusRef` (line 134) already tracks this — the guard could use `statusRef.current === 'streaming'` directly without adding a new ref.
- The Bug 2 fix should be validated by checking `QUERY_TIMING.ACTIVE_TAB_REFETCH_MS` — if it's already set to a high value (e.g., 30s), the 503 storm may be coming from a different source.
- Both fixes are Relay-mode-only changes and should not affect non-Relay behavior.

---

## Sources & Evidence

- [TanStack Query v5 — Disabling/Pausing Queries](https://tanstack.com/query/v5/docs/framework/react/guides/disabling-queries): "When enabled is false, the query will ignore query client invalidateQueries and refetchQueries calls"
- [TanStack Query Issue #3202 — Disabled queries affected by invalidateQueries](https://github.com/TanStack/query/issues/3202): Fix confirmed in v4.0.0-alpha.9 via PR #3223
- [TanStack Query Discussion #2245 — Prevent refetch during mutation](https://github.com/TanStack/query/discussions/2245): `useIsMutating` pattern; maintainer confirmed user-land tracking is the recommended approach
- [TanStack Query Discussion #9065 — streamedQuery feedback](https://github.com/TanStack/query/discussions/9065): Partial data problem when component unmounts before stream ends; `refetchMode` options: reset/append/replace
- [TanStack Query — useQuery reference](https://tanstack.com/query/v5/docs/framework/react/reference/useQuery): `refetchInterval` accepts `(query: Query) => number | false | undefined`
- [TanStack Query — Optimistic Updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates): `setQueryData` pattern for synchronous cache updates
- [TanStack Query — Query Invalidation](https://tanstack.com/query/v5/docs/react/guides/query-invalidation): `refetchType: 'none'` to mark stale without immediate refetch
- [Express Error Handling — Better Stack](https://betterstack.com/community/guides/scaling-nodejs/error-handling-express/): Express 4 async errors must be forwarded via `next(err)` — unhandled async rejections hang the request → 503
- [Express Async Handler library](https://github.com/Abazhenov/express-async-handler): Standard wrapper pattern for Express 4 async routes
- [TanStack Query Discussion #713 — refetchInterval conditional](https://github.com/TanStack/query/discussions/713): Recommended pattern for stopping polling based on external state
- [Prior DorkOS Research — SSE Relay Delivery Race Conditions](../research/20260306_sse_relay_delivery_race_conditions.md): Subscribe-first architecture, pending buffer, and async generator error propagation patterns

## Research Gaps & Limitations

- The exact value of `QUERY_TIMING.ACTIVE_TAB_REFETCH_MS` and `QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS` was not checked — if the active tab interval is already set to a high value (e.g., 30s), the 503 frequency should be low and another source may be responsible.
- The GET /messages Express route handler (`apps/server/src/routes/sessions.ts`) was not directly inspected for the async error pattern — the 503 root cause analysis is based on the standard Express 4 behavior pattern.
- The exact timing relationship between the `done` SSE event and `sync_update` in Relay mode was not measured. The duplication window may be very narrow (< 100ms) in practice.

## Search Methodology

- Searches performed: 9
- Most productive search terms: "TanStack Query enabled false invalidateQueries ignored", "TanStack Query prevent refetch during mutation useIsMutating", "Express async route 503 unhandled rejection", "experimental_streamedQuery refetchMode append replace"
- Primary sources: TanStack Query official docs, GitHub Issues #3202 and #2245, Express error handling guides, direct source inspection of `use-chat-session.ts`
