---
slug: fix-chat-stream-remap-bugs
number: 126
status: specified
created: 2026-03-12
ideation: specs/fix-chat-stream-remap-bugs/01-ideation.md
---

# Fix Chat UI Streaming Bugs — Duplicate Messages & Stale Model Display

**Status:** Specified
**Authors:** Claude Code — 2026-03-12
**Ideation:** `specs/fix-chat-stream-remap-bugs/01-ideation.md`

---

## Overview

Fix two client-only bugs in the chat UI that manifest after the first stream of a new conversation. Both bugs are caused by the session ID remap flow: when the user sends their first message, the client pre-generates a UUID for the session URL (`?session=client-uuid`); the server assigns an SDK UUID and returns it in the SSE `done` event (`session_id_remapped: sdk-uuid`). The client then updates its session ID, triggers a history re-fetch, and continues. Two things go wrong during this transition.

**Bug #1 (Critical):** Every assistant response after the first appears twice — once before the user's message bubble (from streaming state) and once after it (from history). This makes every active conversation look broken.

**Bug #3:** After streaming ends, changing the model via the dropdown does not update the status bar. The bar continues showing the model from the last SSE `session_status` event.

Both bugs are isolated to `apps/client/` — no server changes required.

---

## Background / Problem Statement

### Session ID Remap Flow

DorkOS's create-on-first-message pattern means:

1. A new session starts with a client-generated UUID in the URL
2. The user sends their first message; the server creates an SDK session with its own UUID
3. The SSE stream for that first message ends with a `done` event that includes the SDK UUID
4. The client detects the mismatch and calls `onSessionIdChangeRef.current?.(sdkUuid)`, updating the URL
5. This triggers a TanStack Query re-fetch of `['messages', sdkUuid, cwd]`

This flow is correct and intentional. The bugs are in how the client state responds to the remap.

### Why Bug #1 (Duplicate Messages) Occurs

Two compounding failures:

**Failure 1 — `setMessages([])` guard incorrectly blocks clearing:**

In `use-chat-session.ts:164-172`:

```typescript
useEffect(() => {
  historySeededRef.current = false;
  if (statusRef.current !== 'streaming') {
    // ← guard
    setMessages([]);
  }
}, [sessionId, selectedCwd]);
```

The comment explains the intent: "Don't clear messages during streaming — preserves state during create-on-first-message (null → clientId) and done redirect (clientId → sdkId)." The guard was designed to prevent clearing during the `null → clientId` remap (which happens before any streaming). But it also blocks clearing during the `clientId → sdkId` remap, which happens AFTER streaming ends — and this is wrong.

**Failure 2 — ID-mismatch deduplication failure:**

The streaming assistant message in `messages[]` has `assistantIdRef.current` (a client-generated UUID). When history arrives from the SDK session, the same assistant message has an SDK-assigned UUID. The seed effect's `currentIds` Set in `use-chat-session.ts:191` cannot match them, so both copies render:

```typescript
const currentIds = new Set(messagesRef.current.map((m) => m.id));
const newMessages = history.filter((m) => !currentIds.has(m.id)); // dedup misses
```

**Root cause: `done` handler fires `onSessionIdChangeRef` BEFORE `setStatus('idle')`** (`stream-event-handler.ts:294-310`). When the session-change effect fires, `statusRef.current` is still `'streaming'`, so `setMessages([])` is skipped. The streaming buffer is never cleared. History then appends both the user bubble and the assistant message with a different UUID — duplicate.

### Why Bug #3 (Stale Model) Occurs

The model priority chain in `use-session-status.ts:69`:

```typescript
const model = localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL;
```

`streamingStatus?.model` is set during streaming via `session_status` SSE events. After streaming ends, `sessionStatus` is **never cleared**. The convergence effect (lines 116–123) only clears `localModel`. So `streamingStatus?.model` persists indefinitely and permanently shadows `session?.model` (which correctly reflects the PATCH response after a model change).

Permission mode has no equivalent `streamingStatus` field, which is why it works correctly.

---

## Goals

- Eliminate the duplicate assistant message rendering during live streaming
- After stream completion, model changes via the dropdown must immediately reflect in the status bar
- Zero regressions: history reload, permission mode, context percentage, cost display all unchanged
- Add regression tests for both bugs

---

## Non-Goals

- Bug #2: Model selector no-op before first message (separate scope)
- UX Issue #1: First message appears without bubble during remap window (separate scope)
- Server-side changes of any kind
- Approach D (stable assistant ID via server echo) — principled long-term fix, but requires server changes; track as follow-up
- Tool call card not rendering (separate issue, different root cause)

---

## Technical Dependencies

- React 19 (auto-batching, `useEffect`, `useRef`)
- TanStack Query v5 (`useQuery`, query cache)
- TypeScript strict mode
- Vitest + React Testing Library (for new tests)

No new dependencies required.

---

## Detailed Design

### Change 1: Clear Streaming Buffer in `done` Handler on Remap

**File:** `apps/client/src/layers/features/chat/model/stream-event-handler.ts`

**Location:** `done` case, lines 292–311

**Current code:**

```typescript
case 'done': {
  const doneData = data as { sessionId?: string };
  if (doneData.sessionId && doneData.sessionId !== sessionId) {
    onSessionIdChangeRef.current?.(doneData.sessionId);
  }
  if (streamStartTimeRef.current) {
    const elapsed = Date.now() - streamStartTimeRef.current;
    if (elapsed >= TIMING.MIN_STREAM_DURATION_MS) {
      onStreamingDoneRef.current?.();
    }
  }
  streamStartTimeRef.current = null;
  estimatedTokensRef.current = 0;
  setStreamStartTime(null);
  setEstimatedTokens(0);
  if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
  isTextStreamingRef.current = false;
  setIsTextStreaming(false);
  setStatus('idle');
  break;
}
```

**New code:**

```typescript
case 'done': {
  const doneData = data as { sessionId?: string };
  if (doneData.sessionId && doneData.sessionId !== sessionId) {
    // Clear streaming state BEFORE triggering the remap so history becomes
    // the sole source of truth. The streaming assistant message has a
    // client-generated UUID that won't match the SDK-assigned UUID in history —
    // without this clear, both copies render (ID-mismatch dedup failure).
    currentPartsRef.current = [];
    assistantCreatedRef.current = false;
    setMessages([]);
    onSessionIdChangeRef.current?.(doneData.sessionId);
  }
  if (streamStartTimeRef.current) {
    const elapsed = Date.now() - streamStartTimeRef.current;
    if (elapsed >= TIMING.MIN_STREAM_DURATION_MS) {
      onStreamingDoneRef.current?.();
    }
  }
  streamStartTimeRef.current = null;
  estimatedTokensRef.current = 0;
  setStreamStartTime(null);
  setEstimatedTokens(0);
  if (textStreamingTimerRef.current) clearTimeout(textStreamingTimerRef.current);
  isTextStreamingRef.current = false;
  setIsTextStreaming(false);
  setStatus('idle');
  break;
}
```

**Why this works:**

- `setMessages([])` clears the streaming buffer. After the remap fires and the TanStack Query re-fetch completes, history becomes the sole source of truth.
- `currentPartsRef.current = []` and `assistantCreatedRef.current = false` reset the streaming accumulator state. Without this, the next stream in the session would call `ensureAssistantMessage` with `assistantCreatedRef.current = true` and skip creating the message row.
- Both refs are already in scope (destructured from `deps` at line 66–86); no interface changes.
- `setMessages` is already in `StreamEventDeps` (line 27); no signature change.
- The remap clears happen only when `doneData.sessionId !== sessionId` — no effect on normal session-end (no remap).

**UX trade-off:** A brief flash of empty messages between the clear and the history arrival (~50–200ms) is possible. This is the same behavior as switching between sessions manually and is acceptable for DorkOS's power-user audience. The flash occurs only during session creation (once per conversation), not mid-conversation.

---

### Change 2: Gate `streamingStatus?.model` Behind `isStreaming`

**File:** `apps/client/src/layers/entities/session/model/use-session-status.ts`

**Location:** Line 69

**Current code:**

```typescript
// Priority: local optimistic > streaming live data > persisted session data > defaults
const model = localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL;
```

**New code:**

```typescript
// Priority: local optimistic > streaming live data (only while streaming) > persisted session data > defaults
// Gate streamingStatus?.model behind isStreaming: after streaming ends, session?.model is
// the authoritative value (set via PATCH). Without this gate, the stale streamingStatus.model
// permanently shadows session.model, making model changes invisible in the status bar.
const model =
  localModel ?? (isStreaming ? streamingStatus?.model : null) ?? session?.model ?? DEFAULT_MODEL;
```

**Why this works:**

- During streaming, `streamingStatus?.model` correctly shows the live model from SSE events (important for cases where the model is set server-side).
- After streaming (`isStreaming = false`), the chain falls through to `session?.model`, which is the PATCH-confirmed value from the query cache.
- `streamingStatus` itself is NOT cleared — `streamingStatus.contextTokens` and `streamingStatus.costUsd` continue to function for context percentage and cost display (lines 72–78 are unchanged).
- Permission mode already works correctly because it has no `streamingStatus` equivalent — this change makes model behavior consistent with permission mode.
- `isStreaming` is already passed as the third parameter and is available in scope.

---

### Data Flow After Fixes

**Bug #1 — Post-fix flow:**

```
1. Stream active → messages[] = [user bubble (pendingUserContent), streaming assistant msg (client UUID)]
2. done event fires → remap detected
3. setMessages([]), currentPartsRef = [], assistantCreatedRef = false
4. onSessionIdChangeRef("sdk-uuid") → URL updates → historyQuery refetches
5. setStatus('idle')
6. History arrives → seed effect replaces messages[] with [user msg (sdk UUID), assistant msg (sdk UUID)]
7. Result: single copy, correct order ✓
```

**Bug #3 — Post-fix flow:**

```
1. Stream ends → isStreaming = false
2. User selects Haiku → PATCH 200 → session.model = "claude-haiku-..."
3. Model computed: null ?? (false ? "sonnet" : null) ?? "claude-haiku-..." → "claude-haiku-..." ✓
4. Status bar shows Haiku immediately ✓
```

---

## Testing Strategy

### Existing Test Files

- `apps/client/src/layers/entities/session/__tests__/use-session-status.test.tsx` — already tests optimistic model update; add Bug #3 regression
- `apps/client/src/layers/features/chat/__tests__/use-chat-session.test.tsx` — add Bug #1 regression

### New Test Cases

#### `use-session-status.test.tsx` — Add to `describe('useSessionStatus')`

**Test: stale streamingStatus does not shadow session model after streaming**

```typescript
it('does not use streamingStatus.model when isStreaming is false', async () => {
  // Purpose: Regression for Bug #3 — after a stream, the stale streamingStatus.model
  // must not override session.model, so model changes via PATCH are reflected immediately.
  const transport = createMockTransport({
    getSession: vi.fn().mockResolvedValue({
      id: 's1',
      model: 'claude-haiku-4-5-20251001', // PATCH-confirmed value
      permissionMode: 'default',
    }),
  });

  const streamingStatus = { model: 'claude-sonnet-4-6' }; // stale post-stream value

  const { result } = renderHook(
    () =>
      useSessionStatus('s1', streamingStatus as SessionStatusEvent, false /* isStreaming=false */),
    { wrapper: createWrapper(transport) }
  );

  await waitFor(() => {
    // session?.model should win; streamingStatus.model must NOT override it
    expect(result.current.model).toBe('claude-haiku-4-5-20251001');
  });
});
```

**Test: streamingStatus.model IS used while streaming**

```typescript
it('uses streamingStatus.model while isStreaming is true', async () => {
  // Purpose: Verify the fix doesn't break the live-streaming display of model name.
  const transport = createMockTransport({
    getSession: vi.fn().mockResolvedValue({
      id: 's1',
      model: 'claude-sonnet-4-5-20250929',
      permissionMode: 'default',
    }),
  });

  const streamingStatus = { model: 'claude-opus-4-6' }; // live streaming value

  const { result } = renderHook(
    () =>
      useSessionStatus('s1', streamingStatus as SessionStatusEvent, true /* isStreaming=true */),
    { wrapper: createWrapper(transport) }
  );

  // streamingStatus.model should be used during streaming
  expect(result.current.model).toBe('claude-opus-4-6');
});
```

#### `use-chat-session.test.tsx` (or new `stream-event-handler.test.ts`)

The `createStreamEventHandler` function is a pure factory that can be tested in isolation:

**Test: done event with remap clears streaming state**

```typescript
describe('createStreamEventHandler', () => {
  it('clears messages and resets refs when done event carries a new sessionId', () => {
    // Purpose: Regression for Bug #1 — when the server remaps the session UUID in the
    // done event, the client must clear the streaming buffer so history is the sole truth.
    // Without this, the streaming assistant message (client UUID) and the history copy
    // (SDK UUID) both render, creating a duplicate.
    const setMessages = vi.fn();
    const onSessionIdChangeRef = { current: vi.fn() };
    const currentPartsRef = { current: [{ type: 'text', text: 'hello' }] };
    const assistantCreatedRef = { current: true };

    const handler = createStreamEventHandler({
      currentPartsRef,
      assistantCreatedRef,
      setMessages,
      onSessionIdChangeRef,
      sessionId: 'client-uuid',
      // ... other required deps with vi.fn() stubs
    } as StreamEventDeps);

    handler('done', { sessionId: 'sdk-uuid' }, 'assistant-id');

    // Streaming state must be cleared before remap fires
    expect(setMessages).toHaveBeenCalledWith([]);
    expect(currentPartsRef.current).toEqual([]);
    expect(assistantCreatedRef.current).toBe(false);
    expect(onSessionIdChangeRef.current).toHaveBeenCalledWith('sdk-uuid');
    // setMessages([]) must be called BEFORE onSessionIdChangeRef
    expect(setMessages.mock.invocationCallOrder[0]).toBeLessThan(
      onSessionIdChangeRef.current.mock.invocationCallOrder[0]
    );
  });

  it('does NOT clear messages on done event when sessionId is unchanged', () => {
    // Purpose: Ensure the clear only happens on remap, not every done event.
    const setMessages = vi.fn();
    const onSessionIdChangeRef = { current: vi.fn() };
    const currentPartsRef = { current: [{ type: 'text', text: 'hello' }] };
    const assistantCreatedRef = { current: true };

    const handler = createStreamEventHandler({
      currentPartsRef,
      assistantCreatedRef,
      setMessages,
      onSessionIdChangeRef,
      sessionId: 'same-uuid',
      // ... other required deps with vi.fn() stubs
    } as StreamEventDeps);

    handler('done', { sessionId: 'same-uuid' }, 'assistant-id');

    expect(setMessages).not.toHaveBeenCalledWith([]);
    expect(onSessionIdChangeRef.current).not.toHaveBeenCalled();
  });
});
```

### Non-Regression Tests

Confirm these existing tests continue to pass without modification:

- `use-session-status.test.tsx`: "holds optimistic model until server confirms via query cache"
- Any existing test that exercises history loading on session switch
- Any existing test for permission mode display

---

## User Experience

### Bug #1 Post-Fix

- **Before:** `[assistant response] [user bubble] [assistant response]` — broken, every conversation
- **After:** `[user bubble] [assistant response]` — correct, always
- **Flash:** A ~50–200ms empty state is possible during the remap transition (session creation only). This is sub-perceptible at normal SSE speeds and consistent with the existing session-switch UX.

### Bug #3 Post-Fix

- **Before:** Model selector change (PATCH 200) doesn't update the status bar — user must navigate away and back to see the change
- **After:** Model change reflects immediately in the status bar after PATCH completes

---

## Performance Considerations

- Both changes are O(1) — no loops, no new queries
- Change 1 adds 3 synchronous operations (`=`, `=`, `setMessages([])`) before an already-existing function call
- Change 2 adds one conditional expression to a constant declaration
- No measurable performance impact

---

## Security Considerations

None. These are client-only rendering fixes with no auth, data access, or network changes.

---

## Documentation

- No user-facing docs require updates
- `contributing/state-management.md` may benefit from a note about the streaming status priority chain, but this is optional polish

---

## Implementation Phases

### Phase 1: Core Bug Fixes (Complete This Spec)

1. Modify `stream-event-handler.ts` — clear streaming state on remap in `done` handler
2. Modify `use-session-status.ts` — gate `streamingStatus?.model` behind `isStreaming`

### Phase 2: Regression Tests

3. Add `use-session-status.test.tsx` — two new test cases for Bug #3
4. Add `stream-event-handler.test.ts` (or extend `use-chat-session.test.tsx`) — two new test cases for Bug #1

### Phase 3: Verify (Optional Follow-Up)

5. Run the `/chat:self-test` browser test to confirm no duplication on messages 3+
6. File a follow-up spec for the long-term fix: "Server Echo of SDK Assistant ID in `done` event"

---

## Open Questions

No unresolved questions. All decisions recorded in `specs/fix-chat-stream-remap-bugs/01-ideation.md` Section 6.

---

## Related ADRs

- **ADR-0117** (if exists): Direct SSE as sole web client transport — defines that the POST response body IS the SSE stream; the `done` event carrying `sessionId` is the canonical remap signal.

---

## References

- `test-results/chat-self-test/20260312-085236.md` — Self-test that confirmed both bugs with repro steps
- `specs/fix-chat-stream-remap-bugs/01-ideation.md` — Ideation with root cause analysis and approach comparison
- `research/20260312_fix_chat_stream_remap_bugs.md` — Research report (created by research agent)
- `research/20260310_fix_chat_streaming_model_selector_bugs.md` — Prior research on Bug #3
- `specs/chat-streaming-session-reliability/` (spec #93) — Adjacent reliability spec
