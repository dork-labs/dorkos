---
slug: fix-chat-streaming-and-model-selector-bugs
number: 113
created: 2026-03-10
status: specified
---

# Fix Chat Streaming & Model Selector Bugs

**Status:** Specified
**Authors:** Claude Code, 2026-03-10
**Branch:** preflight/fix-chat-streaming-and-model-selector-bugs
**Ideation:** [01-ideation.md](./01-ideation.md)
**Self-Test Report:** [test-results/chat-self-test/20260310-124718.md](../../test-results/chat-self-test/20260310-124718.md)

---

## Overview

Fix two chat UI bugs discovered during automated self-testing:

1. **P0 — User messages dropped during live Relay streaming:** A race condition in the history seeding logic causes optimistic user messages to be overwritten by stale server history when sessionId changes mid-stream (create-on-first-message pattern).

2. **P1 — Model selector dropdown doesn't visually update:** The optimistic `localModel` state is cleared before the TanStack Query cache propagates to subscribers, causing a one-frame render gap where the RadioGroup value mismatches all item values.

Both bugs are client-side only. No server changes required.

---

## Background / Problem Statement

### Bug 1: History Seeding Race Condition (P0)

When Relay transport is enabled, new sessions use a **create-on-first-message** pattern: `sessionId` starts as `null` and transitions to a UUID after the first message is sent. This sessionId change triggers two effects in `use-chat-session.ts`:

1. **Reset effect** (line 198): Sets `historySeededRef.current = false` unconditionally
2. **Seed effect** (line 206): When `historySeededRef` is false and history data exists, replaces the entire `messages` array with server history

The problem: during streaming, the server history doesn't yet contain the optimistic user message. The seed effect has no streaming guard on its initial-seed branch (line 211), so it overwrites the in-flight messages array with incomplete server history.

**Repro:** Relay enabled → new session → send 3+ messages → message 3's user bubble disappears during streaming → appears correctly after page reload.

### Bug 2: Optimistic State Timing Gap (P1)

In `use-session-status.ts`, the `updateSession` callback:

1. Sets `localModel` optimistically (line 80)
2. PATCHes the server (line 84)
3. Updates TanStack Query cache via `setQueryData` (line 85)
4. Clears `localModel` to null (line 90)

Step 4 fires synchronously after step 3, but `useQuery` subscribers re-render asynchronously. For one render frame, `localModel` is null while `session?.model` still holds the stale pre-PATCH value. The priority chain `localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL` resolves to the old model, causing the RadioGroup `value` prop to mismatch all item values and `aria-checked="false"` on every option.

**Repro:** Active session → click model selector → choose different model → status bar still shows previous model → eventually corrects after next message.

---

## Goals

- All user messages always visible during live streaming, regardless of sessionId transitions
- Model selector immediately reflects the selected model with correct `aria-checked` state
- Apply convergence pattern consistently to both `localModel` and `localPermissionMode`
- Regression tests covering both race conditions
- Zero behavior change for non-Relay transport paths

## Non-Goals

- Polling optimization (pulse/runs, git/status frequency) — P2, separate spec
- Tool call card rendering (empty tool_use messages after reload) — P2, separate spec
- Permission mode selector UI testing (not confirmed broken in self-test)
- React 19 `useOptimistic` migration (future consideration, not this fix)

---

## Technical Dependencies

- **React** ^19.0.0 — `useEffect`, `useState`, `useCallback`, `useRef`
- **@tanstack/react-query** ^5.62.0 — `useQuery`, `useQueryClient`, `setQueryData`
- **Vitest** ^2.1.0 + **@testing-library/react** — hook testing with `renderHook`, `waitFor`
- **@dorkos/test-utils** — `createMockTransport` factory

No new dependencies required.

---

## Detailed Design

### Bug 1 Fix: Streaming Guard on History Seed Effect

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

**Change:** Add an `isStreaming` guard to the initial-seed branch of the history seeding effect (line 211). When streaming is active, defer seeding until streaming completes — server history is incomplete during streaming, so seeding would overwrite valid optimistic state with stale data.

**Before (lines 206-215):**

```typescript
useEffect(() => {
  if (!historyQuery.data) return;

  const history = historyQuery.data.messages;

  if (!historySeededRef.current && history.length > 0) {
    historySeededRef.current = true;
    setMessages(history.map(mapHistoryMessage));
    return;
  }
  // ... polling update branch (already guarded by !isStreaming)
}, [historyQuery.data, isStreaming]);
```

**After:**

```typescript
useEffect(() => {
  if (!historyQuery.data) return;

  const history = historyQuery.data.messages;

  if (!historySeededRef.current && history.length > 0) {
    // Don't seed during streaming — server history is incomplete and would
    // overwrite optimistic messages (e.g. create-on-first-message sessionId change).
    // Seeding defers until streaming completes and this effect re-runs.
    if (isStreaming) return;
    historySeededRef.current = true;
    setMessages(history.map(mapHistoryMessage));
    return;
  }
  // ... polling update branch unchanged
}, [historyQuery.data, isStreaming]);
```

**Why this works:**

- The `isStreaming` dependency already exists in the effect (line 225), so when streaming transitions to idle, the effect re-runs and seeds normally
- The existing staleness detector (lines 227-250) handles the edge case where a `done` event is lost — it transitions status to idle, which triggers the seed
- Matches the existing guard philosophy at line 200 (`statusRef.current !== 'streaming'`)
- The polling update branch (line 217) already has `!isStreaming` guard — this makes both branches consistent

**Data flow after fix:**

```
User submits message
  → optimistic message added to state
  → sessionId changes (create-on-first-message)
  → reset effect fires: historySeededRef = false
  → historyQuery refetches (background)
  → seed effect fires: isStreaming=true → early return (deferred)
  → streaming completes → isStreaming=false
  → seed effect re-fires: seeds from complete history
  → optimistic message now in server history → no data loss
```

### Bug 2 Fix: Convergence Effect for Optimistic State

**File:** `apps/client/src/layers/entities/session/model/use-session-status.ts`

**Change:** Replace the eager `setLocalModel(null)` / `setLocalPermissionMode(null)` in the success path with a convergence `useEffect` that clears optimistic state only when the server-confirmed value matches.

**Before (lines 77-100):**

```typescript
const updateSession = useCallback(
  async (opts: UpdateSessionRequest) => {
    if (opts.model) setLocalModel(opts.model);
    if (opts.permissionMode) setLocalPermissionMode(opts.permissionMode);

    try {
      const updated = await transport.updateSession(sessionId, opts, selectedCwd ?? undefined);
      queryClient.setQueryData(['session', sessionId, selectedCwd], (old: Session | undefined) => ({
        ...old,
        ...updated,
      }));
      // Clear optimistic overrides — server data is now authoritative
      if (opts.model) setLocalModel(null);
      if (opts.permissionMode) setLocalPermissionMode(null);
      return updated;
    } catch {
      // Revert optimistic state on failure
      if (opts.model) setLocalModel(null);
      if (opts.permissionMode) setLocalPermissionMode(null);
    }
  },
  [transport, sessionId, selectedCwd, queryClient]
);
```

**After:**

```typescript
const updateSession = useCallback(
  async (opts: UpdateSessionRequest) => {
    if (opts.model) setLocalModel(opts.model);
    if (opts.permissionMode) setLocalPermissionMode(opts.permissionMode);

    try {
      const updated = await transport.updateSession(sessionId, opts, selectedCwd ?? undefined);
      queryClient.setQueryData(['session', sessionId, selectedCwd], (old: Session | undefined) => ({
        ...old,
        ...updated,
      }));
      // Optimistic state cleared by convergence effect below, not here.
      // This eliminates the render gap between setQueryData and useQuery re-render.
      return updated;
    } catch {
      // Revert optimistic state on failure
      if (opts.model) setLocalModel(null);
      if (opts.permissionMode) setLocalPermissionMode(null);
    }
  },
  [transport, sessionId, selectedCwd, queryClient]
);

// Convergence effect: clear optimistic overrides once server data confirms the value.
// This eliminates the render gap where localModel is null but session?.model is stale.
useEffect(() => {
  if (localModel !== null && session?.model === localModel) {
    setLocalModel(null);
  }
  if (localPermissionMode !== null && session?.permissionMode === localPermissionMode) {
    setLocalPermissionMode(null);
  }
}, [session?.model, session?.permissionMode, localModel, localPermissionMode]);
```

**Why this works:**

- `setQueryData` updates the cache synchronously, but the `useQuery` subscriber (`session`) re-renders on the next React commit
- The convergence effect fires after that commit — `session?.model` now holds the new value
- Only when `session?.model === localModel` does it clear the optimistic override
- The priority chain `localModel ?? ... ?? session?.model` always resolves to the correct value:
  - Before PATCH: `localModel` (optimistic)
  - After PATCH, before convergence: `localModel` (still set, same value)
  - After convergence: `session?.model` (authoritative)

**Edge case — server normalizes model ID differently:**

- If the server returns a different string (e.g., normalizes version suffix), convergence never fires
- The error/catch path already clears optimistic state as a safety net
- In practice, the server returns the exact model ID sent in the PATCH request

### Files Modified

| File                                                                  | Change                                 | Lines Affected              |
| --------------------------------------------------------------------- | -------------------------------------- | --------------------------- |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`      | Add streaming guard to seed effect     | ~211-214 (3 lines added)    |
| `apps/client/src/layers/entities/session/model/use-session-status.ts` | Convergence effect, remove eager clear | ~77-105 (rewrite ~15 lines) |

### Files NOT Modified

| File                           | Reason                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `ModelItem.tsx`                | RadioGroup value/item matching works correctly — bug was in the value source |
| `StatusLine.tsx`               | Props pass-through works correctly — inherits fix from use-session-status    |
| `use-message-queue.ts`         | Queue works correctly per ADR-0104                                           |
| `responsive-dropdown-menu.tsx` | Radix wrapper works correctly                                                |

---

## User Experience

Both fixes are invisible to users — they eliminate bugs rather than adding features:

1. **Before fix 1:** Occasionally a user message bubble disappears during streaming (especially on new sessions with Relay). After reload, it reappears. **After:** All messages always visible.

2. **Before fix 2:** Selecting a model from the dropdown has no immediate visual effect. The status bar continues showing the old model until the next message. **After:** Status bar immediately reflects the selection, dropdown shows correct checked state.

---

## Testing Strategy

### Bug 1: History Seeding Race Condition

**File:** `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts`

Add a new test case to the existing relay test suite:

```typescript
describe('history seeding during streaming', () => {
  it('does not overwrite optimistic messages when historySeededRef resets mid-stream', async () => {
    // Setup: relay enabled, no initial messages
    const transport = createMockTransport({
      getMessages: vi
        .fn()
        .mockResolvedValueOnce({ messages: [] }) // initial fetch
        .mockResolvedValueOnce({ messages: [{ id: 'msg-1', role: 'user', content: 'hello' }] }), // refetch after sessionId change
      sendMessageRelay: vi.fn().mockResolvedValue({ messageId: 'relay-1' }),
    });

    const { result } = renderHook(() => useChatSession({ sessionId: null, relayEnabled: true }), {
      wrapper: createWrapper(transport),
    });

    // User sends message → sessionId changes → streaming starts
    // Optimistic user message should be in state
    act(() => {
      result.current.submitMessage('hello');
    });

    // Simulate sessionId change triggering history reset + refetch
    // The seed effect should NOT replace messages during streaming

    await waitFor(() => {
      expect(result.current.messages).toContainEqual(
        expect.objectContaining({ role: 'user', content: expect.stringContaining('hello') })
      );
    });
  });
});
```

### Bug 2: Convergence Effect

**File:** `apps/client/src/layers/entities/session/__tests__/use-session-status.test.ts` (new file)

```typescript
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TransportProvider } from '@/layers/shared/model';
import { createMockTransport } from '@dorkos/test-utils';
import { useSessionStatus } from '../model/use-session-status';

function createWrapper(transport: ReturnType<typeof createMockTransport>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TransportProvider transport={transport}>{children}</TransportProvider>
    </QueryClientProvider>
  );
}

describe('useSessionStatus', () => {
  it('holds optimistic model until server confirms via query cache', async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
      updateSession: vi.fn().mockResolvedValue({
        model: 'claude-haiku-4-5-20251001',
      }),
    });

    const { result } = renderHook(
      () => useSessionStatus('s1', null, false),
      { wrapper: createWrapper(transport) }
    );

    // Wait for initial session query
    await waitFor(() => {
      expect(result.current.model).toBe('claude-sonnet-4-5-20250929');
    });

    // Trigger model change
    act(() => {
      result.current.updateSession({ model: 'claude-haiku-4-5-20251001' });
    });

    // Optimistic: should immediately show haiku
    expect(result.current.model).toBe('claude-haiku-4-5-20251001');

    // After PATCH resolves and convergence effect fires, should still show haiku
    await waitFor(() => {
      expect(result.current.model).toBe('claude-haiku-4-5-20251001');
    });

    // Verify no render frame showed the old model
    // (This validates the convergence pattern vs the old eager-clear pattern)
  });

  it('reverts optimistic model on PATCH failure', async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
      updateSession: vi.fn().mockRejectedValue(new Error('Network error')),
    });

    const { result } = renderHook(
      () => useSessionStatus('s1', null, false),
      { wrapper: createWrapper(transport) }
    );

    await waitFor(() => {
      expect(result.current.model).toBe('claude-sonnet-4-5-20250929');
    });

    act(() => {
      result.current.updateSession({ model: 'claude-haiku-4-5-20251001' });
    });

    // Optimistic: shows haiku immediately
    expect(result.current.model).toBe('claude-haiku-4-5-20251001');

    // After PATCH fails: reverts to sonnet
    await waitFor(() => {
      expect(result.current.model).toBe('claude-sonnet-4-5-20250929');
    });
  });

  it('applies convergence to permissionMode consistently', async () => {
    const transport = createMockTransport({
      getSession: vi.fn().mockResolvedValue({
        id: 's1',
        model: 'claude-sonnet-4-5-20250929',
        permissionMode: 'default',
      }),
      updateSession: vi.fn().mockResolvedValue({
        permissionMode: 'plan',
      }),
    });

    const { result } = renderHook(
      () => useSessionStatus('s1', null, false),
      { wrapper: createWrapper(transport) }
    );

    await waitFor(() => {
      expect(result.current.permissionMode).toBe('default');
    });

    act(() => {
      result.current.updateSession({ permissionMode: 'plan' });
    });

    expect(result.current.permissionMode).toBe('plan');

    await waitFor(() => {
      expect(result.current.permissionMode).toBe('plan');
    });
  });
});
```

### Test Coverage Matrix

| Scenario                             | Test Location                    | Type        |
| ------------------------------------ | -------------------------------- | ----------- |
| Seed deferred during streaming       | use-chat-session-relay.test.ts   | Unit (hook) |
| Seed fires after streaming completes | use-chat-session-relay.test.ts   | Unit (hook) |
| Optimistic model held through PATCH  | use-session-status.test.ts (new) | Unit (hook) |
| Optimistic model reverted on error   | use-session-status.test.ts (new) | Unit (hook) |
| Permission mode convergence          | use-session-status.test.ts (new) | Unit (hook) |

---

## Performance Considerations

- **Bug 1 fix:** Zero performance impact. Adds a single boolean check (`if (isStreaming) return`) to an existing effect.
- **Bug 2 fix:** Negligible impact. Adds one `useEffect` with four deps. The effect body is two simple equality checks with `setState(null)` calls. No network requests, no expensive computation.

---

## Security Considerations

No security implications. Both fixes are purely client-side state management changes with no new data flows, no new API calls, and no changes to data handling.

---

## Documentation

No documentation updates required. These are bug fixes with no API surface changes. The self-test report (`test-results/chat-self-test/20260310-124718.md`) already documents the bugs and will serve as the historical reference.

---

## Implementation Phases

### Phase 1: Bug Fixes (single phase — both fixes are small and independent)

1. **Add streaming guard to seed effect** in `use-chat-session.ts` (~3 lines)
2. **Implement convergence effect** in `use-session-status.ts` (~15 lines changed)
3. **Add regression tests** for both bugs
4. **Verify** with `pnpm typecheck && pnpm test -- --run`

No phased rollout needed — these are targeted bug fixes with minimal blast radius.

---

## Open Questions

None. All decisions were resolved during ideation:

1. P0 fix approach → Streaming guard only (3-line change, matches existing guard philosophy)
2. P1 fix approach → Convergence effect (eliminates render gap, data-driven, no structural changes)

---

## Related ADRs

- **ADR-0104** — Client-Side Message Queue with Auto-Flush: Queue works correctly; Bug 1 is upstream in history seeding. Fix does not affect queue behavior.

---

## References

- [Ideation document](./01-ideation.md)
- [Self-test report](../../test-results/chat-self-test/20260310-124718.md)
- [ADR-0104: Client-Side Message Queue](../../decisions/0104-client-side-message-queue-with-auto-flush.md)
- TanStack Query v5 — `setQueryData` synchronous cache update, asynchronous subscriber notification
- Radix UI RadioGroup — controlled `value` prop must exactly match an item `value` for `aria-checked="true"`
