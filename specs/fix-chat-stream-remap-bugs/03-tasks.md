# Tasks: Fix Chat UI Streaming Bugs — Duplicate Messages & Stale Model Display

**Spec:** `specs/fix-chat-stream-remap-bugs/02-specification.md`
**Spec number:** 126
**Total tasks:** 4
**Critical path:** Task 1 → Task 4 (parallel with Task 2 → Task 3)

---

## Parallel Execution Map

```
Task 1 (P1): Fix Bug #1 in stream-event-handler.ts    ─────────────────► Task 4 (P2): Regression tests for Bug #1
Task 2 (P1): Fix Bug #3 in use-session-status.ts      ─────────────────► Task 3 (P2): Regression tests for Bug #3
```

Tasks 1 and 2 have no dependencies on each other and can be executed in parallel. Tasks 3 and 4 (tests) require their respective fixes to land first.

---

## Task 1 — Fix Bug #1: Clear streaming buffer on session ID remap

**Priority:** P1
**Status:** todo
**Parallel group:** `core-fixes` (can run in parallel with Task 2)
**Depends on:** nothing

### File

`apps/client/src/layers/features/chat/model/stream-event-handler.ts`

### Problem

When the server returns a different session ID than the client-generated one in the SSE `done` event, the streaming assistant message (client-generated UUID) and the history copy (SDK-assigned UUID) both render. The deduplication guard in `use-chat-session.ts` uses a `Set` of current message IDs — since the IDs never match, it admits both copies. Every assistant response after the first appears twice.

### Root Cause

The `done` handler calls `onSessionIdChangeRef.current?.(doneData.sessionId)` without first clearing the streaming buffer. The session-change `useEffect` in `use-chat-session.ts` (line 164-172) has a guard that skips `setMessages([])` when `statusRef.current === 'streaming'` — and status is still `'streaming'` when the remap fires (it only becomes `'idle'` three lines later, at `setStatus('idle')`). The streaming buffer is never cleared, so history appends both copies.

### Change

**Location:** `done` case, lines 292–311 of `stream-event-handler.ts`

**Before:**

```typescript
case 'done': {
  const doneData = data as { sessionId?: string };
  if (doneData.sessionId && doneData.sessionId !== sessionId) {
    onSessionIdChangeRef.current?.(doneData.sessionId);
  }
  // ... rest unchanged
```

**After:**

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
  // ... rest unchanged
```

No interface changes — `currentPartsRef`, `assistantCreatedRef`, and `setMessages` are all already in scope (destructured from `deps` at lines 66–86).

### Acceptance Criteria

- When `done` fires with `doneData.sessionId !== sessionId`: `setMessages([])` is called, `currentPartsRef.current` is `[]`, and `assistantCreatedRef.current` is `false` — all BEFORE `onSessionIdChangeRef.current?.()` fires
- When `done` fires with `doneData.sessionId === sessionId` (normal stream end, no remap): none of the above three operations happen
- TypeScript compilation passes with no new errors
- All existing tests in `stream-event-handler-part-id.test.ts` pass

---

## Task 2 — Fix Bug #3: Gate streamingStatus.model behind isStreaming

**Priority:** P1
**Status:** todo
**Parallel group:** `core-fixes` (can run in parallel with Task 1)
**Depends on:** nothing

### File

`apps/client/src/layers/entities/session/model/use-session-status.ts`

### Problem

After streaming ends, changing the model via the dropdown does not update the status bar. The bar continues showing the model from the last SSE `session_status` event. The user must navigate away and back to see the change take effect.

### Root Cause

`streamingStatus` is never cleared after streaming ends. The priority chain:

```typescript
const model = localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL;
```

evaluates `streamingStatus?.model` unconditionally, so it permanently shadows `session?.model`. Model changes go through `transport.updateSession()` → PATCH → `queryClient.setQueryData()` (which updates `session.model`) — but because `streamingStatus?.model` is still set to the last SSE value, `session?.model` is never reached in the chain.

### Change

**Location:** Lines 68–69 of `use-session-status.ts`

**Before:**

```typescript
// Priority: local optimistic > streaming live data > persisted session data > defaults
const model = localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL;
```

**After:**

```typescript
// Priority: local optimistic > streaming live data (only while streaming) > persisted session data > defaults
// Gate streamingStatus?.model behind isStreaming: after streaming ends, session?.model is
// the authoritative value (set via PATCH). Without this gate, the stale streamingStatus.model
// permanently shadows session.model, making model changes invisible in the status bar.
const model =
  localModel ?? (isStreaming ? streamingStatus?.model : null) ?? session?.model ?? DEFAULT_MODEL;
```

`streamingStatus` is NOT cleared — `streamingStatus.contextTokens` and `streamingStatus.costUsd` are used by lines 72–78 for context percentage and cost display, and those remain unchanged.

### Acceptance Criteria

- When `isStreaming` is `false`: computed `model` equals `session?.model` (not `streamingStatus?.model`) when `localModel` is null
- When `isStreaming` is `true`: computed `model` equals `streamingStatus?.model` when `localModel` is null and `streamingStatus?.model` is set
- Lines 72–78 (`contextTokens`, `contextMaxTokens`, `costUsd`) are not touched and continue to function
- TypeScript compilation passes with no new errors
- All existing tests in `use-session-status.test.tsx` pass

---

## Task 3 — Add regression tests for Bug #3 in use-session-status.test.tsx

**Priority:** P2
**Status:** todo
**Parallel group:** none (sequential after Task 2)
**Depends on:** Task 2

### File

`apps/client/src/layers/entities/session/__tests__/use-session-status.test.tsx`

### What to Add

Append two `it(...)` blocks to the existing `describe('useSessionStatus')` block (after the last test case at line 135, before the closing `});`).

**New import required:** Add `import type { SessionStatusEvent } from '@dorkos/shared/types';` to the imports section. All other needed symbols (`renderHook`, `waitFor`, `vi`, `createMockTransport`, `useSessionStatus`, `createWrapper`) are already imported by the file.

#### Test 1: stale streamingStatus does not shadow session model after streaming

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
    () => useSessionStatus('s1', streamingStatus as SessionStatusEvent, false),
    { wrapper: createWrapper(transport) }
  );

  await waitFor(() => {
    // session?.model should win; streamingStatus.model must NOT override it
    expect(result.current.model).toBe('claude-haiku-4-5-20251001');
  });
});
```

#### Test 2: streamingStatus.model IS used while streaming

```typescript
it('uses streamingStatus.model while isStreaming is true', async () => {
  // Purpose: Verify the fix does not break live-streaming display of model name.
  const transport = createMockTransport({
    getSession: vi.fn().mockResolvedValue({
      id: 's1',
      model: 'claude-sonnet-4-5-20250929',
      permissionMode: 'default',
    }),
  });

  const streamingStatus = { model: 'claude-opus-4-6' }; // live streaming value

  const { result } = renderHook(
    () => useSessionStatus('s1', streamingStatus as SessionStatusEvent, true),
    { wrapper: createWrapper(transport) }
  );

  // streamingStatus.model should be used during streaming (synchronous — no await needed)
  expect(result.current.model).toBe('claude-opus-4-6');
});
```

### Acceptance Criteria

- Test 1 passes: `result.current.model` resolves to `'claude-haiku-4-5-20251001'`, not `'claude-sonnet-4-6'`
- Test 2 passes: `result.current.model` is immediately `'claude-opus-4-6'` (synchronous, no `waitFor`)
- All three existing tests in the file continue to pass
- No TypeScript errors (the `as SessionStatusEvent` cast is sufficient)

---

## Task 4 — Add regression tests for Bug #1 in stream-event-handler-remap.test.ts

**Priority:** P2
**Status:** todo
**Parallel group:** none (sequential after Task 1)
**Depends on:** Task 1

### File

`apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-remap.test.ts` (new file)

### What to Create

Create a new test file following the exact import style and `createMinimalDeps` factory pattern established by the adjacent `stream-event-handler-part-id.test.ts`.

The `createMinimalDeps` factory must accept an optional overrides object `{ sessionId?, onSessionIdChange? }` so tests can control the `sessionId` and capture the `onSessionIdChangeRef` callback for call-order verification.

#### Test 1: remap clears streaming state before firing the callback

```typescript
it('clears messages and resets refs when done event carries a new sessionId', () => {
  // Purpose: Regression for Bug #1 — when the server remaps the session UUID in the
  // done event, the client must clear the streaming buffer so history is the sole
  // source of truth. Without this, the streaming assistant message (client UUID) and
  // the history copy (SDK UUID) both render, creating a duplicate.
  const onSessionIdChangeFn = vi.fn();
  const { handler, currentPartsRef, assistantCreatedRef, setMessages, onSessionIdChangeRef } =
    createMinimalDeps({ sessionId: 'client-uuid', onSessionIdChange: onSessionIdChangeFn });

  // Simulate accumulated streaming state
  currentPartsRef.current = [{ type: 'text', text: 'hello' } as MessagePart];
  assistantCreatedRef.current = true;

  handler('done', { sessionId: 'sdk-uuid' }, 'assistant-id');

  expect(setMessages).toHaveBeenCalledWith([]);
  expect(currentPartsRef.current).toEqual([]);
  expect(assistantCreatedRef.current).toBe(false);
  expect(onSessionIdChangeRef.current).toHaveBeenCalledWith('sdk-uuid');

  // ORDER: setMessages([]) must precede onSessionIdChange
  expect(setMessages.mock.invocationCallOrder[0]).toBeLessThan(
    onSessionIdChangeFn.mock.invocationCallOrder[0]
  );
});
```

#### Test 2: normal done (no remap) does not clear the buffer

```typescript
it('does not clear messages on done event when sessionId is unchanged', () => {
  // Purpose: Ensure the remap clear only triggers when sessionId actually changes.
  // Normal stream completion must not wipe the message buffer.
  const { handler, currentPartsRef, assistantCreatedRef, setMessages, onSessionIdChangeRef } =
    createMinimalDeps({ sessionId: 'same-uuid' });

  currentPartsRef.current = [{ type: 'text', text: 'hello' } as MessagePart];
  assistantCreatedRef.current = true;

  handler('done', { sessionId: 'same-uuid' }, 'assistant-id');

  // setMessages must NOT have been called with [] specifically
  const emptyArrayCalls = setMessages.mock.calls.filter(
    (call) => Array.isArray(call[0]) && call[0].length === 0
  );
  expect(emptyArrayCalls).toHaveLength(0);
  expect(onSessionIdChangeRef.current).not.toHaveBeenCalled();
});
```

### Acceptance Criteria

- Test 1 passes including the `invocationCallOrder` assertion (order of operations verified)
- Test 2 passes: no `setMessages([])` call and no `onSessionIdChangeRef.current` call
- All existing tests in `stream-event-handler-part-id.test.ts` continue to pass
- File uses the same `import { describe, it, expect, vi } from 'vitest'` style as the adjacent test file
- No TypeScript errors introduced

---

## Summary

| #   | Title                                                     | Priority | Parallel Group | Depends On |
| --- | --------------------------------------------------------- | -------- | -------------- | ---------- |
| 1   | Fix Bug #1: clear streaming buffer on remap               | P1       | `core-fixes`   | —          |
| 2   | Fix Bug #3: gate streamingStatus.model behind isStreaming | P1       | `core-fixes`   | —          |
| 3   | Regression tests for Bug #3                               | P2       | —              | Task 2     |
| 4   | Regression tests for Bug #1                               | P2       | —              | Task 1     |

**Critical path length:** 2 steps (P1 fix → P2 tests)
**Parallelism:** Tasks 1 and 2 are independent and can run concurrently
**New files:** 1 (`stream-event-handler-remap.test.ts`)
**Modified files:** 3 (`stream-event-handler.ts`, `use-session-status.ts`, `use-session-status.test.tsx`)
**Server changes:** none
**New dependencies:** none
