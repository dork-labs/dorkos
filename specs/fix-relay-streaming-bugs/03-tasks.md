# Task Breakdown: fix-relay-streaming-bugs

**Spec:** `specs/fix-relay-streaming-bugs/02-specification.md`
**Generated:** 2026-03-07
**Mode:** Full

---

## Summary

Two Relay-mode-only bugs degrade the DorkOS chat UI during live streaming sessions. This breakdown covers 6 tasks across 2 phases: 4 surgical code changes (Phase 1) and 3 test additions (Phase 2). All Phase 1 tasks are independent and can be executed in parallel.

**Bug 1 — Message Duplication:** Fixed with two layers of defense in `use-chat-session.ts`.
**Bug 2 — 503 Storm:** Fixed with one client-side guard and one server-side try/catch.

---

## Phase 1: Bug Fixes

All 4 tasks in Phase 1 touch independent lines and can run in parallel.

---

### Task 1.1 — Guard sync_update invalidation during active streaming

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`
**Lines:** 270-273
**Size:** Small | **Priority:** High

**Root cause:** The `sync_update` EventSource listener calls `queryClient.invalidateQueries()` unconditionally. When a tool call completes, the SDK writes to the transcript, firing `sync_update`. This triggers a history refetch that races with the `done` event transition. The seed effect runs with `isStreaming === false` and appends `history.slice(currentMessages.length)` — but the same content is already in local state, causing duplication.

**Fix:** Use `statusRef.current` (already maintained at lines 134-137 via a synchronous `useEffect`) to skip invalidation while streaming.

```typescript
// BEFORE:
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

Why `statusRef` not `isStreaming`: The listener closure captures `isStreaming` at effect creation time (when it was `false`). The ref gives access to the current live value via synchronous read.

**Invariant preserved:** When `sync_update` fires after the `done` event transitions status to `'idle'`, the guard does not return early — post-stream history sync is unaffected.

---

### Task 1.2 — Replace length-based history slice with ID-set deduplication

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`
**Lines:** 210-217
**Size:** Small | **Priority:** High

**Root cause:** `history.slice(currentMessages.length)` assumes no overlap between local streaming state and server history. Under any timing race (not just the `sync_update` race), `currentMessages.length` may be incorrect, causing already-streamed content to be re-appended.

**Fix:** Filter by message ID instead of slicing by index. `HistoryMessage.id` is a stable UUID on all history messages.

```typescript
// BEFORE:
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

This is the defensive safety net: Layer 1 (Task 1.1) eliminates the root-cause refetch; Layer 2 eliminates duplication from any race regardless of cause.

**Performance:** `new Set(messagesRef.current.map(...))` is O(n) on typical session sizes (< 200 messages). No memoization needed.

---

### Task 1.3 — Disable historyQuery polling in Relay mode

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`
**Lines:** 184-189
**Size:** Small | **Priority:** High

**Root cause:** `refetchInterval` polls every 3 seconds (active tab) even in Relay mode, where `sync_update` SSE events already drive all history invalidation. Each poll hits `GET /api/sessions/:id/messages`, contributing to the 503 storm.

**Fix:** Add `|| relayEnabled` to the existing `isStreaming` guard. `relayEnabled` is already in scope at line 85.

```typescript
// BEFORE:
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

**Critical TanStack Query v5 constraint:** Use `refetchInterval: () => false` — NOT `enabled: false`. In TanStack Query v5, `enabled: false` silently ignores `invalidateQueries()` calls, which would break post-stream history sync. The function form of `refetchInterval` returning `false` disables polling while preserving `invalidateQueries()` reactivity.

**EventSource loss coverage:** The existing staleness detector (lines 220-242) provides a 15-second fallback if no relay events arrive, covering EventSource reconnect windows.

---

### Task 1.4 — Add try/catch to GET /messages Express route handler

**File:** `apps/server/src/routes/sessions.ts`
**Lines:** 116-139
**Size:** Small | **Priority:** High

**Root cause:** Express 4 does not automatically forward unhandled async rejections in route handlers to error middleware. When `runtime.getMessageHistory()` or `runtime.getSessionETag()` throws, the request hangs — a proxy timeout then returns 503 to the client.

**Fix:** Add `next` parameter and wrap the async body in try/catch.

```typescript
// BEFORE:
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

Note: `assertBoundary(cwdParam, res)` remains outside the try/catch — it handles its own error responses internally.

**Scope:** Applies to all callers (not Relay-specific). Any future error from `getMessageHistory` or `getSessionETag` returns a proper 500 immediately.

---

## Phase 2: Tests

Tasks 2.1 and 2.2 can run in parallel (after their respective Phase 1 dependencies). Task 2.3 depends on both.

---

### Task 2.1 — Add sync_update guard tests to relay test suite

**File:** `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts`
**Depends on:** 1.1, 1.2
**Size:** Medium | **Priority:** Medium

Add two `it()` blocks inside the existing `describe('useChatSession relay protocol', ...)` suite:

**Test 1 — sync_update does NOT invalidate during streaming:**

```typescript
it('does not call invalidateQueries on sync_update while streaming', async () => {
  mockUseRelayEnabled.mockReturnValue(true);
  vi.mocked(mockTransport.sendMessageRelay).mockResolvedValue({
    messageId: 'msg-1',
    traceId: 'trace-1',
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

  function WrapperWithQueryClient({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TransportProvider as any, { transport: mockTransport }, children)
    );
  }

  const { result } = renderHook(() => useChatSession('session-1'), {
    wrapper: WrapperWithQueryClient,
  });

  act(() => {
    const es = MockEventSource.instances[0];
    es?.emit('stream_ready', { clientId: 'test-uuid-1' });
  });

  act(() => {
    result.current.setInput('hello');
  });
  await act(async () => {
    await result.current.handleSubmit();
  });

  expect(result.current.status).toBe('streaming');
  invalidateSpy.mockClear();

  act(() => {
    const es = MockEventSource.instances[0];
    es?.emit('sync_update', {});
  });

  expect(invalidateSpy).not.toHaveBeenCalled();
});
```

**Test 2 — sync_update DOES invalidate after streaming completes:**

```typescript
it('calls invalidateQueries on sync_update when status is idle', async () => {
  mockUseRelayEnabled.mockReturnValue(true);

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

  function WrapperWithQueryClient({ children }: { children: React.ReactNode }) {
    return React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(TransportProvider as any, { transport: mockTransport }, children)
    );
  }

  renderHook(() => useChatSession('session-1'), {
    wrapper: WrapperWithQueryClient,
  });

  invalidateSpy.mockClear();

  act(() => {
    const es = MockEventSource.instances[0];
    es?.emit('sync_update', {});
  });

  expect(invalidateSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      queryKey: ['messages', 'session-1', expect.anything()],
    })
  );
});
```

Use a real `QueryClient` instance (not the one from `createWrapper()`) so `invalidateQueries` can be spied on. The existing `MockEventSource`, `mockUseRelayEnabled`, and `createMockTransport()` infrastructure from the file are reused.

---

### Task 2.2 — Add GET /messages error-handling test to sessions test suite

**File:** `apps/server/src/routes/__tests__/sessions.test.ts`
**Depends on:** 1.4
**Size:** Small | **Priority:** Medium

Add one `it()` block in the existing test suite (locate the describe block for GET /messages tests):

```typescript
it('returns 500 when getMessageHistory throws', async () => {
  mockRuntime.getMessageHistory.mockRejectedValueOnce(new Error('I/O error'));

  const res = await request(app)
    .get(`/api/sessions/${S1}/messages`)
    .set('x-client-id', 'test-client');

  expect(res.status).toBe(500);
  expect(res.body).toHaveProperty('error');
});
```

The `mockRuntime`, `S1`, `request`, and `app` variables are already defined at module scope in the existing file. `mockRuntime.getMessageHistory` is already a `vi.fn()` — use `.mockRejectedValueOnce()` to make it throw for this test only.

This test FAILS before Task 1.4 is applied (request hangs or returns unexpected status). After the try/catch is added, Express error middleware returns 500 immediately.

---

### Task 2.3 — Run full test suite and verify no regressions

**Depends on:** 2.1, 2.2
**Size:** Small | **Priority:** Medium

```bash
# Full suite
pnpm test -- --run

# Targeted (faster feedback)
pnpm vitest run apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts
pnpm vitest run apps/server/src/routes/__tests__/sessions.test.ts

# Type checking
pnpm typecheck
```

All existing tests must pass. The 3 new tests (2 client, 1 server) must pass. `pnpm typecheck` must exit with code 0.

---

## Data Flow After Fixes

```
Relay mode — POST /messages
    ↓ 202 receipt
Relay EventSource (persistent SSE: relay.human.console.{clientId})
    ↓ relay_message events → streamEventHandler() → setMessages() [local state only]
    ↓ sync_update event → [FIXED: skipped when statusRef.current === 'streaming']
    ↓ done event → setStatus('idle') → seed effect runs [FIXED: ID-set dedup, no double-render]
    ↓ sync_update event → [NOW FIRES: status === 'idle'] → invalidateQueries() → history refetch

Polling query (historyQuery):
    [FIXED: refetchInterval returns false when relayEnabled=true — no polling in Relay mode]

GET /messages route:
    [FIXED: try/catch → next(err) → Express error middleware → 500 instead of hanging]
```

---

## Files Changed

| File                                                                                  | Tasks         |
| ------------------------------------------------------------------------------------- | ------------- |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`                      | 1.1, 1.2, 1.3 |
| `apps/server/src/routes/sessions.ts`                                                  | 1.4           |
| `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts` | 2.1           |
| `apps/server/src/routes/__tests__/sessions.test.ts`                                   | 2.2           |
