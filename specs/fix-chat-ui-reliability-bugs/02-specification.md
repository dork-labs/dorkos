---
slug: fix-chat-ui-reliability-bugs
number: 121
created: 2026-03-11
status: specified
ideation: specs/fix-chat-ui-reliability-bugs/01-ideation.md
---

# Fix Chat UI Reliability Bugs

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-03-11
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## Overview

Fix three confirmed reliability bugs in the DorkOS chat UI, all discovered via automated self-testing on 2026-03-11. The fixes are entirely client-side — no server changes required.

| #   | Bug                                   | Severity | Symptom                                                         |
| --- | ------------------------------------- | -------- | --------------------------------------------------------------- |
| 1   | React duplicate key storm             | High     | ~300 console errors per streaming response                      |
| 2   | Empty session ID API errors           | High     | 400/404 on every new session before first message               |
| 3   | Optimistic user message inconsistency | Medium   | Bubble vanishes on reload; transient duplicate during streaming |

---

## Background / Problem Statement

Automated self-testing (`test-results/chat-self-test/20260311-175156.md`) revealed three reliability issues that degrade developer experience, pollute logs, and produce inconsistent UI state:

1. **React duplicate key storm** — `AssistantMessageContent.tsx:121` keys text parts by array index (`key={\`text-${i}\`}`). During streaming, the `parts`array is rebuilt on every`text_delta`event. If the array's shape changes (text → tool_call → text), index-based keys collide, firing ~300 "Encountered two children with the same key" warnings per message. The root cause is in`stream-event-handler.ts:139`: new text parts are created without a stable identifier.

2. **Empty session ID API errors** — `ChatPanel.tsx` coerces a null `sessionId` to `''` before passing it to `useTaskState` and `useSessionStatus`. Neither hook has an `enabled` guard, so they fire API requests immediately with `''` as the session ID (`GET /api/sessions//task-state → 400`, `GET /api/sessions//status → 404`). The correct guard (`enabled: sessionId !== null`) already exists in `use-chat-session.ts:186` for the `historyQuery` — it was simply missed for these two hooks.

3. **Optimistic user message inconsistency** — `use-chat-session.ts:379` adds an optimistic user message bubble to the local `messages` array before Relay confirms delivery. If the Relay drops the message post-202, the bubble vanishes on page reload (violates ADR-0003: JSONL as source of truth). Additionally, the optimistic message's client-generated `id` never matches the SDK-assigned JSONL `id`, so the deduplication logic at lines 221-227 cannot reconcile them. When a `sync_update` event triggers a history refetch near the streaming `done` event, both the optimistic and JSONL-sourced user bubbles appear simultaneously — a transient duplicate.

---

## Goals

- Zero "Encountered two children with the same key" React warnings during or after streaming
- No network requests to `/api/sessions//task-state` or `/api/sessions//status` when `sessionId` is null
- User message bubble provides immediate visual feedback on submit (via ephemeral pending state)
- User message visibility is consistent between live streaming and page reload
- No transient duplicate user bubbles during multi-tool streaming responses

---

## Non-Goals

- SSE streaming architecture changes
- JSONL persistence internals
- Relay transport internals (no changes to `transport.sendMessageRelay`)
- Server-side changes of any kind
- Unrelated UI features or performance improvements
- Adding `id` to `TextPartSchema` in `packages/shared/src/schemas.ts` (wire protocol must not change)

---

## Technical Dependencies

- React 19 (already in use) — `useState`, `useEffect`, `useCallback`, `useRef`
- TanStack Query v5 (already in use) — `useQuery`, `enabled` option
- No new libraries required

**Related ADRs:**

- ADR-0003: JSONL as source of truth for session message history — Bug 3 fix restores compliance
- ADR-0043: Agent storage file-first write-through — not directly affected

---

## Detailed Design

### Bug 1: Stable React Keys for Streaming Text Parts

#### Root Cause

`AssistantMessageContent.tsx:121`:

```tsx
<div key={`text-${i}`} className="msg-assistant">
```

`stream-event-handler.ts:139`:

```ts
// text_delta else branch — NEW TEXT PART, no id field
currentPartsRef.current = [...parts, { type: 'text', text }];
```

`TextPartSchema` (`packages/shared/src/schemas.ts:323-328`):

```ts
export const TextPartSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});
```

No `id` field on the wire protocol.

#### Fix

**Step 1: Extend the client-only type to allow `_partId`**

In `stream-event-handler.ts`, define a local type extension for text parts that carries a `_partId` field. This field is never serialized or sent over the wire — it exists only in the in-memory streaming state.

```ts
// stream-event-handler.ts
type StreamingTextPart = { type: 'text'; text: string; _partId: string };
```

Or use an intersection at the assignment site with no type-level change to `TextPartSchema`.

**Step 2: Assign `_partId` at text part creation (once, never mutated)**

In the `text_delta` else branch:

```ts
// Before (line 139):
currentPartsRef.current = [...parts, { type: 'text', text }];

// After:
currentPartsRef.current = [...parts, { type: 'text', text, _partId: `text-part-${parts.length}` }];
```

The counter `parts.length` at creation time is the stable position of this part in the array. It is assigned exactly once. When the text part is subsequently updated by later `text_delta` events (the `if (lastPart.type === 'text')` branch at line 132-137), the spread `{ ...lastPart, text: ... }` preserves `_partId` automatically.

**Step 3: Use `_partId` as the React key**

In `AssistantMessageContent.tsx:121`:

```tsx
// Before:
<div key={`text-${i}`} className="msg-assistant">

// After:
<div key={(part as { _partId?: string })._partId ?? `text-${i}`} className="msg-assistant">
```

The fallback to `text-${i}` handles history-loaded messages that never go through the streaming handler and therefore have no `_partId`. This is safe — history messages are loaded once and their array does not change shape.

**Why not UUID?** `crypto.randomUUID()` would also work but is unnecessary — the positional counter string is deterministic, cheap, and sufficient. The key's purpose is stability within a single streaming session, not global uniqueness.

**Why not add `id` to `TextPartSchema`?** The `TextPartSchema` is part of the shared package's wire protocol. Changing it would require updating the server transcript parser, the SDK integration layer, and all consumers. The `_partId` is a client-only streaming concern.

---

### Bug 2: Session ID Guard in TanStack Query Hooks

#### Root Cause

```tsx
// ChatPanel.tsx:37
const taskState = useTaskState(sessionId ?? '');

// ChatPanel.tsx:114
const { permissionMode } = useSessionStatus(sessionId ?? '', sessionStatus, status === 'streaming');
```

```ts
// use-task-state.ts:48-53 — no enabled guard
const { data: initialTasks } = useQuery({
  queryKey: ['tasks', sessionId, selectedCwd],
  queryFn: () => transport.getTasks(sessionId, selectedCwd ?? undefined),
  staleTime: 30_000,
  refetchOnWindowFocus: false,
  // MISSING: enabled: !!sessionId
});

// use-session-status.ts:52-56 — no enabled guard
const { data: session } = useQuery({
  queryKey: ['session', sessionId, selectedCwd],
  queryFn: () => transport.getSession(sessionId, selectedCwd ?? undefined),
  staleTime: 30_000,
  // MISSING: enabled: !!sessionId
});
```

#### Fix

**Step 1: Change hook signatures to accept `string | null`**

```ts
// use-task-state.ts
export function useTaskState(sessionId: string | null): TaskState {
  // ...
  const { data: initialTasks } = useQuery({
    queryKey: ['tasks', sessionId, selectedCwd],
    queryFn: () => transport.getTasks(sessionId!, selectedCwd ?? undefined),
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    enabled: !!sessionId,  // ← ADD THIS
  });
```

```ts
// use-session-status.ts
export function useSessionStatus(
  sessionId: string | null,  // ← was: string
  streamingStatus: StreamingStatus | null,
  isStreaming: boolean,
): SessionStatusData {
  // ...
  const { data: session } = useQuery({
    queryKey: ['session', sessionId, selectedCwd],
    queryFn: () => transport.getSession(sessionId!, selectedCwd ?? undefined),
    staleTime: 30_000,
    enabled: !!sessionId,  // ← ADD THIS
  });
```

The non-null assertion (`sessionId!`) in `queryFn` is safe: TanStack Query's `enabled` guard guarantees `queryFn` is never called when `enabled` is false.

**Step 2: Remove `?? ''` coercions in `ChatPanel.tsx`**

```tsx
// ChatPanel.tsx:37
// Before:
const taskState = useTaskState(sessionId ?? '');
// After:
const taskState = useTaskState(sessionId);

// ChatPanel.tsx:114
// Before:
const { permissionMode } = useSessionStatus(sessionId ?? '', sessionStatus, status === 'streaming');
// After:
const { permissionMode } = useSessionStatus(sessionId, sessionStatus, status === 'streaming');
```

TypeScript will validate these call sites compile with the new `string | null` signature.

**Pattern reference:** `use-chat-session.ts:186` already uses `enabled: sessionId !== null`. Both forms (`enabled: !!sessionId` and `enabled: sessionId !== null`) are semantically equivalent; use `enabled: !!sessionId` for conciseness, matching the `useQuery` idiomatic style.

---

### Bug 3: Optimistic User Message → Pending State Architecture

#### Root Cause

**Part A (delivery inconsistency):**

```ts
// use-chat-session.ts:379 — fires BEFORE Relay confirms
setMessages((prev) => [...prev, userMessage]);
```

**Part B (dedup race):**
The optimistic `userMessage.id` is `crypto.randomUUID()`. The JSONL-stored user message has an SDK-assigned ID. These never match, so the dedup logic at lines 221-227 cannot remove the optimistic bubble when JSONL history arrives.

#### Fix

**Step 1: Remove the optimistic `setMessages` call**

```ts
// use-chat-session.ts, in executeSubmission
// Remove this line:
setMessages((prev) => [...prev, userMessage]);
```

The `userMessage` object is also used to update content after `transformContent` runs (lines 403-408). This secondary update must also be removed since the optimistic message no longer exists in `messages`.

**Step 2: Add `pendingUserContent` state**

```ts
// In useChatSession, alongside existing state declarations:
const [pendingUserContent, setPendingUserContent] = useState<string | null>(null);
```

Set it when the user submits:

```ts
// In executeSubmission, replace setMessages(...userMessage):
setPendingUserContent(content); // Show pending bubble immediately
```

Clear it on the first streaming `text_delta` event (the moment the server has received and begun processing the message):

```ts
// In stream-event-handler.ts, text_delta case, at the top:
if (pendingUserContentRef.current !== null) {
  pendingUserContentRef.current = null;
  setPendingUserContent(null);
}
```

Or equivalently, clear it in `executeSubmission` after the first streaming event arrives. The simplest implementation: clear `pendingUserContent` at the start of the `done` event handler (or on error). If clearing on `text_delta` is preferred for responsiveness, a ref is needed to avoid closure staleness.

**Clear on error:** In the catch block:

```ts
setPendingUserContent(null);
```

**Step 3: Expose `pendingUserContent` from `useChatSession`**

```ts
// useChatSession return value — add:
return {
  messages,
  pendingUserContent, // ← NEW
  // ... existing fields
};
```

**Step 4: Thread `pendingUserContent` through `ChatPanel` → `MessageList`**

In `ChatPanel.tsx`:

```tsx
const {
  messages,
  pendingUserContent,  // ← destructure
  // ... existing fields
} = useChatSession(sessionId, { ... });
```

Pass to `MessageList`:

```tsx
<MessageList
  messages={messages}
  pendingUserContent={pendingUserContent} // ← NEW prop
  // ... existing props
/>
```

**Step 5: Add `pendingUserContent` prop to `MessageList` and render pending bubble**

```ts
// MessageList.tsx — update interface:
interface MessageListProps {
  // ... existing props
  pendingUserContent?: string | null;
}
```

Render after the last message in the list, when `pendingUserContent` is non-null:

```tsx
{
  pendingUserContent && (
    <div className="msg-user msg-user--pending" aria-label="Sending…">
      {pendingUserContent}
    </div>
  );
}
```

The pending bubble should be visually distinct from confirmed messages — use reduced opacity or a subtle animation to signal "in-flight" state. Follow the existing `msg-user` styling conventions. Do not add an animated spinner unless it matches existing loading states.

**`messages` empty state guard:** The current `ChatPanel.tsx:248-254` renders an empty state when `messages.length === 0`. After this fix, a user submitting the first message will trigger `pendingUserContent !== null` while `messages.length === 0`. The guard must account for this:

```tsx
) : messages.length === 0 && !pendingUserContent ? (
  // Empty state
) : (
  <MessageList
    messages={messages}
    pendingUserContent={pendingUserContent}
    // ...
  />
)
```

#### Why not content-hash deduplication?

Content-hash matching (`role === 'user' && message.content === pendingContent`) is fragile:

- Fails when `transformContent` modifies the message (file prefixes, context injection)
- Fails for back-to-back identical messages
- Doesn't fix Part A (delivery failure consistency)

The `pendingUserContent` approach fixes both parts cleanly with no heuristics.

#### Why not React 19 `useOptimistic`?

`useOptimistic` reverts the state when the enclosing transition settles. In the Relay path, the transition settles on the 202 ACK — before the assistant response begins streaming. This would cause the bubble to disappear immediately after acknowledgment, defeating the purpose. Additionally, known React 19 issues (#31967, #30637) cause unexpected rollbacks during background transitions.

---

## Data Flow Diagrams

### Bug 1: Before/After

```
BEFORE:
text_delta event → { type: 'text', text }  (no _partId)
  → parts array rebuilt → AssistantMessageContent
    → key={`text-${i}`} → React key collision on shape change
      → 300 warnings per response

AFTER:
text_delta event → { type: 'text', text, _partId: 'text-part-N' }  (assigned once)
  → parts array rebuilt → AssistantMessageContent
    → key={part._partId ?? `text-${i}`} → stable key, no collision
```

### Bug 2: Before/After

```
BEFORE:
sessionId = null → ChatPanel (sessionId ?? '') → useTaskState('')
  → useQuery({ queryKey: ['tasks', '', cwd] }) → GET /api/sessions//task-state → 400

AFTER:
sessionId = null → ChatPanel (passes null) → useTaskState(null)
  → useQuery({ enabled: false }) → no request fired
```

### Bug 3: Before/After

```
BEFORE:
handleSubmit → setMessages([...prev, userMessage])  ← optimistic, crypto.randomUUID() id
  → transport.sendMessageRelay → 202 → delivery may fail
  → sync_update → historyQuery refetch → JSONL user msg (different id) arrives
    → dedup fails → both appear (Part B)
  → page reload → no JSONL entry → bubble gone (Part A)

AFTER:
handleSubmit → setPendingUserContent(content)  ← ephemeral UI state only
  → transport.sendMessageRelay → 202 → first text_delta arrives
    → setPendingUserContent(null)  ← cleared; JSONL user msg appears via history
  → page reload → JSONL has user msg → consistent visibility (Part A fixed)
  → sync_update during streaming → messages has no optimistic bubble → no dedup issue (Part B fixed)
```

---

## User Experience

### Bug 1

No visible user-facing change. Console noise eliminated. React reconciliation is more efficient with stable keys.

### Bug 2

No visible user-facing change. 400/404 error toasts (if any) eliminated on new sessions. Server log noise reduced.

### Bug 3

**Submit feedback:** User sees a pending bubble immediately after pressing Enter/Send. The bubble is visually distinct (reduced opacity or "sending" indicator) and transitions to a normal confirmed bubble once the first streaming token arrives.

**Reload consistency:** User message always appears after page reload, matching what's in the JSONL transcript.

**No duplicate bubble:** During multi-tool streaming, the user bubble appears exactly once.

---

## Testing Strategy

### Bug 1: Duplicate Key Tests

**File:** `apps/client/src/layers/features/chat/ui/message/__tests__/AssistantMessageContent.test.tsx` (create)

```ts
/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { AssistantMessageContent } from '../AssistantMessageContent';
import type { MessagePart } from '@dorkos/shared/types';

describe('AssistantMessageContent — React key stability', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // Purpose: catch any "duplicate key" or React reconciliation warnings
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('renders multi-block parts (text, tool_call, text) without key warnings', () => {
    // Purpose: verify stable _partId keys prevent collisions when parts array
    // has mixed types — the exact shape that triggered the key storm in production
    const parts: (MessagePart & { _partId?: string })[] = [
      { type: 'text', text: 'First block', _partId: 'text-part-0' },
      {
        type: 'tool_call',
        toolCallId: 'tc-1',
        toolName: 'Read',
        input: '{}',
        status: 'complete',
      },
      { type: 'text', text: 'Second block', _partId: 'text-part-2' },
    ];

    render(
      <AssistantMessageContent
        parts={parts}
        sessionId="test-session"
        isStreaming={false}
        activeToolCallId={null}
      />
    );

    // Should render without any duplicate-key warnings
    const keyWarnings = consoleErrorSpy.mock.calls
      .flat()
      .filter((arg) => typeof arg === 'string' && arg.includes('same key'));
    expect(keyWarnings).toHaveLength(0);
  });

  it('falls back to index key for history parts without _partId', () => {
    // Purpose: confirm history-loaded parts (no _partId) still render without errors
    const parts: MessagePart[] = [
      { type: 'text', text: 'History text' },
    ];

    render(
      <AssistantMessageContent
        parts={parts}
        sessionId="test-session"
        isStreaming={false}
        activeToolCallId={null}
      />
    );

    expect(consoleErrorSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('same key')
    );
  });
});
```

**File:** `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler.test.ts` (create or extend)

```ts
describe('stream-event-handler — _partId assignment', () => {
  it('assigns _partId to new text parts on text_delta', () => {
    // Purpose: verify _partId is assigned exactly once at part creation
    // so keys are stable regardless of how many subsequent deltas arrive
    const handler = createStreamEventHandler({ ... });
    handler('text_delta', { text: 'Hello' }, 'asst-1');
    handler('text_delta', { text: ' world' }, 'asst-1');

    const parts = getCurrentParts(); // expose via test hook
    expect(parts[0]).toHaveProperty('_partId', 'text-part-0');
    // _partId must not change between deltas
  });

  it('preserves _partId across delta appends to same text part', () => {
    // Purpose: confirm { ...lastPart, text: ... } spread preserves _partId
    const handler = createStreamEventHandler({ ... });
    handler('text_delta', { text: 'A' }, 'asst-1');
    const idAfterFirst = getCurrentParts()[0]._partId;
    handler('text_delta', { text: 'B' }, 'asst-1');
    expect(getCurrentParts()[0]._partId).toBe(idAfterFirst);
  });
});
```

### Bug 2: Session ID Guard Tests

**File:** `apps/client/src/layers/features/chat/model/__tests__/use-task-state.test.ts` (create)

```ts
describe('useTaskState — sessionId guard', () => {
  it('does not call transport.getTasks when sessionId is null', () => {
    // Purpose: verify the enabled guard prevents API calls with empty session ID
    // This is the exact bug: API was called with '' causing 400 errors
    const mockTransport = createMockTransport();

    renderHook(() => useTaskState(null), {
      wrapper: ({ children }) => (
        <TransportProvider transport={mockTransport}>{children}</TransportProvider>
      ),
    });

    expect(mockTransport.getTasks).not.toHaveBeenCalled();
  });

  it('calls transport.getTasks when sessionId is provided', async () => {
    // Purpose: confirm the guard doesn't over-suppress legitimate queries
    const mockTransport = createMockTransport();
    mockTransport.getTasks.mockResolvedValue({ tasks: [] });

    renderHook(() => useTaskState('session-123'), { wrapper: ... });

    await waitFor(() => {
      expect(mockTransport.getTasks).toHaveBeenCalledWith('session-123', undefined);
    });
  });
});
```

**File:** `apps/client/src/layers/entities/session/model/__tests__/use-session-status.test.ts` (create or extend)

```ts
describe('useSessionStatus — sessionId guard', () => {
  it('does not call transport.getSession when sessionId is null', () => {
    // Purpose: same guard pattern as useTaskState — verify no request with null
    const mockTransport = createMockTransport();

    renderHook(() => useSessionStatus(null, null, false), { wrapper: ... });

    expect(mockTransport.getSession).not.toHaveBeenCalled();
  });
});
```

### Bug 3: Pending User Content Tests

**File:** `apps/client/src/layers/features/chat/model/__tests__/use-chat-session.test.ts` (extend existing or create)

```ts
describe('useChatSession — pendingUserContent', () => {
  it('sets pendingUserContent on submit, does not add to messages', async () => {
    // Purpose: verify the architectural boundary — messages = JSONL-sourced,
    // pendingUserContent = ephemeral UI state. Before this fix, messages
    // received an optimistic entry that could vanish on reload.
    const { result } = renderHook(() => useChatSession(null, {}), { wrapper: ... });

    act(() => {
      result.current.setInput('Hello');
    });

    await act(async () => {
      await result.current.handleSubmit();
    });

    expect(result.current.messages).toHaveLength(0); // no optimistic entry
    expect(result.current.pendingUserContent).toBe('Hello');
  });

  it('clears pendingUserContent when streaming begins', () => {
    // Purpose: verify the pending bubble disappears once delivery is confirmed
    // (i.e., server has begun responding)
    // ... (requires simulating text_delta event via mock transport)
    expect(result.current.pendingUserContent).toBeNull();
  });

  it('clears pendingUserContent on error', async () => {
    // Purpose: pending bubble must not linger if delivery fails
    // ... (simulate transport rejection)
    expect(result.current.pendingUserContent).toBeNull();
  });
});
```

**File:** `apps/client/src/layers/features/chat/ui/__tests__/MessageList.test.tsx` (extend)

```ts
describe('MessageList — pending bubble', () => {
  it('renders pending bubble when pendingUserContent is set', () => {
    // Purpose: confirm the UI renders the pending state visually
    render(
      <MessageList
        messages={[]}
        sessionId="test-session"
        pendingUserContent="Hello, world"
      />
    );
    expect(screen.getByText('Hello, world')).toBeInTheDocument();
  });

  it('does not render pending bubble when pendingUserContent is null', () => {
    render(
      <MessageList
        messages={[{ id: '1', role: 'user', content: 'Hi', parts: [], timestamp: '' }]}
        sessionId="test-session"
        pendingUserContent={null}
      />
    );
    // No duplicate — confirmed message and no pending bubble for same content
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });
});
```

---

## Performance Considerations

- **Bug 1:** Stable keys eliminate ~300 React reconciliation mismatches per streaming response, reducing unnecessary DOM diffing during high-frequency `setMessages` calls. The `_partId` string allocation (once per text part, not per delta) is negligible.
- **Bug 2:** Two wasted API round-trips eliminated on every page render where `sessionId` is null. Reduces server error log noise and eliminates any retry behavior.
- **Bug 3:** Removes one `setMessages` call per submission. Adds one `useState` and one `setPendingUserContent` — identical overhead.

---

## Security Considerations

No security implications. All changes are client-side UI state management. No new network requests, no new data surfaces, no authentication changes.

---

## Documentation

No user-facing documentation changes needed. These are internal reliability fixes with no new user-visible features.

If the test results document (`test-results/chat-self-test/20260311-175156.md`) is referenced in any contributing guide, update it to note these bugs are resolved.

---

## Implementation Phases

### Phase 1: Bug 2 — Session ID Guard (Lowest Risk, No UX Impact)

**Files:**

- `apps/client/src/layers/features/chat/model/use-task-state.ts` — change signature, add `enabled`
- `apps/client/src/layers/entities/session/model/use-session-status.ts` — change signature, add `enabled`
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx:37,114` — remove `?? ''`

**Verification:** After change, open DevTools Network tab on a new session. Zero requests to `/api/sessions//task-state` or `/api/sessions//status`.

---

### Phase 2: Bug 1 — Stable React Keys (Low Risk, No UX Impact)

**Files:**

- `apps/client/src/layers/features/chat/model/stream-event-handler.ts:139` — add `_partId` to new text parts
- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx:121` — use `_partId` as key

**Verification:** After change, open DevTools Console during a streaming response with tool calls. Zero "Encountered two children with the same key" warnings.

---

### Phase 3: Bug 3 — Pending User Content Architecture (Moderate Risk, Visible UX Change)

**Files:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — remove optimistic `setMessages`, add `pendingUserContent` state, expose in return
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — clear `pendingUserContent` on first `text_delta`
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — destructure `pendingUserContent`, thread to `MessageList`, update empty-state guard
- `apps/client/src/layers/features/chat/ui/MessageList.tsx` — add `pendingUserContent` prop, render pending bubble

**Verification:**

1. Submit a message. Pending bubble appears immediately.
2. First streaming token arrives. Pending bubble clears; JSONL-sourced user bubble appears.
3. Reload page. User bubble is present (sourced from JSONL).
4. During multi-tool streaming, exactly one user bubble at all times.

---

## Open Questions

None. All decisions resolved in ideation phase.

---

## Related ADRs

- **ADR-0003** (JSONL as source of truth) — Bug 3 fix restores full compliance: the canonical `messages` array now contains only JSONL-sourced entries
- **ADR-0043** (agent storage file-first write-through) — not affected

---

## References

- `test-results/chat-self-test/20260311-175156.md` — automated self-test that discovered all three bugs
- `research/20260311_fix_chat_ui_reliability_bugs.md` — full research report with approach comparisons
- `specs/fix-chat-ui-reliability-bugs/01-ideation.md` — ideation document
- [React Lists and Keys](https://legacy.reactjs.org/docs/lists-and-keys.html) — key stability requirements
- [TanStack Query v5 — `enabled` option](https://tanstack.com/query/v5/docs/framework/react/guides/disabling-queries) — standard guard pattern
- [React 19 — `useOptimistic` known issues #31967](https://github.com/facebook/react/issues/31967) — why `useOptimistic` was ruled out
