---
slug: fix-relay-streaming-bugs
number: 100
created: 2026-03-07
status: draft
ideation: specs/fix-relay-streaming-bugs/01-ideation.md
---

# Fix Two Relay-Mode Streaming Bugs

**Status:** Draft
**Authors:** Claude Code, 2026-03-07
**Ideation:** [specs/fix-relay-streaming-bugs/01-ideation.md](./01-ideation.md)

---

## Overview

Two Relay-mode-only bugs degrade the DorkOS chat UI during live streaming sessions. Both are confirmed by the chat self-test run (see `test-results/chat-self-test/20260306-210803.md`). Combined fix touches ~12 lines across 2 files with no API or interface changes.

**Bug 1 — Message Duplication:** When an assistant response includes any tool call (Skill, Bash, TodoWrite, etc.) followed by text, the final text block renders twice on-screen during live streaming. The duplication disappears on page reload.

**Bug 2 — 503 Storm on GET /messages:** In Relay mode the client polls `/api/sessions/{id}/messages` every 3 seconds and receives 503 responses throughout the session. Two independent causes: redundant polling (SSE already drives history updates in Relay mode) and an unhandled async rejection in the Express route handler.

---

## Background / Problem Statement

DorkOS has two streaming modes:

- **Legacy SSE mode:** POST /messages streams response inline; client processes events synchronously. No polling race possible.
- **Relay mode (`DORKOS_RELAY_ENABLED=true`):** POST /messages returns 202, response chunks arrive via a persistent `EventSource` on `relay.human.console.{clientId}`. Client uses a separate polling query for history sync.

The Relay EventSource also carries `sync_update` events from the server-side transcript file watcher. These events are designed to trigger history invalidation when the transcript changes — but the current implementation does this unconditionally, even during active streaming, creating a race condition.

Separately, the GET /messages route handler (which backs the polling query) has a latent Express 4 bug: unhandled async rejections don't propagate to error middleware, causing the request to hang until a proxy timeout returns 503.

---

## Goals

- Tool-call messages render exactly once during live Relay-mode streaming
- No 503 responses on GET /messages in Relay mode during or between sessions
- History sync still works after streaming completes (sync_update fires correctly post-done)
- Non-Relay streaming path is completely unaffected
- Express GET /messages returns a proper error response (500) instead of hanging on any runtime error

---

## Non-Goals

- Structural refactor of `useChatSession` streaming state into Zustand (out of scope)
- `staleTime: Infinity` optimization for Relay mode (post-v1 improvement, see Deferred Work)
- Fixing any bugs in non-Relay mode
- Changes to the history reload path (already correct on page reload)

---

## Technical Dependencies

- **TanStack Query v5** (`@tanstack/react-query`) — `refetchInterval` as a function returning `false` correctly disables polling while still allowing `invalidateQueries()` to work. **Do NOT use `enabled: false`** — disabled queries in TanStack Query v5 silently ignore `invalidateQueries()` calls, which would break post-stream history sync.
- **Express 4** (`express`) — Does not auto-forward unhandled `async` route handler rejections to error middleware. Must use explicit try/catch + `next(err)`.
- No new library dependencies required.

---

## Detailed Design

### Bug 1: Message Duplication — Two-Layer Fix

#### Layer 1: Guard `sync_update` invalidation during streaming

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`
**Location:** Lines 270-273 (Relay-path EventSource `useEffect`)

The `sync_update` handler currently calls `queryClient.invalidateQueries()` unconditionally. When `sync_update` fires during active Relay streaming, it triggers a history refetch that races with the `done` event — the seed effect's length-based slice then includes already-rendered text.

The fix uses `statusRef` (already at line 134, kept in sync via `useEffect` on every render) to skip invalidation while streaming is active. The guard is `statusRef.current !== 'streaming'` rather than `!isStreaming` because the `sync_update` callback closes over the `useEffect` closure at creation time — the ref gives access to the current live value.

```typescript
// BEFORE (lines 270-273):
eventSource.addEventListener('sync_update', () => {
  queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
  queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
});

// AFTER:
eventSource.addEventListener('sync_update', () => {
  // Skip invalidation during active streaming — relay_message events already update
  // local state. The refetch would race with the done event and cause duplicates.
  if (statusRef.current === 'streaming') return;
  queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
  queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
});
```

**Invariant preserved:** When `sync_update` fires after the `done` event transitions status to `'idle'`, invalidation fires normally — post-stream history sync is unaffected.

#### Layer 2: ID-based deduplication in seed effect (defensive safety net)

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`
**Location:** Lines 210-217 (seed effect history merge branch)

The current `history.slice(currentMessages.length)` append assumes no overlap between local streaming state and server history. This assumption can fail under any timing race (not just the sync_update race). Replacing it with an ID-set filter makes the merge idempotent — already-rendered messages are skipped regardless of cause.

`HistoryMessage.id` is a stable UUID present on all history messages (confirmed by reading `mapHistoryMessage()` at line 69: `id: m.id`).

```typescript
// BEFORE (lines 210-217):
if (historySeededRef.current && !isStreaming) {
  const currentMessages = messagesRef.current;
  const newMessages = history.slice(currentMessages.length);

  if (newMessages.length > 0) {
    setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
  }
}

// AFTER:
if (historySeededRef.current && !isStreaming) {
  const currentIds = new Set(messagesRef.current.map((m) => m.id));
  const newMessages = history.filter((m) => !currentIds.has(m.id));

  if (newMessages.length > 0) {
    setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
  }
}
```

**Why both layers?** Layer 1 eliminates the unnecessary refetch during streaming (the root cause). Layer 2 eliminates duplicate rendering even if a refetch does complete during the streaming→idle transition window — defense in depth against any timing race.

---

### Bug 2: 503 Storm — Two-Layer Fix

#### Layer 1: Disable polling in Relay mode

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`
**Location:** Lines 184-189 (`historyQuery` configuration)

In Relay mode, `sync_update` SSE events from the persistent EventSource already drive all history invalidation via `queryClient.invalidateQueries()`. The polling query is entirely redundant. Adding `|| relayEnabled` to the existing `isStreaming` guard disables polling for the duration of a Relay session.

`relayEnabled` is already in scope at line 85: `const relayEnabled = useRelayEnabled();`

```typescript
// BEFORE (lines 184-189):
refetchInterval: () => {
  if (isStreaming) return false;
  return isTabVisible
    ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
    : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
},

// AFTER:
refetchInterval: () => {
  // In Relay mode, sync_update SSE events drive invalidation — polling is redundant
  if (isStreaming || relayEnabled) return false;
  return isTabVisible
    ? QUERY_TIMING.ACTIVE_TAB_REFETCH_MS
    : QUERY_TIMING.BACKGROUND_TAB_REFETCH_MS;
},
```

**TanStack Query v5 constraint:** Using `refetchInterval: () => false` correctly disables polling while preserving `invalidateQueries()` reactivity. Using `enabled: false` would break this — disabled queries in TanStack Query v5 ignore invalidation. See [TanStack Query docs: Disabling Queries](https://tanstack.com/query/v5/docs/framework/react/guides/disabling-queries).

**Relay EventSource loss:** If the EventSource disconnects, it auto-reconnects (browser standard behavior). The staleness detector (lines 220-242) provides a 15-second fallback: if no events arrive for 15s, it polls `transport.getSession()` and invalidates history on recovery. This covers the edge case where sync_update events are missed during a reconnect window.

#### Layer 2: Add try/catch to GET /messages Express route

**File:** `apps/server/src/routes/sessions.ts`
**Location:** Lines 116-139 (GET `/:id/messages` handler)

Express 4 does not automatically forward unhandled async rejections in route handlers to error middleware. When `runtime.getMessageHistory()` or `runtime.getSessionETag()` throws (e.g., due to transcript I/O contention, session write lock, or Relay-mode state conflict), the request hangs until a proxy timeout returns 503. Wrapping the async body in try/catch with `next(err)` propagates the error to Express error middleware, returning a proper 500 response immediately.

```typescript
// BEFORE (lines 116-139):
router.get('/:id/messages', async (req, res) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwdParam = (req.query.cwd as string) || undefined;
  if (!(await assertBoundary(cwdParam, res))) return;
  const cwd = cwdParam || vaultRoot;

  const runtime = runtimeRegistry.getDefault();
  const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

  const etag = await runtime.getSessionETag(cwd, internalSessionId);
  if (etag) {
    res.setHeader('ETag', etag);
    if (req.headers['if-none-match'] === etag) {
      return res.status(304).end();
    }
  }

  const messages = await runtime.getMessageHistory(cwd, internalSessionId);
  res.json({ messages });
});

// AFTER:
router.get('/:id/messages', async (req, res, next) => {
  const sessionId = parseSessionId(req.params.id);
  if (!sessionId) return sendError(res, 400, 'Invalid session ID', 'INVALID_SESSION_ID');

  const cwdParam = (req.query.cwd as string) || undefined;
  if (!(await assertBoundary(cwdParam, res))) return;
  const cwd = cwdParam || vaultRoot;

  try {
    const runtime = runtimeRegistry.getDefault();
    const internalSessionId = runtime.getInternalSessionId(sessionId) ?? sessionId;

    const etag = await runtime.getSessionETag(cwd, internalSessionId);
    if (etag) {
      res.setHeader('ETag', etag);
      if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
      }
    }

    const messages = await runtime.getMessageHistory(cwd, internalSessionId);
    res.json({ messages });
  } catch (err) {
    next(err);
  }
});
```

**Scope:** This fix applies to all callers (not Relay-specific). Any future error condition that causes `getMessageHistory` or `getSessionETag` to throw will return a proper 500 rather than hanging and triggering proxy 503.

---

### Data Flow After Fixes

```
Relay mode — POST /messages
    ↓ 202 receipt
Relay EventSource (persistent SSE: relay.human.console.{clientId})
    ↓ relay_message events → streamEventHandler() → setMessages() [local state only]
    ↓ sync_update event → [FIXED: skipped when status === 'streaming']
    ↓ done event → setStatus('idle') → seed effect runs [FIXED: ID-set dedup, no double-render]
    ↓ sync_update event → [NOW FIRES: status === 'idle'] → invalidateQueries() → history refetch

Polling query (historyQuery):
    [FIXED: refetchInterval returns false when relayEnabled=true — no polling in Relay mode]

GET /messages route:
    [FIXED: try/catch → next(err) → Express error middleware → 500 instead of hanging]
```

---

## User Experience

- **Before:** In Relay mode, after any tool call, the assistant's final text response appears twice on screen (visible for the duration of the streaming session, disappearing on reload). Network tab shows a flood of 503 errors on GET /messages.
- **After:** Messages render exactly once. No network errors. Behavior in Relay mode matches legacy SSE mode from the user's perspective.

---

## Testing Strategy

### New tests: `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts`

Add two test cases to the existing relay test suite:

**Test 1 — sync_update does NOT invalidate during streaming:**

```typescript
it('does not call invalidateQueries on sync_update while streaming', async () => {
  // Purpose: Verifies the statusRef guard prevents premature history invalidation
  // that causes message duplication. This test CAN fail if the guard is removed.
  // Setup: render hook in relay mode, submit a message (status → 'streaming')
  // Fire sync_update event on the EventSource
  // Assert: queryClient.invalidateQueries was NOT called
});
```

**Test 2 — sync_update DOES invalidate after streaming completes:**

```typescript
it('calls invalidateQueries on sync_update when status is idle', async () => {
  // Purpose: Verifies history sync still works post-stream. Guards against
  // overly aggressive fixes that skip all invalidation.
  // Setup: render hook in relay mode with status = 'idle'
  // Fire sync_update event on the EventSource
  // Assert: queryClient.invalidateQueries WAS called with messages queryKey
});
```

### New tests: `apps/server/src/routes/__tests__/sessions.test.ts`

Add one test case:

**Test 3 — GET /messages returns 500 when getMessageHistory throws:**

```typescript
it('returns 500 when getMessageHistory throws', async () => {
  // Purpose: Verifies Express route propagates runtime errors instead of hanging.
  // This test CAN fail if the try/catch is removed.
  // Setup: mock runtime.getMessageHistory to throw new Error('I/O error')
  // GET /api/sessions/test-id/messages
  // Assert: response status is 500 (not hanging → 503)
  // Assert: response body contains error field
});
```

### Existing tests to verify pass

- All existing `use-chat-session-relay.test.ts` tests — no behavioral change to Relay path, only guard added
- All existing `sessions.test.ts` tests — success-path behavior unchanged
- Full `pnpm test` suite

### Mocking notes

- Client tests: `queryClient` should be a real `QueryClient` instance from `@tanstack/react-query` (not mocked), so `invalidateQueries` spy can be asserted
- Server tests: mock `runtimeRegistry.getDefault()` to return an object with mocked `getMessageHistory`

---

## Performance Considerations

- **Positive:** Eliminating polling in Relay mode (`refetchInterval: false`) removes ~1 GET /messages request every 3 seconds per active session. Reduces server load during active multi-agent Relay sessions.
- **ID-set deduplication:** `new Set(messagesRef.current.map(...))` runs on every `historyQuery.data` change. With typical message counts (<200 per session), this is O(n) and negligible. No memoization needed.

---

## Security Considerations

No security implications. Changes are additive guards on existing logic paths with no new data exposure or authentication surface.

---

## Documentation

No user-facing documentation changes required. These are bug fixes with no behavioral change visible to end users (beyond the bugs being fixed).

---

## Implementation Phases

### Phase 1: Bug Fixes (this spec — complete)

1. **`use-chat-session.ts` — sync_update guard** (lines 270-273)
   - Add `if (statusRef.current === 'streaming') return;` before `invalidateQueries` calls

2. **`use-chat-session.ts` — ID-based deduplication** (lines 210-217)
   - Replace `history.slice(currentMessages.length)` with ID-set filter

3. **`use-chat-session.ts` — Relay polling guard** (lines 184-189)
   - Add `|| relayEnabled` to `refetchInterval` return-false condition

4. **`sessions.ts` — Express async error handling** (lines 116-139)
   - Wrap GET /messages handler body in try/catch with `next(err)`
   - Add `next` parameter to route handler signature

5. **Tests** — Add 3 test cases (2 client, 1 server) as specified above

### Phase 2: Future improvement (deferred)

- Set `staleTime: Infinity` for `historyQuery` in Relay mode — eliminates background staleness marking that isn't needed when SSE drives invalidation. Small but clean improvement. No correctness impact.

---

## Open Questions

None. All decisions were resolved during ideation via codebase exploration and research. See [01-ideation.md Section 6](./01-ideation.md#6-decisions).

---

## Related ADRs

- No existing ADRs directly govern SSE polling behavior or TanStack Query usage patterns. No new ADR warranted — these are targeted bug fixes, not architectural decisions.

---

## References

- Chat self-test report: `test-results/chat-self-test/20260306-210803.md`
- Research: `research/20260307_relay_streaming_bugs_tanstack_query.md`
- TanStack Query v5 — Disabling Queries: https://tanstack.com/query/v5/docs/framework/react/guides/disabling-queries
- TanStack Query v5 — Query Invalidation: https://tanstack.com/query/v5/docs/react/guides/query-invalidation
- Express 4 async error handling: https://expressjs.com/en/guide/error-handling.html
