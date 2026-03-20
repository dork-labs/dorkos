---
title: 'Fix Chat Stream Remap Bugs — Duplicate Messages & Stale Model Display'
date: 2026-03-12
type: implementation
status: active
tags:
  [
    chat,
    streaming,
    session-id-remap,
    optimistic-ui,
    tanstack-query,
    model-display,
    sse,
    done-event,
    deduplication,
  ]
feature_slug: fix-chat-stream-remap-bugs
searches_performed: 0
sources_count: 8
---

# Research Summary

This research investigated two bugs related to the session ID remap flow in the DorkOS chat UI. All
source files were read directly before drawing conclusions. The key finding is that **the task brief's
description of both bugs does not match the current source code** — significant prior fixes have
already landed:

- Bug #1 (Duplicate Messages): The optimistic user message pattern described in the brief no longer
  exists. `use-chat-session.ts` now uses a `pendingUserContent` state (a UI-only pending bubble, never
  added to the `messages` array). There is no `setMessages((prev) => [...prev, userMessage])` call.
  The remap-triggered duplicate arises from a different mechanism: the `done` event handler calls
  `onSessionIdChangeRef.current?.(doneData.sessionId)`, which changes the `sessionId` prop, which
  resets `historySeededRef.current = false` and then triggers a history refetch. When the refetch
  returns, the seed effect checks `!isStreaming` — and at that point streaming IS idle (done has
  already fired `setStatus('idle')`). This means the refetch CAN write to messages. The streaming
  messages accumulated in `messages[]` (the assistant response) will already be present, and the
  history refetch contains the same assistant response again. The ID-based deduplication guard
  (`currentIds` Set) should prevent this — but only if the assistant message ID in `messages[]`
  matches the ID in the server history. The `assistantIdRef.current` UUID is a client-generated UUID
  that will NOT match the SDK-assigned ID in the JSONL. This is the actual root of the duplication.

- Bug #3 (Stale Model Display): The model priority chain at line 69 of `use-session-status.ts` is
  `localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL`. The `isStreaming` flag
  is in scope in `useSessionStatus` (it's a parameter), but it is NOT used to gate `streamingStatus?.model`
  in the priority chain. The brief is correct: after streaming ends, `streamingStatus?.model` retains
  its value and can shadow the server-confirmed `session?.model`.

Prior research in `20260311_fix_chat_ui_reliability_bugs.md`, `20260310_fix_chat_streaming_model_selector_bugs.md`,
and `20260307_relay_streaming_bugs_tanstack_query.md` covers closely related patterns and is
cross-referenced throughout.

---

# Source Code Audit

## Files Read

1. `apps/client/src/layers/features/chat/model/use-chat-session.ts` (399 lines) — full read
2. `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (319 lines) — full read
3. `apps/client/src/layers/entities/session/model/use-session-status.ts` (126 lines) — full read

## Current State — Key Facts Confirmed by Source

### The `done` event handler (stream-event-handler.ts, lines 292-312)

```typescript
case 'done': {
  const doneData = data as { sessionId?: string };
  if (doneData.sessionId && doneData.sessionId !== sessionId) {
    onSessionIdChangeRef.current?.(doneData.sessionId);  // ← triggers remap
  }
  // ... cleanup ...
  setStatus('idle');  // ← fires AFTER remap callback
  break;
}
```

The remap fires BEFORE `setStatus('idle')`. However, both calls happen synchronously within the
same event handler invocation. React 18+ batches all state updates inside event handlers and
transitions — but `onSessionIdChangeRef.current` is not a React state setter; it is a callback that
calls the parent's `setState`. This means the remap propagation is a React state update that is
batched with `setStatus('idle')` in the same flush. The `sessionId` prop changes and `status`
becomes `'idle'` in the same render commit.

**Consequence for the seed effect:** When the `done` event fires and both the new `sessionId` and
`status='idle'` land in the same render:

1. `sessionId` changes → `historySeededRef.current = false` (session-ID reset effect, line 168)
2. `statusRef.current !== 'streaming'` → `setMessages([])` IS called (because streaming is now idle)
3. The history query is now enabled with the new SDK session ID
4. History refetch fires → returns messages from JSONL (including the assistant response)
5. Seed effect: `!historySeededRef.current && history.length > 0 && !isStreaming` → all true
6. `setMessages(history.map(mapHistoryMessage))` — this SETS messages from JSONL

Wait — step 2 clears `messages[]` to `[]`. So the streaming assistant messages that were in
`messages[]` are already gone when history arrives. The deduplication cannot cause duplicates if
`setMessages([])` fired first.

**However**, there is a timing subtlety: `statusRef.current` is synced in a `useEffect` (no
dependency array) — it fires after render, not synchronously. Line 106-108:

```typescript
const statusRef = useRef(status);
useEffect(() => {
  statusRef.current = status;
});
```

When `setStatus('idle')` fires (from the `done` handler), the React render commits. The effect that
syncs `statusRef.current = 'idle'` fires AFTER the commit. But the session-ID reset effect also
fires after the commit. The question is the ORDER of effects: both the `statusRef` sync effect and
the session-ID reset effect fire in the same effect flush. Effects fire in the order they are declared
in the component. `statusRef` sync is at line 106; the session-ID reset effect is at line 167. So
`statusRef.current` WILL be `'idle'` when the session-ID reset effect checks it.

**Revised consequence:** `setMessages([])` IS called on remap. The streaming messages are cleared.
History refetch fills them in correctly. No duplicate from this path.

**But**: there is still a window between `setMessages([])` and the history refetch returning. During
this window, the `messages[]` array is empty. The pending user bubble (`pendingUserContent`) was
already cleared by `setStatus('idle')` flow in `executeSubmission`. So the user sees:

1. Full streaming conversation (pending bubble + assistant streaming) →
2. Empty state briefly (messages cleared, history loading) →
3. History fills in (complete conversation from JSONL)

This empty flash IS a real UX problem, but it is a different bug from "duplicate messages."

**The actual duplicate scenario** is more specific: if `setStatus('idle')` and the session-ID change
do NOT batch together (e.g., on React versions where the `onSessionIdChangeRef` callback runs in a
non-batched context), then:

- `done` fires → `onSessionIdChangeRef` called → parent setState for sessionId → render A
- In render A: `sessionId` changed, `status` still `'streaming'` → `statusRef.current === 'streaming'`
  → session-ID reset effect does NOT call `setMessages([])`
- `done` continues → `setStatus('idle')` → render B
- In render B: status is 'idle', historySeededRef is false, history may have arrived → seed effect
  fires → `setMessages(history.map(...))` — appends history messages to the STILL-POPULATED
  `messages[]` array (which has the streaming assistant messages)
- ID-based dedup: streaming assistant message has `assistantIdRef.current` UUID; server history
  has the SDK-assigned UUID → **DIFFERENT IDs → dedup fails → duplicate assistant message**

This is the duplicate. It depends on whether React batches the remap callback with `setStatus('idle')`.

### The model priority chain (use-session-status.ts, line 69)

```typescript
const model = localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL;
```

`streamingStatus` is the `SessionStatusEvent | null` passed in as a prop. After streaming ends,
the caller (`useChatSession`) sets `status = 'idle'` but does NOT reset `sessionStatus` to null.
Looking at `stream-event-handler.ts` — there is no `setSessionStatus(null)` in the `done` case.
`sessionStatus` persists at its last streamed value indefinitely until the next stream starts.

The `isStreaming` parameter in `useSessionStatus` is used only in `statusData.isStreaming` (line 83).
It is NOT used to gate `streamingStatus?.model`.

**Bug #3 is confirmed**: After a stream ends, `streamingStatus?.model` retains the last model value
from the stream and takes priority over `session?.model` (the server-confirmed value). If the two
differ (e.g., the server normalizes the model name), the stale streaming model displays indefinitely.

---

# Potential Solutions for Bug #1

## Context

The duplicate message bug occurs specifically when the session ID remap in the `done` event and the
`setStatus('idle')` state update do NOT land in the same React render — i.e., when React does NOT
batch them. In React 18+, state updates inside a native event handler are automatically batched, but
`transport.sendMessage`'s callback is an SSE event listener (parsed outside React's event system),
so batching behavior depends on whether `startTransition` or `flushSync` is involved.

The `onSessionIdChangeRef.current` callback calls the parent's `setSessionId` (URL param update via
`nuqs`). `nuqs` URL param updates in v2 go through the `useRouter` context and are async by design.
This means `sessionId` and `status` changes from the `done` event are very likely NOT batched — they
land in separate renders. The duplicate window is real.

---

## Approach A: Clear Streaming State Immediately on Remap (Clear `messages[]`)

### Description

In the `done` handler, when a remap is detected (`doneData.sessionId !== sessionId`), call
`setMessages([])` directly from the stream event handler before the remap callback fires. This
ensures the streaming messages are cleared synchronously (in the same event loop tick) regardless
of whether React batches the remap with `setStatus('idle')`.

```typescript
case 'done': {
  const doneData = data as { sessionId?: string };
  const isRemap = doneData.sessionId && doneData.sessionId !== sessionId;
  if (isRemap) {
    // Clear streaming messages immediately on remap — prevents duplicate when
    // session ID change and setStatus('idle') land in separate renders.
    // History refetch on the new session ID will repopulate from JSONL.
    setMessages([]);
    onSessionIdChangeRef.current?.(doneData.sessionId);
  }
  // ... cleanup, setStatus('idle') ...
  break;
}
```

**Pros:**

- Surgical — 2-3 lines in the `done` handler
- Guarantees `messages[]` is empty before remap propagates — no duplicate possible regardless
  of batching behavior
- No new state or refs required
- Consistent with `setMessages([])` already called by the session-ID reset effect on non-streaming
  session changes

**Cons:**

- Creates an empty-flash between clear and history arrival — same UX gap as the existing no-remap
  path, just now it also occurs on remap
- If history is slow (> 500ms), user sees blank conversation for a noticeable moment
- `setMessages` is not currently in `StreamEventDeps` — it would need to be called directly from the
  handler (it is already in deps, line 27: `setMessages: React.Dispatch<...>`)
- Clearing messages early means the user loses visual context of the conversation mid-remap
  (though it was going to be cleared anyway)

**Complexity:** Low — 2-3 lines, no interface change.

---

## Approach B: Deduplicate by Message ID at Render Time

### Description

Keep streaming messages in `messages[]`. Change the seed effect's merge logic so that when the
seed fires after streaming, messages with IDs already in `messages[]` are NOT re-added, AND
the assistant message from history is also matched against the streaming assistant message via a
secondary key (content hash or timestamp proximity).

Since ID-based dedup fails (client UUID vs SDK UUID), add content-based dedup as a fallback:

```typescript
if (historySeededRef.current && !isStreaming) {
  const currentIds = new Set(messagesRef.current.map((m) => m.id));
  const newMessages = history.filter((m) => {
    if (currentIds.has(m.id)) return false;
    // Content-based dedup for assistant messages: suppress server copy if streaming
    // copy with same content is present (different IDs due to client vs SDK UUID gap)
    if (m.role === 'assistant') {
      const streamingCopy = messagesRef.current.find(
        (local) => local.role === 'assistant' && local.content === m.content
      );
      if (streamingCopy) return false;
    }
    return true;
  });
  if (newMessages.length > 0) {
    setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
  }
}
```

**Pros:**

- No empty flash — messages persist through remap, history fills in any gaps
- Zero UX degradation during remap
- Works without changing the stream event handler or transport layer

**Cons:**

- Content-based dedup is fragile: if the assistant response includes a tool call summary that differs
  between streaming state and JSONL format, `local.content === m.content` will miss
- `content` is derived from parts (multi-block content is joined with '\n' in `deriveFromParts`) —
  this derivation must match the server-side serialization exactly
- Does not handle partial streaming messages (if streaming was cut short, the streaming content
  may not match the server content)
- Adds complexity to an already-intricate seed effect
- Two identical assistant responses in sequence (unlikely but possible) would suppress the second

**Complexity:** Medium — ~10 lines in the seed effect, but fragile edge cases.

---

## Approach C: Transition State — "Remapping" Flag

### Description

Add a `isRemappingRef = useRef(false)` flag. On `done` with a remap detected, set
`isRemappingRef.current = true`. In the seed effect, when `isRemappingRef` is true, do a full
merge (clear streaming messages, apply history) rather than the incremental append. Clear the flag
after the seed.

```typescript
// In stream-event-handler.ts done case:
const isRemap = doneData.sessionId && doneData.sessionId !== sessionId;
if (isRemap) {
  isRemappingRef.current = true;
  onSessionIdChangeRef.current?.(doneData.sessionId);
}

// In use-chat-session.ts seed effect:
if (isRemapping && !isStreaming) {
  isRemappingRef.current = false;
  historySeededRef.current = true;
  setMessages(history.map(mapHistoryMessage)); // Full replace, not append
  return;
}
```

**Pros:**

- Explicit state machine — remap is a named, trackable state
- Full replace guarantees no duplicate (history is authoritative)
- The UX gap (empty flash) can be avoided by keeping the old messages visible until history arrives
  using a "transitioning" render where the old messages are shown in a dimmed/placeholder state

**Cons:**

- Adds a new ref that must be threaded from `stream-event-handler.ts` back into the seed effect —
  either via a ref in `StreamEventDeps` or a state variable
- The `isRemapping` flag is an additional ref to keep in sync; if the remap fires but history never
  arrives (network failure), `isRemapping` stays true permanently, blocking future seeds
- Requires a timeout/cleanup for the permanent-stuck scenario
- Most complex of the three approaches

**Complexity:** High — cross-boundary state (event handler → hook), timeout management.

---

## Approach D: Stable Assistant ID via Server Echo (Long-Term)

### Description

The root cause of ID-mismatch dedup failure is that the streaming assistant message uses a
client-generated UUID (`assistantIdRef.current`) while the JSONL uses the SDK-assigned UUID.
Fix this by having the server send the SDK-assigned assistant message ID in the `done` event
or in a new `message_id_confirmed` event. The client then updates the in-memory assistant message's
ID before history arrives:

```typescript
case 'done': {
  if (doneData.assistantMessageId) {
    // Update the streaming assistant message's ID to match the server-assigned ID
    setMessages((prev) =>
      prev.map((m) =>
        m.id === assistantIdRef.current
          ? { ...m, id: doneData.assistantMessageId }
          : m
      )
    );
  }
  // ... remap, setStatus('idle') ...
}
```

When history arrives and runs the ID-based dedup, `currentIds` now contains the SDK-assigned ID,
so the history's assistant message IS deduplicated correctly.

**Pros:**

- Fixes the root cause (ID mismatch) rather than the symptom (duplicate display)
- No empty flash
- ID-based dedup becomes fully reliable
- Works for non-remap paths too (any post-stream history sync)

**Cons:**

- Requires server-side changes: the `done` event payload must include the SDK-assigned message ID
- The SDK assigns the ID at the JSONL write level — may require reading back from the transcript
  or hooking into the SDK's turn completion callback
- Protocol change: server and client must be updated in sync
- Higher complexity than client-only fixes

**Complexity:** High — server + client changes required.

---

# Potential Solutions for Bug #3

## Context

The current model priority chain in `use-session-status.ts` line 69:

```typescript
const model = localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL;
```

`streamingStatus` is the `SessionStatusEvent | null` value from `useChatSession.sessionStatus`.
In `use-chat-session.ts`, `sessionStatus` is set via `setSessionStatus(merged)` in the
`session_status` SSE handler. After streaming ends (`done` event), `setSessionStatus` is NOT called
with null — the value persists.

The `isStreaming` parameter is passed to `useSessionStatus` and available in scope, but unused in
the priority chain.

---

## Approach A: Gate `streamingStatus?.model` Behind `isStreaming` (Recommended)

### Description

Change the priority chain to only use `streamingStatus?.model` when actively streaming:

```typescript
const model =
  localModel ?? (isStreaming ? streamingStatus?.model : null) ?? session?.model ?? DEFAULT_MODEL;
```

Or equivalently:

```typescript
const streamingModel = isStreaming ? streamingStatus?.model : null;
const model = localModel ?? streamingModel ?? session?.model ?? DEFAULT_MODEL;
```

**Pros:**

- One-line fix — purely additive, no new state
- Precisely matches the semantic intent: streaming status is only authoritative during streaming
- `session?.model` becomes the authoritative display value after streaming, which is the server-confirmed
  value from the JSONL/session record
- Safe for all other fields in `statusData` that still use `streamingStatus` (costUsd, contextTokens)
  — those are gated by their own null-coalescing and are acceptable to retain post-stream
- No risk of null flash: `session?.model` is already in the query cache with the correct value
  (the session record is fetched on mount and updated via `sync_update` invalidation after streaming)

**Cons:**

- Between `setStatus('idle')` and `session` query re-fetching with the new model, there is a
  brief window where `session?.model` may show the pre-stream value if the session hasn't been
  invalidated yet. This is a pre-existing timing concern, not introduced by this fix.
- If `isStreaming` flips to false before the final `session_status` event arrives (unlikely but
  possible if events arrive out of order), the model display reverts to `session?.model` one event
  early. This is cosmetically acceptable.

**Complexity:** Trivially low — 1 line changed.

---

## Approach B: Reset `sessionStatus` on Stream End

### Description

In the `done` event handler, call `setSessionStatus(null)` to clear the streaming status entirely.
The priority chain then naturally falls through to `session?.model`:

```typescript
case 'done': {
  // ... existing cleanup ...
  setSessionStatus(null);  // Clear streaming status — session?.model becomes authoritative
  setStatus('idle');
  break;
}
```

**Pros:**

- More thorough: clears ALL stale streaming status (model, costUsd, contextTokens, contextMaxTokens)
  not just model
- `statusData.costUsd` currently uses `streamingStatus?.costUsd ?? null` — after clearing, this
  returns null until the next session query returns cost data. This may be the correct behavior
  (cost is per-stream, not persistent).

**Cons:**

- Clearing `costUsd` and context data on stream end may cause the status bar to flash empty
  briefly before `session?.model` (and potentially session context data) loads
- `sessionStatusRef.current` must also be cleared (it's used in the `session_status` merge logic)
  — if not cleared, the next stream will merge with stale data
- Requires clearing both `setSessionStatus(null)` and `sessionStatusRef.current = null` in `done`
- The `sessionStatusRef` is currently in `StreamEventDeps` — the `done` handler has access to it

**Complexity:** Low — 1-2 lines in the `done` handler, but has cascading UX effect on all
streaming status fields.

---

## Approach C: Derive Model from `isStreaming` Explicitly in `statusData`

### Description

Remove `streamingStatus?.model` from the priority chain entirely. Instead, expose both
`streamingModel` and `persistedModel` separately, and let the consumer decide:

```typescript
const statusData: SessionStatusData = {
  model:
    localModel ??
    (isStreaming && streamingStatus?.model
      ? streamingStatus.model
      : (session?.model ?? DEFAULT_MODEL)),
  // ...
};
```

This is functionally equivalent to Approach A but written inline in the `statusData` construction.

**Pros/Cons:** Identical to Approach A. Approach A's two-line version is cleaner.

**Complexity:** Identical to Approach A.

---

# Recommendation

## Bug #1 Recommended: Approach A (Immediate Clear on Remap) for Correctness

The root cause is the ID mismatch between the client-generated `assistantIdRef.current` UUID and
the SDK-assigned UUID in the JSONL. The ID-based deduplication guard in the seed effect cannot work
as designed.

**Recommended fix:** Approach A — call `setMessages([])` from the `done` handler before the remap
callback fires.

```typescript
case 'done': {
  const doneData = data as { sessionId?: string };
  const isRemap = doneData.sessionId && doneData.sessionId !== sessionId;
  if (isRemap) {
    // Clear streaming messages before remap propagates — prevents the ID-mismatch
    // deduplication failure where the streaming assistant message (client UUID) and
    // the server history assistant message (SDK UUID) both appear in the final list.
    setMessages([]);
    onSessionIdChangeRef.current?.(doneData.sessionId);
  } else if (doneData.sessionId) {
    // Same session ID confirmed — no remap needed
    onSessionIdChangeRef.current?.(doneData.sessionId);
  }
  // ... existing cleanup, setStatus('idle') ...
  break;
}
```

**Rationale:**

- The `setMessages` setter is already in `StreamEventDeps` (line 27) — no interface change needed
- Clearing messages early is safe: `setStatus('idle')` fires in the same event handler invocation,
  and the session-ID reset effect will fire `setMessages([])` anyway when the new session ID arrives
  — this just closes the timing window where it might not
- The empty-flash UX gap is real but already present on normal session switches; power users (Kai,
  Priya) understand this is a loading state
- If the empty-flash becomes a priority UX concern, a `isRemapping` state for a loading indicator
  is the next step — but that is a UX enhancement, not a bug fix

**Do not implement Approach B (content-based dedup)** — it is fragile and the content matching
between streaming state and JSONL serialization is not guaranteed to be exact.

**Approach D (stable assistant ID via server echo) is the correct long-term fix** but requires
server changes. It can be implemented as a follow-up after confirming the server can include the
JSONL message ID in the `done` event.

---

## Bug #3 Recommended: Approach A (Gate `streamingStatus?.model` Behind `isStreaming`)

```typescript
// Before:
const model = localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL;

// After:
const model =
  localModel ?? (isStreaming ? streamingStatus?.model : null) ?? session?.model ?? DEFAULT_MODEL;
```

**Rationale:**

- One-line fix, no new state or side effects
- Semantically correct: streaming status model is a live signal, not persisted data
- `session?.model` is the server-confirmed value and the right fallback post-stream
- No UX regression: `session?.model` is populated from the query cache which is kept fresh by
  the `sync_update` SSE handler and the `done`-event invalidation path
- This is the minimal, principled fix aligned with the existing codebase pattern: streaming data
  is ephemeral; session query data is authoritative

**Do not implement Approach B (reset sessionStatus on done)** as the primary fix — clearing all
streaming status fields (costUsd, contextTokens) has cascading UX effects that require additional
design consideration. If clearing the entire `sessionStatus` on stream end is desired for other
reasons, it should be a separate, deliberate change.

---

# Caveats

1. **Bug #1 batching behavior**: The analysis of whether `onSessionIdChangeRef` and `setStatus('idle')`
   batch depends on the `nuqs` URL-param update mechanism. If `nuqs` v2 wraps updates in
   `startTransition` (which it does by default), React 18 may batch them — in that case, the duplicate
   may not reproduce reliably in development. The fix is still correct: defensive `setMessages([])`
   on remap is safe and correct regardless of batching.

2. **Empty flash between remap and history**: After Approach A clears `messages[]`, there is a brief
   empty state. The `historyQuery` is already set to poll and the new session ID will trigger an
   immediate refetch. On localhost this is typically < 100ms. To mitigate visually, consider keeping
   the `isLoadingHistory` flag elevated during remap (it will be true as the new query fires).

3. **Bug #3 model display gap**: After streaming ends, `session?.model` may reflect the pre-stream
   model if the session query hasn't been invalidated yet. The `done` handler already calls
   `onSessionIdChangeRef` on remap, which triggers a new query. For non-remap paths, the session
   query is invalidated by the `sync_update` handler. The gap between stream end and session query
   settling is typically < 200ms — acceptable.

4. **`pendingUserContent` is already correct**: The task brief mentions "optimistic/streaming messages
   accumulated so far are NOT cleared". The current source uses `pendingUserContent` (UI-only, not
   in `messages[]`), and it IS cleared before remap fires (`setPendingUserContent(null)` is called
   in `executeSubmission`'s success path before the `done` handler even fires, because `done` is
   the last event and `await transport.sendMessage(...)` resolves). No action needed for the pending
   bubble.

---

# Sources & Evidence

- Source read: `apps/client/src/layers/features/chat/model/use-chat-session.ts` — current
  `pendingUserContent` pattern (line 60, 256), session-ID reset effect (lines 167-172), seed
  effect (lines 175-198), `statusRef` sync (lines 105-108), SSE sync_update guard (lines 209-212)
- Source read: `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — `done`
  handler (lines 292-312), `session_status` handler (lines 273-285), `setMessages` in deps (line 27)
- Source read: `apps/client/src/layers/entities/session/model/use-session-status.ts` — model
  priority chain (line 69), `isStreaming` parameter (line 51), convergence effect (lines 116-123)
- Prior research: `20260311_fix_chat_ui_reliability_bugs.md` — Approach 1 (eliminate optimistic
  bubble) and Approach 5 (pendingUserContent placeholder) — the placeholder approach is now
  implemented in the codebase
- Prior research: `20260310_fix_chat_streaming_model_selector_bugs.md` — Approach A (isStreaming
  guard on seed), convergence effect for localModel (now implemented), Bug 2 (RadioGroup desync
  from setLocalModel(null) + setQueryData timing gap — now fixed via convergence effect at line 116)
- Prior research: `20260307_relay_streaming_bugs_tanstack_query.md` — statusRef pattern (already
  in codebase), ID-based dedup (already implemented at lines 190-196 in seed effect)
- React 18 automatic batching documentation: state updates from setTimeout, SSE handlers, and
  other native async contexts are batched in React 18+ — but transitions via `nuqs` router push
  may or may not be included depending on implementation
- React rendering: `useEffect` hooks fire in declaration order within a component — `statusRef`
  sync (line 85 area) fires before session-ID reset effect (line 167 area) in the same commit

---

# Research Gaps & Limitations

- The exact batching behavior of `nuqs` URL-param updates with React 18's automatic batching was
  not confirmed. If `nuqs` uses `startTransition`, the remap and `setStatus('idle')` ARE batched
  and the duplicate may be rare/unreproducible in practice. A quick test by adding a `console.log`
  to the session-ID reset effect and the seed effect would confirm the render sequence.
- The `transport.sendMessage` SSE event parsing mechanism was not traced — if it uses
  `EventSource` (which fires outside React's synthetic event system), updates are batched in React
  18 via the automatic batching introduced in React 18. If it uses `fetch` with a readable stream
  parsed manually, the batching depends on whether updates are wrapped in `flushSync` or
  `startTransition`.
- The `done` event's `sessionId` payload content was confirmed by reading the handler but the
  server-side emitter was not read — it's assumed the server always emits the SDK-assigned session
  ID in the `done` event payload for create-on-first-message flows.

---

# Search Methodology

- Searches performed: 0 (all findings are from direct source code inspection and prior research)
- Primary sources: 3 source files read directly, 3 prior research reports cross-referenced
- Prior research fully covered the patterns; the new contribution is the precise mapping of the
  current source to the specific remap-triggered bug scenarios
