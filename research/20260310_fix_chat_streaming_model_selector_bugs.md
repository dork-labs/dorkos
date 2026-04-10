---
title: 'Fix Chat Streaming & Model Selector Bugs — Optimistic Message Drop & RadioGroup Desync'
date: 2026-03-10
type: implementation
status: active
tags:
  [
    chat,
    streaming,
    optimistic-ui,
    tanstack-query,
    radix-ui,
    radiogroup,
    history-seeding,
    race-condition,
    model-selector,
  ]
feature_slug: fix-chat-streaming-and-model-selector-bugs
searches_performed: 7
sources_count: 14
---

# Research Summary

Two discrete bugs were analyzed by reading the actual source code (`use-chat-session.ts`, `use-session-status.ts`, `ModelItem.tsx`, `StatusLine.tsx`) alongside targeted web research. Bug 1 (P0) is a race condition where the history-seeding `useEffect` in `use-chat-session.ts` replaces the entire `messages` array with server history after `historySeededRef` is reset on session-ID change — dropping any optimistic user message that hasn't yet been persisted. Bug 2 (P1) is a two-phase render gap in `use-session-status.ts` where `setLocalModel(null)` and `queryClient.setQueryData(...)` are called in sequence, but React batches the `null` clear before the query cache update propagates, leaving the RadioGroup `value` briefly undefined.

Both bugs have surgical, low-risk fixes that follow established patterns already in the codebase.

---

# Key Findings

## 1. Bug 1 Root Cause — History Seed Overwrites Optimistic Message

**Exact code location:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

**The sequence:**

1. User sends a message. `sessionId` is `null` → `executeSubmission` generates a client-side UUID, calls `onSessionIdChangeRef.current?.(targetSessionId)`, which propagates the new ID upward (into the URL param, into the `sessionId` prop passed to `useChatSession`).
2. `setMessages((prev) => [...prev, userMessage])` appends the optimistic user message.
3. `setStatus('streaming')` and `statusRef.current = 'streaming'` are set synchronously.
4. React re-renders: `sessionId` prop is now the new UUID. The effect at **lines 198-203** fires:
   ```typescript
   useEffect(() => {
     historySeededRef.current = false;
     if (statusRef.current !== 'streaming') {
       setMessages([]);
     }
   }, [sessionId, selectedCwd]);
   ```
   Because `statusRef.current` is `'streaming'`, `setMessages([])` is suppressed. Good so far.
5. The history query now has `enabled: true` (sessionId is set). It fires a network request.
6. The history query returns — either immediately with an empty array, or slightly delayed with content. When `historyQuery.data` changes, the seed effect at **lines 206-225** fires:
   ```typescript
   useEffect(() => {
     if (!historyQuery.data) return;
     const history = historyQuery.data.messages;
     if (!historySeededRef.current && history.length > 0) {
       historySeededRef.current = true;
       setMessages(history.map(mapHistoryMessage)); // ← REPLACES entire array
       return;
     }
     // ...
   }, [historyQuery.data, isStreaming]);
   ```
   `historySeededRef.current` was just reset to `false` in step 4. If `history.length > 0` (i.e., the session existed previously and history loaded), `setMessages(history.map(...))` blows away the optimistic user message entirely.

**The race window:** The window is narrow but real — it spans from when `onSessionIdChangeRef.current?.(targetSessionId)` fires (propagating the new ID upward) to when the streaming `done` event arrives and history is re-seeded from server data. During this window, if a history refetch completes and `history.length > 0`, the optimistic message is gone.

**Why the guard doesn't fully protect:** The guard `if (statusRef.current !== 'streaming')` only prevents `setMessages([])`. It does NOT guard the seed effect's `setMessages(history.map(...))`. There is no streaming guard in the seed logic.

---

## 2. Bug 2 Root Cause — RadioGroup Value Falls Through on Optimistic Clear

**Exact code location:** `apps/client/src/layers/entities/session/model/use-session-status.ts`

**The sequence:**

```typescript
const updateSession = useCallback(async (opts) => {
  if (opts.model) setLocalModel(opts.model);       // 1. Optimistic set
  try {
    const updated = await transport.updateSession(...); // 2. PATCH
    queryClient.setQueryData(                        // 3. Cache update
      ['session', sessionId, selectedCwd],
      (old) => ({ ...old, ...updated })
    );
    if (opts.model) setLocalModel(null);             // 4. Clear optimistic
  } catch {
    if (opts.model) setLocalModel(null);             // Rollback
  }
}, [...]);
```

**The problem:** Steps 3 and 4 both trigger React renders. The priority chain for `model` is:

```typescript
const model = localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL;
```

When step 4 (`setLocalModel(null)`) fires, React schedules a re-render. `localModel` becomes `null`. The fallback is `streamingStatus?.model ?? session?.model`. `session` comes from the `useQuery` for `['session', sessionId, selectedCwd]`.

`setQueryData` updates the cache synchronously, but `useQuery` subscribers re-render on the next React render cycle. In React 18+, `setState` and `setQueryData` called in the same async continuation (after `await`) are NOT automatically batched together — they may produce two separate render commits.

**The two-render gap:**

- Render A: `localModel = null`, `session` still has the OLD value (the `useQuery` hasn't re-rendered yet). If the old `session.model` is stale (e.g., cache was set from a previous server response that differs), `model` resolves to a stale or different value.
- Render B: `useQuery` picks up the `setQueryData` update. `session.model` now has the correct value. `model` resolves correctly.

During Render A, the RadioGroup `value={model}` receives a value that doesn't match any item (or matches a different item), causing `aria-checked=false` on all items and visual desync.

**Why `setQueryData` isn't enough:** `setQueryData` is synchronous for the cache store, but `useQuery` re-renders are scheduled asynchronously (React batching). Between `setLocalModel(null)` and the `useQuery` subscriber picking up the cache change, there is a render frame where neither source has the correct value.

---

# Detailed Analysis

## Bug 1 Solutions

### Approach A: Guard the seed effect with `isStreaming` (Recommended — Minimal)

Add an `isStreaming` check to the initial seed path so that when streaming is active, the full-array replace is skipped:

```typescript
useEffect(() => {
  if (!historyQuery.data) return;
  const history = historyQuery.data.messages;

  if (!historySeededRef.current && history.length > 0) {
    // Don't seed during active streaming — optimistic messages take precedence.
    // The seed will fire again when streaming completes and historySeededRef resets.
    if (isStreaming) return;
    historySeededRef.current = true;
    setMessages(history.map(mapHistoryMessage));
    return;
  }

  if (historySeededRef.current && !isStreaming) {
    const currentIds = new Set(messagesRef.current.map((m) => m.id));
    const newMessages = history.filter((m) => !currentIds.has(m.id));
    if (newMessages.length > 0) {
      setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
    }
  }
}, [historyQuery.data, isStreaming]);
```

**Pros:**

- Surgical — 3-line addition inside existing effect
- Follows the same guard philosophy already present in the polling update path (lines 217-224)
- No new state, no new refs
- Zero risk to non-streaming history load (initial page load, session switch without streaming)
- Matches the comment already written in the session-ID reset effect: "Don't clear messages during streaming"

**Cons:**

- The initial seed will be deferred until after streaming ends. This means: for create-on-first-message, the first seed happens after the `done` event via the existing `historySeededRef` reset-and-reseed flow. This is correct behavior — history is authoritative only after the stream completes.
- If streaming produces NO `done` event (e.g., hard disconnect), `historySeededRef` may never get set and history won't seed. This is an existing edge case unrelated to this fix.

**Complexity:** Very low. 3 lines.
**Maintenance:** No new moving parts.

---

### Approach B: ID-Based Deduplication in the Seed Path

Instead of blocking the seed, allow it to run but merge by ID rather than replacing:

```typescript
if (!historySeededRef.current && history.length > 0) {
  historySeededRef.current = true;
  // Merge by ID: keep any local optimistic messages not yet in server history
  const serverIds = new Set(history.map((m) => m.id));
  const localOptimistic = messagesRef.current.filter((m) => !serverIds.has(m.id));
  setMessages([...localOptimistic, ...history.map(mapHistoryMessage)]);
  return;
}
```

**Pros:**

- Preserves optimistic messages even when history loads during streaming
- More robust against any future path that resets `historySeededRef`
- Ordering is predictable: optimistic messages lead, server history follows

**Cons:**

- Optimistic messages appear at the TOP of the list (before server history), which is wrong — optimistic messages were just sent and should appear AFTER existing history. The ordering can be fixed by appending local messages that are more recent than the last server message, but this requires timestamp comparison which adds complexity.
- Server history may already contain a server-persisted version of the optimistic message (by a different ID). The user would see a duplicate momentarily. Requires additional deduplication by content or a stable client-side ID scheme.

**Complexity:** Medium. Requires careful ordering logic.
**Maintenance:** More brittle — depends on timestamp ordering being correct.

---

### Approach C: Don't Reset `historySeededRef` During Streaming

Change the session-ID change effect to not reset `historySeededRef` when streaming:

```typescript
useEffect(() => {
  if (statusRef.current !== 'streaming') {
    historySeededRef.current = false;
    setMessages([]);
  }
  // During streaming: don't reset historySeededRef or messages.
  // The seed guard will prevent overwrite; history will reseed after done.
}, [sessionId, selectedCwd]);
```

**Pros:**

- Prevents the seed effect from re-running at all during streaming
- Keeps `historySeededRef = true` which blocks the initial-seed path entirely
- Even simpler than Approach A

**Cons:**

- If `historySeededRef` is NOT reset on session ID change during streaming, the seed effect's `historySeededRef && !isStreaming` branch will run after streaming ends and merge new history. This is correct.
- However: for the create-on-first-message case where the session was previously null (no history), `historySeededRef` was already `false`. Not resetting it doesn't help — it stays false. So the initial seed can still fire during streaming for new sessions.
- In practice, for new sessions: history returns empty → `history.length > 0` is false → no overwrite. The problem only occurs for existing sessions or if history loads just after the first message completes. This approach doesn't fully protect the edge case.

**Complexity:** Low but incomplete.
**Maintenance:** Requires understanding the subtle distinction between new and existing sessions.

---

### Recommendation for Bug 1: Approach A

**Approach A** (guard the seed effect with `isStreaming`) is the right fix. It is the minimal, complete, principled solution:

- It matches the existing comment and intent already expressed in the session-ID reset effect
- It defers seeding until the stream ends, at which point the server history is authoritative and complete
- It costs 3 lines

**Combine with the existing ID-based deduplication** (already present at lines 217-224 for the polling path) to catch any edge case where `historySeededRef` and `isStreaming` have a narrow timing gap.

---

## Bug 2 Solutions

### Approach A: Keep Optimistic State Until After `useQuery` Re-renders (Recommended)

The root cause is that `setLocalModel(null)` fires before the `useQuery` subscriber has re-rendered with the new cache value. The fix is to not clear `localModel` immediately on success — instead, clear it only when the derived `model` value equals the server value:

```typescript
// In use-session-status.ts, replace the success path:
const updated = await transport.updateSession(sessionId, opts, selectedCwd ?? undefined);
queryClient.setQueryData(['session', sessionId, selectedCwd], (old: Session | undefined) => ({
  ...old,
  ...updated,
}));
// Clear optimistic overrides only AFTER setQueryData — let React batch them together
if (opts.model) setLocalModel(null);
if (opts.permissionMode) setLocalPermissionMode(null);
```

Wait — this IS the current code. The actual fix needed is to defer the clear until the query has updated:

**Option A1: Use `flushSync` to force synchronous re-render before clearing**

```typescript
import { flushSync } from 'react-dom';

const updated = await transport.updateSession(...);
// Update cache synchronously
queryClient.setQueryData(['session', sessionId, selectedCwd], (old) => ({ ...old, ...updated }));
// Force React to commit the cache update before clearing local state
flushSync(() => {
  if (opts.model) setLocalModel(null);
  if (opts.permissionMode) setLocalPermissionMode(null);
});
```

**Pros:** Guarantees the query subscriber re-renders before the local state clears. No extra state.
**Cons:** `flushSync` is a React escape hatch and is explicitly discouraged for general use. It forces a synchronous render which blocks the event loop. Not recommended for production patterns.

**Option A2: Clear local state only when query value converges**

Instead of imperatively clearing on success, derive the effective model purely: if `localModel === session.model`, treat it as converged and use `session.model`. But this is just the existing priority chain with a convergence shortcut — it doesn't visually help if there's a frame where `localModel` is null and `session` is stale.

**Option A3: Never clear `localModel` on success; let it be overridden by the priority chain when the query updates**

Change the model priority chain to use `localModel` only if it differs from `session.model`:

```typescript
// Instead of: localModel ?? streamingStatus?.model ?? session?.model
// Use: localModel !== session?.model ? localModel : session?.model
// But this loses the null-represents-"not-set" semantic
```

This doesn't work cleanly because `null` means "not set" and a string means "set by user". Can't use inequality check.

---

### Approach B: Remove `setLocalModel(null)` on Success; Rely on Cache Priority (Recommended)

The cleanest fix is to recognize that `localModel` is only needed for the OPTIMISTIC period (before server responds). Once the server responds with `updated`, `queryClient.setQueryData` makes `session.model` authoritative. Instead of clearing `localModel` (which causes the gap), simply keep the `localModel` set — it will match `session.model` so the priority chain still resolves correctly:

```typescript
const updated = await transport.updateSession(sessionId, opts, selectedCwd ?? undefined);
queryClient.setQueryData(['session', sessionId, selectedCwd], (old: Session | undefined) => ({
  ...old,
  ...updated,
}));
// Do NOT clear localModel immediately — the query cache now has the correct value.
// localModel matches session.model, so the priority chain resolves the same either way.
// Clear it on the NEXT session update or session change to avoid staleness.
```

But this creates a different problem: `localModel` would persist forever (or until the next `updateSession` call), preventing the `streamingStatus?.model` from updating the display during a subsequent stream. Need a cleanup.

**Better version: Clear localModel on next session-ID change or on session query success**

```typescript
// In use-session-status.ts, add a useEffect:
useEffect(() => {
  // When session query updates with a new model value, clear any pending local override
  if (session?.model && localModel && session.model === localModel) {
    setLocalModel(null);
  }
}, [session?.model, localModel]);
```

**Pros:**

- `localModel` is held until the cache has definitively caught up
- No render gap — the RadioGroup always has a valid value (either `localModel` or `session.model`, both matching)
- Clean, data-driven clearing (effect fires when convergence is confirmed)

**Cons:**

- Adds a `useEffect` with dependency on `session?.model` and `localModel`
- If `session.model` happens to equal `localModel` by coincidence (user selects the same model that was already set), the effect clears `localModel` correctly — this is fine
- Slightly more code than the minimal approach

**Complexity:** Low. One `useEffect`, ~5 lines.
**Maintenance:** Clear semantic — "clear optimistic override when server confirms the value".

---

### Approach C: Use `useOptimistic` (React 19)

React 19's `useOptimistic` is designed exactly for this pattern. It automatically shows the optimistic value while an action is pending and reverts to the "real" value once the action settles:

```typescript
const [optimisticModel, setOptimisticModel] = useOptimistic(
  session?.model ?? DEFAULT_MODEL,
  (currentModel, newModel: string) => newModel
);

const updateSession = useCallback(async (opts) => {
  startTransition(async () => {
    if (opts.model) setOptimisticModel(opts.model);
    const updated = await transport.updateSession(...);
    queryClient.setQueryData(['session', sessionId, selectedCwd], ...);
  });
}, [...]);

// In derived value:
const model = optimisticModel ?? streamingStatus?.model ?? DEFAULT_MODEL;
```

**Pros:**

- Purpose-built for this exact case — `useOptimistic` handles the "show optimistic value during action, revert to real value on settle" flow
- No manual `setLocalState(null)` call needed
- React 19 handles batching correctly — no render gap
- The project uses React 19 (confirmed in AGENTS.md)

**Cons:**

- Requires `startTransition` wrapper around the async action. The `updateSession` is currently called directly from `onChangeMode`/`onChangeModel` callbacks in `StatusLine.tsx` — wrapping in a transition requires adding `useTransition` to either `use-session-status.ts` or the calling component.
- `useOptimistic` reverts to the base value if the action throws, but our current code also reverts `localModel` on catch — so the behavior is equivalent.
- Non-trivial refactor from the current pattern.

**Complexity:** Medium. Requires restructuring the update flow around transitions.
**Maintenance:** Lower long-term — `useOptimistic` is idiomatic React 19 and well-supported.

---

### Recommendation for Bug 2: Approach B (Convergence Effect)

The **convergence `useEffect`** (Approach B, refined version) is the minimal correct fix:

```typescript
// Add in use-session-status.ts, below the localModel/localPermissionMode useState declarations:
useEffect(() => {
  if (session?.model && localModel && session.model === localModel) {
    setLocalModel(null);
  }
}, [session?.model, localModel]);

useEffect(() => {
  if (
    session?.permissionMode &&
    localPermissionMode &&
    session.permissionMode === localPermissionMode
  ) {
    setLocalPermissionMode(null);
  }
}, [session?.permissionMode, localPermissionMode]);
```

And remove the `setLocalModel(null)` / `setLocalPermissionMode(null)` calls from the success path of `updateSession` (keep the error/catch path that reverts).

**Why this works:**

- During the PATCH: `localModel` is set. RadioGroup shows `localModel`. Correct.
- After `setQueryData`: `session.model` is updated in cache. `useQuery` re-renders. `session.model === localModel` → convergence effect fires → `setLocalModel(null)`. Now `model = null ?? session.model` = correct value. No gap.
- The RadioGroup `value` never loses its value — it transitions smoothly from `localModel` → `session.model` (same value, no visual flash).

**Caveats:**

- If `transport.updateSession` returns a different model than what was set (server normalizes), the convergence effect won't fire and `localModel` stays set indefinitely. Add a fallback: also clear `localModel` in `onSettled` (after a delay or unconditionally after the query invalidates).
- The simpler version — just `await`ing the effect by placing both `setQueryData` and `setLocalModel(null)` inside a `flushSync` — is possible but inadvisable. The convergence effect is the idiomatic React approach.

---

# Sources & Evidence

- Source read: `apps/client/src/layers/features/chat/model/use-chat-session.ts` — full file, race condition identified at lines 198-225
- Source read: `apps/client/src/layers/entities/session/model/use-session-status.ts` — full file, two-render gap identified at lines 77-100
- Source read: `apps/client/src/layers/features/status/ui/ModelItem.tsx` — RadioGroup usage confirmed, `value={model}` is the controlled value
- Source read: `apps/client/src/layers/features/status/ui/StatusLine.tsx` — `status.model` passed directly to `ModelItem`
- [Concurrent Optimistic Updates in React Query](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query) — `isMutating()` guard pattern to prevent invalidation from overwriting optimistic state
- [TanStack Query v5 — Optimistic Updates](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates) — `setQueryData` is synchronous for the cache store; `useQuery` re-renders are async
- [Radix UI RadioGroup — Unable to reset value in controlled mode #1588](https://github.com/radix-ui/primitives/issues/1588) — confirmed that `undefined` value causes `aria-checked=false` on all items; `null` is the documented workaround for clearing
- [TanStack Query Discussion #7932 — Race condition even with cancelQueries](https://github.com/TanStack/query/discussions/7932) — race conditions in optimistic updates require explicit ref guards or cancel patterns
- [React — useOptimistic](https://react.dev/reference/react/useOptimistic) — purpose-built for optimistic state that automatically reverts on action settle
- [TanStack Query — setQueryData and staleTime interaction #4716](https://github.com/TanStack/query/discussions/4716) — `setQueryData` marks data as fresh with current timestamp; `useQuery` re-render is async
- Prior research: [20260307_relay_streaming_bugs_tanstack_query.md](./20260307_relay_streaming_bugs_tanstack_query.md) — ID-based deduplication pattern for history merge (Solution B in that report, now already implemented at lines 217-224)
- Prior research: [20260307_fix_chat_streaming_history_consistency.md](./20260307_fix_chat_streaming_history_consistency.md) — history vs streaming consistency patterns

---

# Research Gaps & Limitations

- The timing of `onSessionIdChangeRef.current?.(targetSessionId)` propagating upward (through the parent component's state) was not traced through the component tree. The speed of that propagation affects the width of the race window for Bug 1.
- For Bug 2: the exact React version batch behavior for `setState` + `setQueryData` in the same microtask was not benchmarked. React 18+ uses automatic batching for async continuations in some cases but not all. The gap may be intermittent rather than deterministic.
- The `useOptimistic` approach (Bug 2 Approach C) was not prototyped. It is the most idiomatic React 19 solution but requires a transition wrapper that adds structural change.

---

# Search Methodology

- Searches performed: 7
- Most productive terms: "TanStack Query setQueryData then set local state null timing", "React optimistic update setLocalState null setQueryData order", "Radix UI RadioGroup controlled value reset", "concurrent optimistic updates react query tkdodo"
- Primary sources: Direct source code reads (4 files), TanStack Query docs, Radix UI GitHub issues, React docs
