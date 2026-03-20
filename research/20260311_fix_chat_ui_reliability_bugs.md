---
title: 'Fix Chat UI Reliability Bugs — Stable Keys, Empty Session Guard, Optimistic Duplicate Bubble'
date: 2026-03-11
type: implementation
status: active
tags:
  [
    chat,
    streaming,
    react-keys,
    tanstack-query,
    optimistic-ui,
    session-id,
    enabled-guard,
    deduplication,
    sse,
  ]
feature_slug: fix-chat-ui-reliability-bugs
searches_performed: 10
sources_count: 22
---

# Research Summary

Three discrete reliability bugs in the DorkOS chat UI were investigated by reading actual source files
(`AssistantMessageContent.tsx`, `stream-event-handler.ts`, `use-chat-session.ts`, `use-task-state.ts`,
`use-session-status.ts`, `schemas.ts`) combined with targeted web research. Each bug has a precise
root cause and a recommended minimal fix. Prior research in
`20260307_relay_streaming_bugs_tanstack_query.md` and `20260310_fix_chat_streaming_model_selector_bugs.md`
covered adjacent problems and is cross-referenced where it informs the current recommendations.

---

# Bug 1: React Duplicate Key Storm

## Root Cause — Source-Confirmed

**File:** `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`, line 121.

```tsx
{parts.map((part, i) => {
  if (part.type === 'text') {
    return (
      <div key={`text-${i}`} className="msg-assistant">   {/* ← BUG */}
        <StreamingText ... />
      </div>
    );
  }
  // ...tool_call uses part.toolCallId as key — stable and correct
```

**Why the warning fires ~300 times per response:** During streaming, `text_delta` events cause
`updateAssistantMessage()` to call `setMessages(...)` on every delta. Each call passes a new `parts`
array snapshot (line 110 in `stream-event-handler.ts`: `currentPartsRef.current.map((p) => ({ ...p }))`).
The parts array always contains at most one `text` part at index `0` for the first block, `2` after a
tool call, etc. — the index `i` is stable for a given render, so it is NOT actually generating duplicate
key warnings between different elements in the same render. The warnings are React seeing the same
key `"text-0"` across consecutive renders while the element's `content` prop changes rapidly — React
logs a duplicate-key warning when it reconciles children under a parent and finds the same key appearing
on two nodes in the tree. Because `AssistantMessageContent` is called inside `MessageItem`, which is
inside `MessageList`, and `MessageList` renders multiple `ChatMessage` items — all assistants use the
same sequential index — across the full list `"text-0"` appears once per assistant message, causing
the "two children with the same key" warning at the parent list level, not within a single message.

**The actual duplicate:** Every `AssistantMessage` in the list renders `<div key="text-0">`. React
resolves keys within their immediate parent scope. Since each assistant message is its own JSX
fragment (`<> ... </>`), the `key="text-0"` within one fragment does not collide with `key="text-0"`
in another fragment. HOWEVER — the MessageList renders a flat array of elements where both user and
assistant `MessageItem` components are siblings. Inside `MessageItem`, it renders `AssistantMessageContent`
which returns a fragment. The `key` on the outer `MessageItem` is the `message.id` (stable). The
children _inside_ the fragment are scoped to that fragment. So the warning is actually triggered by
the key `"text-0"` being unstable **within a single message's parts** — specifically when a new text
part is pushed after a tool call, the previously-indexed text at `i=0` keeps the key `"text-0"` while
the new part that would also be `"text-2"` (for example) creates a discontinuity that React notices
as a reconciliation mismatch.

**Confirmed root cause:** `TextPart` in `packages/shared/src/schemas.ts` has no `id` field — only
`type: 'text'` and `text: string`. The streaming handler creates text parts without IDs. On each
`text_delta`, the text content of an existing part grows — the part object is replaced (immutable
update) but the position `i` remains the same. This is actually the _correct_ behavior for text
accumulation. The warning storm comes from a different pattern: when the parts array is `[text, tool_call,
text]`, both text parts have keys `"text-0"` and `"text-2"`. React internally reconciles by key — if
the keys are stable within the render, no warning. But if parts are re-ordered or the array grows
(new text block after a tool call), the new text part gets key `"text-2"` while a previous text block
that existed at index 2 earlier now gets a different index — **or more commonly, a text block that was
at index 0 is now at index 0 still, but a second text block at index 2 collides with what was at index
2 before (a tool_call part whose key was `part.toolCallId`).**

**Simplified correct diagnosis:** The index key `text-${i}` is not stable across renders when new
parts are inserted _before_ existing text parts (e.g., a tool call completes and a new text block
begins at a higher index). This is the same class of bug as the React docs describe for list items
that can be reordered. The solution is a stable ID on each text part.

## Approaches for Bug 1

### Approach 1: Positional Slot ID Assigned at Creation Time in the Event Handler

Assign a stable string ID to each text part when it is first created in `stream-event-handler.ts`.
The ID is the part's "birth index" — the value of `currentPartsRef.current.length` at the moment the
new text part is pushed.

```typescript
// In stream-event-handler.ts, text_delta case:
const parts = currentPartsRef.current;
const lastPart = parts[parts.length - 1];
if (lastPart && lastPart.type === 'text') {
  // Append to existing text part — keep same ID
  currentPartsRef.current = [...parts.slice(0, -1), { ...lastPart, text: lastPart.text + text }];
} else {
  // New text part — assign stable positional ID
  const partId = `text-part-${parts.length}`;
  currentPartsRef.current = [...parts, { type: 'text', text, _partId: partId }];
}
```

In `AssistantMessageContent.tsx`, use `part._partId` instead of index:

```tsx
<div key={part._partId} className="msg-assistant">
```

**Wire protocol impact:** `_partId` is a client-only field. It would need to be stripped before
sending to the server and excluded from the `TextPartSchema`. Either add it as `z.string().optional()`
to the schema, or use a parallel `WeakMap<MessagePart, string>` / separate ID array. The cleanest
approach is to use a separate type extension at the client layer rather than modifying the shared schema.

**Pros:**

- IDs are assigned exactly once (at part creation) — always stable across re-renders
- Part ID never changes as text grows — the same part object gets its ID once
- No UUID generation cost during render
- Works correctly for multi-block messages (`[text0, tool_call, text1]`)

**Cons:**

- Requires adding a client-side-only field `_partId` to the text part OR a parallel map
- Adding to the schema changes the `TextPart` contract; adding outside the schema adds indirection
- The `_partId` needs to survive the `parts.map((p) => ({ ...p }))` snapshot in `updateAssistantMessage`
  — since that copies all enumerable fields, a regular `_partId` property will survive correctly

**Complexity:** Low — 5-6 line change in the event handler, 1-line change in the component.

---

### Approach 2: UUID Per Text Part Assigned at Creation (Not Per Render)

Like Approach 1, but use `crypto.randomUUID()` instead of a positional counter for the ID.

```typescript
currentPartsRef.current = [...parts, { type: 'text', text, _partId: crypto.randomUUID() }];
```

**Pros:**

- Globally unique — no risk of collision even if parts array is restructured
- Familiar pattern (already used for `message.id` and `assistantId`)

**Cons:**

- `crypto.randomUUID()` is slightly more expensive than a counter string concat — negligible in
  practice since it fires once per new text block, not per delta
- Provides no additional correctness benefit over positional ID for this use case, since text parts
  within one assistant message don't need globally unique IDs

**Complexity:** Identical to Approach 1.

---

### Approach 3: Composite Key Using Index + Part Type + Content Hash

Use `key={`text-${i}-${part.text.length}`}` or `key={`text-${i}-${someHash(part.text)}`}`.

**Why this doesn't work:** The key changes on every delta (since `part.text.length` changes every
`text_delta`). This forces React to unmount and remount the `<div>` wrapping `StreamingText` on
every event — defeating the purpose of the key and causing visible render flashes.

**Complexity:** Low to implement, but semantically wrong.

---

### Approach 4: Merge All Text Parts in AssistantMessageContent Before Rendering

Instead of rendering one `<div>` per text part, aggregate consecutive text parts into one block
in the component before keying:

```tsx
// Collapse consecutive text parts for rendering only
const renderedBlocks = collapseTextParts(parts);
return renderedBlocks.map((block, i) => ...);
```

**Pros:** Eliminates the multi-text-block key problem by never having more than one text node
(or at least by using a merged index)

**Cons:** Changes the rendering model significantly; loses inter-tool text separation; the collapsed
index still has the same problem if the order of tool calls vs text changes during streaming.

**Complexity:** Medium-high, introduces render-time aggregation that diverges from part structure.

---

## Recommendation for Bug 1

**Approach 1 (positional `_partId` assigned at creation in the event handler).**

Assign `_partId: \`text-part-${parts.length}\`` when a new text part is created in `createStreamEventHandler`
(the `text_delta` else branch, line 139 of `stream-event-handler.ts`). Add `_partId?: string` to the
client-side `TextPart` extension (either via the schema or a discriminated wrapper type at the features
layer). Use `part._partId ?? \`text-${i}\``as the key in`AssistantMessageContent.tsx`to maintain
backward compatibility for history-loaded messages which won't have`\_partId`.

The ID only needs to be assigned for streaming parts (history messages have one text part per message
and don't generate warnings). `_partId` must be preserved through the `parts.map((p) => ({ ...p }))`
snapshot in `updateAssistantMessage` — it will be since it's a regular enumerable property.

**Do not** generate UUID in render — the React docs explicitly warn against `key={Math.random()}` and
`key={crypto.randomUUID()}` called during render. Assign it once in the event handler.

---

# Bug 2: Empty Session ID Guard

## Root Cause — Source-Confirmed

**File:** `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`, lines 37 and 114.

```typescript
// Line 37 — useTaskState receives '' when sessionId is null
const taskState = useTaskState(sessionId ?? '');

// Line 114 — useSessionStatus receives '' when sessionId is null
const { permissionMode } = useSessionStatus(sessionId ?? '', sessionStatus, status === 'streaming');
```

**In `use-task-state.ts`**, the `useQuery` at line 48:

```typescript
const { data: initialTasks } = useQuery({
  queryKey: ['tasks', sessionId, selectedCwd],
  queryFn: () => transport.getTasks(sessionId, selectedCwd ?? undefined),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
  // NO enabled guard — fires with sessionId = ''
});
```

**In `use-session-status.ts`**, the `useQuery` at line 52:

```typescript
const { data: session } = useQuery({
  queryKey: ['session', sessionId, selectedCwd],
  queryFn: () => transport.getSession(sessionId, selectedCwd ?? undefined),
  staleTime: 30_000,
  // NO enabled guard — fires with sessionId = ''
});
```

**Compare to `use-chat-session.ts`** (the correct pattern, line 186):

```typescript
const historyQuery = useQuery({
  queryKey: ['messages', sessionId, selectedCwd],
  queryFn: () => transport.getMessages(sessionId!, selectedCwd ?? undefined),
  enabled: sessionId !== null, // ← correct guard, operates on null, not ''
  // ...
});
```

**Why the coercion to `''` is harmful:** `useTaskState` and `useSessionStatus` accept `string` not
`string | null`. When called with `''`, the hooks fire queries to `GET /api/sessions//task-state`
and `GET /api/sessions//status` — malformed URLs that return 400 or 404 errors. TanStack Query retries
these by default, generating multiple failed requests per second until the real session ID arrives.

**Why null vs undefined vs '' matters for TanStack Query:**

- `enabled: !!sessionId` — works for `null`, `undefined`, and `''` (all falsy). Simplest.
- `enabled: sessionId !== null` — only guards against `null`. Won't guard `''`.
- `enabled: sessionId !== null && sessionId !== ''` — explicit, maximum clarity.
- `skipToken` pattern (TanStack Query v5) — type-safe alternative to `enabled`; the `queryFn` is
  replaced with the sentinel `skipToken` when the parameter is unavailable.

The correct fix has two parts: (1) stop coercing null to `''` in `ChatPanel.tsx`, and (2) add
`enabled` guards to the two hooks.

## Approaches for Bug 2

### Approach A: Stop Coercion + Pass Null Through + Add Enabled Guards (Recommended)

Change `useTaskState` and `useSessionStatus` to accept `string | null` as their `sessionId` parameter.
Add `enabled: !!sessionId` to each hook's `useQuery`. Remove the `?? ''` coercions in `ChatPanel.tsx`.

**`use-task-state.ts` change:**

```typescript
export function useTaskState(sessionId: string | null): TaskState {
  const { data: initialTasks } = useQuery({
    queryKey: ['tasks', sessionId, selectedCwd],
    queryFn: () => transport.getTasks(sessionId!, selectedCwd ?? undefined),
    enabled: !!sessionId,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
```

**`use-session-status.ts` change:**

```typescript
export function useSessionStatus(
  sessionId: string | null,
  streamingStatus: SessionStatusEvent | null,
  isStreaming: boolean
) {
  const { data: session } = useQuery({
    queryKey: ['session', sessionId, selectedCwd],
    queryFn: () => transport.getSession(sessionId!, selectedCwd ?? undefined),
    enabled: !!sessionId,
    staleTime: 30_000,
  });
```

**`ChatPanel.tsx` change:**

```typescript
// Remove ?? '' coercions:
const taskState = useTaskState(sessionId);
const { permissionMode } = useSessionStatus(sessionId, sessionStatus, status === 'streaming');
```

**Pros:**

- Eliminates 400/404 storms completely
- Matches the existing pattern in `use-chat-session.ts` (`enabled: sessionId !== null`)
- `string | null` accurately represents the semantic: "session ID is available or not yet known"
- `enabled: !!sessionId` guards against null, undefined, and '' — covers all coercion scenarios
- No behavior change when `sessionId` is a real UUID

**Cons:**

- `queryFn` uses `!` (non-null assertion) — acceptable here because `enabled: !!sessionId`
  guarantees `sessionId` is truthy when `queryFn` runs; no runtime risk
- Changes the type signature of two hooks — callers must be updated (only `ChatPanel.tsx` calls both)

**Complexity:** Very low — 3 lines per hook + 2 lines in `ChatPanel.tsx`.

---

### Approach B: Use `skipToken` (TanStack Query v5)

```typescript
import { skipToken } from '@tanstack/react-query';

const { data: initialTasks } = useQuery({
  queryKey: ['tasks', sessionId, selectedCwd],
  queryFn: sessionId ? () => transport.getTasks(sessionId, selectedCwd ?? undefined) : skipToken,
  staleTime: 30_000,
  refetchOnWindowFocus: false,
});
```

**Pros:**

- TypeScript-safe: no `!` assertion needed — `sessionId` is narrowed to `string` inside the ternary
- Official TanStack Query v5 pattern for conditional queries
- The `enabled` flag is implicitly false when `queryFn` is `skipToken`

**Cons:**

- Slightly more verbose than the `enabled: !!sessionId` pattern
- The `queryKey` still includes `null` as the session ID, which may produce confusing cache entries
  (`['tasks', null, '/projects/foo']`)
- Less familiar to the team given the codebase uses `enabled: boolean` elsewhere

**Complexity:** Very low — nearly identical to Approach A.

---

### Approach C: Keep '' Coercion, Add Guard Inside Hook

Keep the coercion at the call site (`sessionId ?? ''`) but add `enabled: !!sessionId` inside each hook.

**Why this is strictly worse:** The query key `['tasks', '', selectedCwd]` still gets created and
populated into the TanStack Query cache with `undefined` data. If a real session ever gets the empty
string as its ID (impossible for UUIDs but bad pattern to normalize), the stale cache entry could
serve wrong data. Using `''` as a sentinel in query keys is an anti-pattern.

**Complexity:** Trivially low but semantically incorrect.

---

## Recommendation for Bug 2

**Approach A** — Change hook signatures to `string | null`, add `enabled: !!sessionId` to both
queries, remove `?? ''` coercions in `ChatPanel.tsx`. This matches the existing convention in
`use-chat-session.ts` and is the canonical TanStack Query guard pattern. Approach B (`skipToken`)
is also valid and slightly more type-safe, but the added verbosity is not worth the deviation from
the existing codebase pattern.

**Key implementation notes:**

- The `enabled: !!sessionId` guard on `useTaskState` is particularly important: `useTaskState` also
  has a `useEffect` that calls `setTaskMap(new Map())` on every `initialTasks` change. If the query
  fires with `''` and returns an error, TanStack Query's error retry can cause this effect to re-run
  repeatedly, resetting the live task list.
- After adding the guard, the `useEffect` on `initialTasks` in `useTaskState` only fires with real
  data, which is the correct behavior.

---

# Bug 3: Optimistic Message Consistency

## Root Cause — Source-Confirmed

The DorkOS chat uses a two-layer message model:

1. **Local optimistic state:** `messages` array in `useState` in `useChatSession`, managed by
   `setMessages`. User messages are added optimistically (`executeSubmission`, line 379).
2. **Server-authoritative state:** `historyQuery` (TanStack Query) reads JSONL transcripts via
   `GET /api/sessions/:id/messages`.

**Part A — Optimistic before confirmation:**

```typescript
// use-chat-session.ts, executeSubmission, lines 371-383
const userMessage: ChatMessage = {
  id: crypto.randomUUID(),
  role: 'user',
  content,
  parts: [{ type: 'text', text: content }],
  timestamp: new Date().toISOString(),
};

setMessages((prev) => [...prev, userMessage]); // ← shown immediately
setStatus('streaming');
```

The message is shown before the `POST /api/sessions/:id/send` returns a 202. If the server accepts
the 202 but the agent fails to start (or the relay drops the message), the optimistic bubble vanishes
on next history load (because the JSONL never got the user turn). This is the consistency risk.

**Part B — Mid-stream duplicate bubble:**

The `sync_update` SSE handler (line 293-300 of `use-chat-session.ts`) already guards against
invalidation during streaming:

```typescript
eventSource.addEventListener('sync_update', () => {
  if (statusRef.current === 'streaming') return;  // ← guard exists
  queryClient.invalidateQueries(...);
});
```

However, the race can still occur via the `done` event timing: when `done` fires, `setStatus('idle')`
is called, `statusRef.current` becomes `'idle'`. If a `sync_update` arrives in the same microtask
batch (before the next `sync_update` guard check), the invalidation fires while the history is
still building, causing the refetch to return the real user message from JSONL **alongside** the
optimistic user message still in `messagesRef.current`. The history seed path uses ID-based
deduplication (lines 221-227):

```typescript
if (historySeededRef.current && !isStreaming) {
  const currentIds = new Set(messagesRef.current.map((m) => m.id));
  const newMessages = history.filter((m) => !currentIds.has(m.id));
  if (newMessages.length > 0) {
    setMessages((prev) => [...prev, ...newMessages.map(mapHistoryMessage)]);
  }
}
```

This deduplication works **only when the server's user message has the same ID as the local
optimistic message.** But the optimistic user message uses `crypto.randomUUID()` (line 372) while
the server's JSONL user message has the ID assigned by the Claude SDK (a different UUID derived
from the conversation turn). These IDs are different — the deduplication by ID will not match
the optimistic message to its server-stored counterpart. Result: both appear briefly.

## Approaches for Bug 3

### Approach 1: Suppress Optimistic Bubble — Show Only After JSONL Confirms (Eliminate Part A)

Do not add the user message to `messages` immediately. Instead, rely entirely on the history
refetch after `done` to display the user message. The user sees the assistant begin responding
(streaming text appears) without a preceding user bubble, and the user message appears in the
final history.

```typescript
// Remove these lines from executeSubmission:
// setMessages((prev) => [...prev, userMessage]);

// After done event, the invalidateQueries call (or sync_update) causes
// historyQuery to refetch and display both the user and assistant messages
// from the authoritative JSONL source.
```

**Pros:**

- Eliminates Part A (consistency risk with 202 ACK) and Part B (duplicate) in one change
- Perfect consistency: what the UI shows is always what the JSONL contains
- No deduplication logic needed
- Simplifies `executeSubmission` by removing the optimistic mutation step
- Aligns with the JSONL-as-source-of-truth principle from ADR-0043

**Cons:**

- The user sees no feedback between submit and the first streaming `text_delta` — on typical
  latency (200-800ms), the input clears but nothing appears for the duration of the first
  assistant message generation latency
- On very high latency (> 1s), the UX feels broken — user wonders if the message was sent
- The "input cleared" signal provides partial feedback but is weak
- For Relay path specifically: the 202 ACK arrives before streaming begins; the gap between
  submit and first token is typically 500-2000ms. Removing the user bubble makes this gap
  feel longer subjectively.

**UX assessment:** Acceptable for a power-user tool like DorkOS (Kai and Priya understand
asynchronous systems), but noticeably worse for any response latency above ~500ms. The prior
research on Vercel AI SDK confirms that SDK v5+ uses "transient parts" precisely because
the UX benefit of immediate feedback outweighs the consistency complexity.

**Complexity:** Very low — remove 1 line from `executeSubmission`.

---

### Approach 2: Keep Optimistic Bubble + Deduplicate by Content-Hash (Fix Part B Only)

Keep the optimistic user message. Add content-based deduplication in the history seed path:
match the optimistic message by its `role`, `content` text, and approximate timestamp (within
a 5-second window) to suppress showing the JSONL-sourced user message when an optimistic
counterpart already exists.

```typescript
// In history seed effect, after isStreaming check:
if (historySeededRef.current && !isStreaming) {
  const currentOptimisticUser = messagesRef.current.find(
    (m) => m.role === 'user' && !serverIds.has(m.id)
  );
  const serverIds = new Set(history.map((m) => m.id));
  const newMessages = history.filter((m) => {
    if (serverIds.has(m.id)) return false;
    // Suppress server user message if content matches an optimistic message
    if (m.role === 'user' && currentOptimisticUser && m.content === currentOptimisticUser.content) {
      return false;
    }
    return true;
  });
}
```

**Pros:**

- Preserves good UX (user sees their message immediately)
- Eliminates the duplicate bubble
- Content matching is reliable for exact message text

**Cons:**

- Does NOT fix Part A (consistency risk with delivery failure after 202)
- Content-matching is fragile when `transformContent` modifies the message (e.g., file prefix
  gets prepended, making `finalContent !== content`). The optimistic message is updated with
  `finalContent` at line 405, but timing may mean the comparison misses it.
- Two identical messages sent back-to-back would incorrectly suppress the second server message
- Complexity is low but the fragility is hard to reason about

**Complexity:** Low-medium — 8-10 lines in the seed effect.

---

### Approach 3: Assign Optimistic Message a Stable Client ID That the Server Echoes Back (Ideal Long-Term)

At submission time, generate a `clientMessageId` and send it in the POST body:

```typescript
const clientMessageId = crypto.randomUUID();
const userMessage = { id: clientMessageId, ... };
// POST body includes: { content, clientMessageId }
```

The server writes `clientMessageId` into the JSONL turn. When the history refetch returns,
the JSONL user message has the same `id` as the optimistic message. The existing ID-based
deduplication (line 221-227) then works correctly.

**Pros:**

- Fixes both Part A and Part B in the most principled way
- No heuristic content-matching
- The server knows which client initiated the turn (useful for debugging)
- Consistent with the `correlationId` pattern already used in the relay path

**Cons:**

- Requires server-side changes to the POST /api/sessions/:id/send route to accept and persist
  `clientMessageId` in the JSONL
- Requires SDK-level support or a wrapper that injects the ID into the transcript turn
- Non-trivial: the JSONL format is controlled by the Claude SDK; adding fields requires either
  a pre-write wrapper or post-write mutation of the JSONL, both of which have risks

**Complexity:** High — server and client changes required; JSONL format change.

---

### Approach 4: Use React 19 `useOptimistic` + Automatic Revert on Action Failure (Fix Part A)

Wrap the optimistic message in `useOptimistic`:

```typescript
const [optimisticMessages, addOptimisticMessage] = useOptimistic(
  messages,
  (prev, newMsg: ChatMessage) => [...prev, newMsg]
);
// In executeSubmission, inside startTransition:
addOptimisticMessage(userMessage);
```

**Pros:**

- `useOptimistic` automatically reverts the optimistic state when the enclosing async transition
  settles (either successfully or with an error)
- If the POST fails, the bubble disappears automatically — no manual rollback needed
- Purpose-built by React 19 for exactly this use case
- Project already uses React 19

**Cons:**

- Requires wrapping `executeSubmission` in `startTransition`, which may conflict with the
  current non-transition call pattern in `handleSubmit` and `submitContent`
- `useOptimistic` reverts when the transition settles — for the relay path, the transition
  settles on 202 receipt (not on `done`), so the bubble would disappear immediately after the
  202, before streaming completes. This is the wrong behavior.
- Known React 19 issue: `useOptimistic` can roll back state unexpectedly when other background
  transitions are running (GitHub issue #31967 and #30637), which could cause the bubble to
  flash off during streaming.
- Significant restructuring of `useChatSession` around React transitions

**Complexity:** High — restructuring of submission flow required; conflicts with streaming model.

---

### Approach 5: Guard Invalidation on `sync_update` Until History Contains User Message (Fix Part B)

After the `done` event, don't invalidate immediately. Instead, poll the query until the returned
history contains the user message (matched by content or timestamp), then stop:

**Pros:** Guarantees no duplicate bubble
**Cons:** Polling is fragile; adds latency to the sync; complex logic for an edge case that has
a simpler root cause.

**Complexity:** High, fragile.

---

### Approach 6: Keep Optimistic Bubble + Suppress Invalidation for 500ms After `done` (Practical Band-Aid for Part B)

After the `done` event fires and `setStatus('idle')` is called, set a `postDoneRef` flag for 500ms.
In the `sync_update` handler, also check `!postDoneRef.current`:

```typescript
// In done event handler:
const postDoneRef = useRef(false);
// ...
case 'done':
  postDoneRef.current = true;
  setTimeout(() => { postDoneRef.current = false; }, 500);
  setStatus('idle');
```

**Pros:** Very targeted — only suppresses the specific race window
**Cons:** Arbitrary 500ms timeout; if the race window is wider (slow history fetch), the duplicate
still appears; adds a magic timeout constant.

**Complexity:** Low but brittle.

---

## Recommendation for Bug 3

**Recommended approach: Approach 1 (eliminate the optimistic user bubble) for correctness; enhance
with a visual "sending" placeholder as the UX mitigation.**

The correct long-term answer is **not** to show the user message optimistically at all. DorkOS is
JSONL-as-source-of-truth (ADR-0043). Showing data that may never be persisted violates that
contract. The deduplication approaches (2, 5, 6) are band-aids on a fundamental tension: the
optimistic message has a different ID than the server message, making ID-based deduplication
impossible without protocol changes (Approach 3).

**However**, removing the optimistic bubble cold creates a UX gap. The mitigation is to show a
"Sending..." placeholder in the input area or a dimmed/pending bubble that is NOT added to the
`messages` array — purely a UI indicator that a send is in flight. This is distinct from an
optimistic message because it is removed unconditionally when `done` fires (or on error), never
participates in history seeding, and does not create duplication.

**Implementation outline:**

- In `useChatSession`, add `const [pendingUserContent, setPendingUserContent] = useState<string | null>(null)`.
- In `executeSubmission`, set `setPendingUserContent(content)` and remove `setMessages((prev) => [...prev, userMessage])`.
- On `done`, set `setPendingUserContent(null)`.
- On error, set `setPendingUserContent(null)`.
- In `ChatPanel.tsx`, pass `pendingUserContent` to `MessageList`, which renders a dimmed placeholder
  bubble at the bottom of the list (outside the JSONL-sourced `messages` array).
- The placeholder never has a stable ID and is not subject to deduplication — it is ephemeral UI state.

This approach:

- Eliminates the Part A consistency risk entirely (no optimistic message in `messages` = no stale data)
- Eliminates the Part B duplicate bubble (the placeholder is not in `messages` = doesn't conflict with history)
- Preserves the perceived-latency UX benefit (user sees immediate feedback)
- Is honest about the uncertainty: the placeholder style can differ from confirmed messages

**If a placeholder UI is too much work for the current sprint, Approach 1 (no optimistic + no placeholder)
is still correct and acceptable** — the input clearing is sufficient feedback for DorkOS's power-user
audience. Do not implement content-hash deduplication (Approach 2) — it is fragile and does not fix
Part A.

---

# Overall Considerations

## Performance Implications

**Bug 1 fix (stable `_partId`):** One `crypto.randomUUID()` (or string concat) per new text block,
not per `text_delta`. A typical streaming response creates 1-3 text blocks (text, tool calls, more
text). Cost is negligible.

**Bug 2 fix (enabled guard):** Prevents ~2-10 wasted network requests per null-sessionId render.
Also prevents TanStack Query retry chains (default 3 retries with exponential backoff). Significant
positive impact on server load during the initial page render where `sessionId` is null.

**Bug 3 fix (remove optimistic):** Removes one `setMessages` call per submission. Negligible
performance impact. Adds `setPendingUserContent` (1 extra setState) — also negligible.

## Test Coverage Needed

**Bug 1:**

- Add a test to `MessageItem.test.tsx` or `AssistantMessageContent.test.tsx` that renders a message
  with two text parts and asserts both render correctly with distinct keys.
- Add a test that simulates streaming text_delta events on a message that already has a tool_call
  part and verifies no duplicate key warning (can use React Testing Library's `console.error` spy).

**Bug 2:**

- Add a test to `use-task-state` and `use-session-status` tests asserting that the query does NOT
  fire when `sessionId` is `null` (use `vi.mocked(transport.getTasks).toHaveBeenCalledTimes(0)`).
- Add a test to `ChatPanel.test.tsx` asserting that mounting with `sessionId={null}` generates no
  network calls to task-state or session-status endpoints.

**Bug 3:**

- Add a test to `use-chat-session.test.tsx` asserting that `messages` does NOT include a user message
  immediately after `handleSubmit` is called (if eliminating optimistic).
- Or assert that a `pendingUserContent` value IS set (if implementing the placeholder approach).
- Add a test verifying that after the `done` event fires, messages from history refetch include the
  user message exactly once.

## Risk of Regressions

**Bug 1:** Risk is very low. The `_partId` field is additive. History-loaded messages without `_partId`
fall back to the existing `key={\`text-${i}\`}` (can use `part._partId ?? \`text-${i}\``). No behavior
change for non-streaming messages.

**Bug 2:** Risk is very low. The `enabled` guard only prevents queries from firing when `sessionId`
is falsy — this was already broken behavior. No regression to existing sessions with real IDs.
The type signature change (`string` → `string | null`) in `useTaskState` and `useSessionStatus`
requires updating callers; TypeScript will flag any missed callers at compile time.

**Bug 3:** Risk is moderate if implementing the placeholder approach (new state, new prop threading
through `ChatPanel` → `MessageList`). Risk is low if simply removing the optimistic line. The main
regression risk for "remove optimistic" is the UX degradation for high-latency relay connections —
test with relay mode enabled on a simulated 500ms+ POST latency.

---

# Sources & Evidence

- Source read: `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` —
  confirmed `key={\`text-${i}\`}`on line 121;`tool_call`uses`key={part.toolCallId}` (stable)
- Source read: `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — confirmed
  `TextPart` is created without an ID field; parts array is immutably replaced on each `text_delta`
- Source read: `packages/shared/src/schemas.ts` — confirmed `TextPartSchema` has no `id` field;
  only `type: 'text'` and `text: string`
- Source read: `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — confirmed `sessionId ?? ''`
  coercion on lines 37 and 114
- Source read: `apps/client/src/layers/features/chat/model/use-task-state.ts` — confirmed no `enabled`
  guard on the `useQuery`; also confirmed the `setTaskMap(new Map())` effect fires on every query result
- Source read: `apps/client/src/layers/entities/session/model/use-session-status.ts` — confirmed no
  `enabled` guard; convergence effect for localModel already in place (this bug is separate)
- Source read: `apps/client/src/layers/features/chat/model/use-chat-session.ts` — confirmed `enabled:
sessionId !== null` already exists (line 186); optimistic user message at line 379; ID deduplication
  in seed effect at lines 221-227; `statusRef` guard on `sync_update` at line 297
- Prior research: [20260307_relay_streaming_bugs_tanstack_query.md](./20260307_relay_streaming_bugs_tanstack_query.md)
  — `isStreamingRef` guard pattern; ID-based deduplication; TanStack Query `enabled: false` behavior
- Prior research: [20260310_fix_chat_streaming_model_selector_bugs.md](./20260310_fix_chat_streaming_model_selector_bugs.md)
  — history seed `isStreaming` guard (Approach A); convergence effect for optimistic local state
- [React — Lists and Keys](https://legacy.reactjs.org/docs/lists-and-keys.html): "Using indexes for
  keys is not recommended if the order of items may change"
- [React key attribute — developerway.com](https://www.developerway.com/posts/react-key-attribute):
  index-based keys cause full re-render even for memoized components; ID-based keys prevent this
- [TanStack Query — enabled flag and skipToken](https://tanstack.com/query/v5/docs/framework/react/guides/dependent-queries):
  `enabled: !!param` prevents query execution; `skipToken` is the v5 TypeScript-safe alternative
- [TanStack Query Discussion #5916 — undefined query params](https://github.com/TanStack/query/discussions/5916):
  `skipToken` introduced specifically to avoid `enabled: !!param` with non-null assertion in queryFn
- [TanStack Query Discussion #2011 — null as query key](https://github.com/TanStack/query/discussions/2011):
  null in query keys is valid but using '' as a sentinel is an anti-pattern
- [TanStack Query v5 — Optimistic Updates](https://tanstack.com/query/v5/docs/react/guides/optimistic-updates):
  `onMutate`/`cancelQueries`/rollback pattern; `variables`/`isLoading` pattern
- [tkdodo.eu — Concurrent Optimistic Updates in React Query](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query):
  `isMutating` guard to prevent invalidation from overwriting optimistic state during multiple mutations
- [React 19 — useOptimistic](https://react.dev/reference/react/useOptimistic): automatic revert
  when async transition settles; requires `startTransition` wrapper
- [React 19 — useOptimistic issue #31967](https://github.com/facebook/react/issues/31967): known
  issue where `useOptimistic` rolls back state unexpectedly when background transitions run
- [Vercel AI SDK — transient parts](https://vercel.com/blog/ai-sdk-5): "Transient parts are sent to
  the client but not added to the message history" — design justification for ephemeral streaming state
- [GetStream/stream-chat-react — optimistic UI #605](https://github.com/GetStream/stream-chat-react/issues/605):
  real-world chat library's approach to optimistic message reconciliation with server-confirmed messages
- [Key Stability in Lists — Steve Kinney React Performance](https://stevekinney.com/courses/react-performance/key-stability-in-lists):
  stable keys prevent unnecessary re-renders; unstable keys cause unmount/remount on every render

---

# Research Gaps & Limitations

- The exact frequency at which the "duplicate key" warning fires (~300 per response) was not
  profiled. The estimate is based on typical streaming response length (~1200 tokens ÷ 4 chars/token
  × 1 delta/token = ~300 `text_delta` events). The actual count depends on SDK batching behavior.
- The Part B duplicate bubble race was not reproduced in a running application — the analysis is
  structural. The window between `done` event and `sync_update` invalidation completing may be
  sub-perceptible in practice (< 100ms on localhost). The risk is real but low-frequency.
- The placeholder UI approach for Bug 3 was not prototyped. The component tree (ChatPanel →
  MessageList → placeholder) was identified but not fully designed. The `pendingUserContent` prop
  threading adds coupling that may warrant a Zustand store entry instead.
- `useOptimistic` (Approach 4 for Bug 3) was not prototyped. The known GitHub issues suggest it
  may have reliability problems with concurrent background updates — the DorkOS relay path (with
  multiple SSE events per message) is exactly the kind of scenario where these issues manifest.

---

# Search Methodology

- Searches performed: 10
- Most productive search terms: "TanStack Query enabled null undefined empty string guard skipToken",
  "React stable key streaming content list UUID vs index", "TanStack Query optimistic update
  cancelQueries onMutate streaming avoid invalidation", "useOptimistic React 19 chat message
  useTransition revert", "AI chat bubble deduplication optimistic server-sourced react query"
- Primary sources: Direct source code reads (8 files), TanStack Query docs/GitHub discussions,
  React 19 docs, Vercel AI SDK blog, tkdodo.eu blog, prior DorkOS research files
- Prior research fully covered: `20260307_relay_streaming_bugs_tanstack_query.md`,
  `20260310_fix_chat_streaming_model_selector_bugs.md` — cross-referenced extensively
