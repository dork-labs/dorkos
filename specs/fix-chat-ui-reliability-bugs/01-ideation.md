---
slug: fix-chat-ui-reliability-bugs
number: 121
created: 2026-03-11
status: ideation
---

# Fix Chat UI Reliability Bugs

**Slug:** fix-chat-ui-reliability-bugs
**Author:** Claude Code
**Date:** 2026-03-11
**Branch:** preflight/fix-chat-ui-reliability-bugs

---

## 1) Intent & Assumptions

- **Task brief:** Fix three specific, well-diagnosed bugs in the DorkOS chat UI that were discovered during automated self-testing: (1) a React duplicate key storm firing ~300 console errors per streaming response, (2) 400/404 API errors on every new session before the first message is sent, and (3) optimistic user message bubbles that appear before Relay confirms delivery and vanish on page reload — inconsistent with ADR-0003 (JSONL as source of truth). A related mid-stream race condition causes a transient duplicate user bubble during multi-tool streaming.
- **Assumptions:**
  - All root causes are confirmed in the codebase and in `test-results/chat-self-test/20260311-175156.md`
  - The `TextPartSchema` deliberately has no `id` field; the stable key fix must be client-only
  - The `pendingUserContent` state for Bug 3 will be threaded through ChatPanel → MessageList as UI-layer ephemeral state, not persisted
  - The mid-stream race condition (Part B of Bug 3) is automatically resolved by removing the optimistic message; no separate fix needed
- **Out of scope:**
  - SSE streaming architecture or JSONL persistence internals
  - Relay transport internals (no changes to transport.sendMessageRelay)
  - Any non-chat UI features or unrelated bugs
  - Server-side changes — all fixes are client-only

---

## 2) Pre-reading Log

- `contributing/architecture.md`: Hexagonal Transport pattern; `DirectTransport` vs `HttpTransport`; DI via React Context; data flows through Transport interface
- `contributing/data-fetching.md`: TanStack Query is the canonical server state manager; `enabled` guard is the standard way to suppress queries with missing parameters
- `contributing/state-management.md`: Zustand for UI state, TanStack Query for server state, nuqs for URL state; confirmed `sessionId` comes from nuqs
- `test-results/chat-self-test/20260311-175156.md`: Automated self-test confirming all three bugs — 300 duplicate key errors, empty-session 400/404s, orphaned optimistic bubble, transient duplicate bubble
- `packages/shared/src/schemas.ts:320-350`: `TextPartSchema = z.object({ type: z.literal('text'), text: z.string() })` — no `id` field. Wire protocol must not change.
- `apps/client/src/layers/features/chat/model/chat-types.ts`: `ChatMessage` has `parts: MessagePart[]`; no `_partId` extension currently
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Already has `enabled: sessionId !== null` on `historyQuery` — the correct pattern to replicate in the two missing hooks

---

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                                          | Role                                                                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx` | Renders assistant message content parts (text, tool calls, approvals, questions); Bug 1 site — line 121 uses `key={\`text-${i}\`}`           |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts`          | Processes SSE events and builds the `parts` array; Bug 1 source — `text_delta` branch never assigns an ID to new text parts                  |
| `apps/client/src/layers/features/chat/model/use-task-state.ts`                | TanStack Query hook for session task list; Bug 2 site — missing `enabled: !!sessionId` guard on lines 48-53                                  |
| `apps/client/src/layers/entities/session/model/use-session-status.ts`         | TanStack Query hook for session metadata (model, permission mode); Bug 2 site — missing `enabled: !!sessionId` guard on lines 52-56          |
| `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`                       | Main chat UI container; Bug 2 source — lines 37, 114 coerce `null` to `''` (`sessionId ?? ''`) before passing to the hooks above             |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`              | Core chat logic hook; Bug 3 source — line 379 adds optimistic user message before Relay confirms; line 293-300 has partial sync_update guard |

**Shared Dependencies:**

| Path                                                       | Role                                                                              |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `packages/shared/src/schemas.ts`                           | `TextPartSchema`, `MessagePartSchema`, `ToolCallPartSchema` — wire protocol types |
| `packages/shared/src/types.ts`                             | Re-exports `MessagePart`                                                          |
| `apps/client/src/layers/features/chat/model/chat-types.ts` | `ChatMessage`, `ToolCallState`, `ChatStatus` — client-only message types          |
| `apps/client/src/layers/shared/model/TransportContext.tsx` | `useTransport()` — DI for Transport abstraction                                   |

**Data Flow:**

```
Bug 1:
stream-event-handler.ts (text_delta: no id on new TextPart)
  → setMessages() → AssistantMessageContent.tsx (key={`text-${i}`} → duplicate key warning)

Bug 2:
nuqs → sessionId: string | null
  → ChatPanel.tsx (sessionId ?? '') → useTaskState('') → GET /api/sessions//task-state → 400
  → ChatPanel.tsx (sessionId ?? '') → useSessionStatus('', ...) → GET /api/sessions//status → 404

Bug 3 (Part A):
executeSubmission → setMessages([...prev, userMessage])  ← before Relay confirms
  → transport.sendMessageRelay() → 202 → delivery may fail
  → page reload → historyQuery (JSONL) → no matching entry → bubble gone

Bug 3 (Part B):
executeSubmission → setMessages([...prev, userMessage])  ← optimistic user in messages
  → streaming starts → sync_update fires → historyQuery invalidated + refetched
  → JSONL user message arrives → both appear briefly → transient duplicate
```

**Feature Flags/Config:** None identified.

**Potential Blast Radius:**

- Direct (must change): 5 files — `AssistantMessageContent.tsx`, `stream-event-handler.ts`, `use-task-state.ts`, `use-session-status.ts`, `use-chat-session.ts`
- Indirect (may need updates): `ChatPanel.tsx` (pass `pendingUserContent` down to `MessageList`), `MessageList` component (render pending bubble), possibly `UserMessage.tsx` or equivalent
- Tests: `use-chat-session-relay.test.ts` (relay path assertions); new tests for `AssistantMessageContent`, `use-task-state`, `use-session-status`

---

## 4) Root Cause Analysis

### Bug 1: React Duplicate Key Storm

- **Repro steps:**
  1. Open DorkOS chat with a valid session
  2. Send any message that produces a multi-part streaming response (text → tool call → more text)
  3. Open browser DevTools console
  4. Observe "Warning: Encountered two children with the same key" firing ~300 times

- **Observed vs Expected:** ~300 React key collision warnings per streaming response vs zero warnings

- **Evidence:**
  - `stream-event-handler.ts:139`: `currentPartsRef.current = [...parts, { type: 'text', text }]` — no `id` field on the new object
  - `AssistantMessageContent.tsx:121`: `key={\`text-${i}\`}`— index`i` is unstable when parts array changes
  - `TextPartSchema` (schemas.ts:323-328): `{ type, text }` only — no `id` on the wire
  - Self-test log: "74 baseline errors on page load, ~160 per streaming response"

- **Root-cause hypotheses:**
  - (High confidence) Index-based keys on a dynamically-sized array: when a text part is inserted at position `i`, any previously rendered element at that position gets a key collision on re-render
  - (Contributing) The `parts` array is recreated (spread) on every `text_delta` event, so React sees a fresh array with the same index-based keys each time

- **Decision:** Assign a stable `_partId` string to each new text part at creation time in `stream-event-handler.ts`. Use it as the key in `AssistantMessageContent`. This is a client-only field not present in the shared schema.

---

### Bug 2: Empty Session ID API Errors

- **Repro steps:**
  1. Navigate to DorkOS chat with no session selected (or open a new session tab)
  2. Open browser DevTools Network tab
  3. Observe `GET /api/sessions//task-state` → 400, `GET /api/sessions//status` → 404 firing immediately on page load

- **Observed vs Expected:** 400/404 API errors before any user action vs no network requests until `sessionId` is available

- **Evidence:**
  - `ChatPanel.tsx:37`: `const taskState = useTaskState(sessionId ?? '')` — coerces null
  - `ChatPanel.tsx:114`: `useSessionStatus(sessionId ?? '', sessionStatus, ...)` — coerces null
  - `use-task-state.ts:48-53`: No `enabled` guard — query fires immediately with `''`
  - `use-session-status.ts:52-56`: No `enabled` guard — query fires immediately with `''`
  - Correct pattern at `use-chat-session.ts:186`: `enabled: sessionId !== null`

- **Root-cause hypotheses:**
  - (High confidence) Two hooks lack the `enabled: !!sessionId` guard that already exists on `historyQuery` in the same codebase. The `??` coercion at the call sites passes `''` which is falsy — a proper guard would catch it.

- **Decision:** Change both hook signatures to accept `string | null`. Add `enabled: !!sessionId` to both queries. Remove the `?? ''` coercions in `ChatPanel.tsx`.

---

### Bug 3: Optimistic User Message Consistency

- **Repro steps (Part A):**
  1. Send a message in Relay mode with a degraded Relay connection (or simulate 202 → delivery failure)
  2. Observe user bubble appears immediately in the chat UI
  3. Reload the page
  4. Observe the user bubble is gone (no corresponding JSONL entry)

- **Repro steps (Part B):**
  1. Send a message that triggers a multi-tool streaming response (multiple tool calls)
  2. Watch the message area during streaming
  3. Observe a brief flash where the user bubble appears twice

- **Observed vs Expected:**
  - Part A: User bubble disappears on reload vs consistent visibility matching JSONL
  - Part B: Transient duplicate user bubble during streaming vs single bubble at all times

- **Evidence:**
  - `use-chat-session.ts:371-379`: `setMessages((prev) => [...prev, userMessage])` fires before `transport.sendMessageRelay()` is called
  - `use-chat-session.ts:293-300`: `sync_update` guard only protects `if (statusRef.current === 'streaming')` but misses the window immediately after delivery
  - The optimistic `userMessage.id` (`crypto.randomUUID()`) never matches the SDK-assigned JSONL message ID — deduplication at lines 221-227 cannot reconcile them

- **Root-cause hypotheses:**
  - (High confidence, Part A) Optimistic message is added to local state before Relay confirms delivery. If delivery fails, there is no way to know after page reload because the message was never written to JSONL.
  - (High confidence, Part B) The `sync_update` guard correctly suppresses invalidation during streaming, but the initial optimistic `setMessages` is already in state when the guard runs. After `done`, refetch returns the real user message — two different IDs, both user role, both with same content → transient duplicate.

- **Decision:** Remove the `setMessages(..., userMessage)` call from `executeSubmission`. Add a `pendingUserContent: string | null` state in `useChatSession`. Set it on submit, clear it on first streaming token (or error). Thread `pendingUserContent` through `ChatPanel` → `MessageList` to render a distinct "pending" bubble outside the JSONL-sourced message array. This preserves immediate visual feedback while maintaining JSONL-as-source-of-truth for the canonical message list.

---

## 5) Research

- **Full report:** `research/20260311_fix_chat_ui_reliability_bugs.md`

### Bug 1 — Stable Keys for Streaming Text Parts

1. **Positional `_partId` counter (Recommended):** Assign `_partId: \`text-part-${parts.length}\`` in the `text_delta` else branch of `stream-event-handler.ts`. Use `part._partId ?? \`text-${i}\``as the key in`AssistantMessageContent`. Counter string is cheaper than UUID, assigned exactly once at creation, never changes through the part's lifetime.
2. **`crypto.randomUUID()` per text part:** Same mechanics, UUID instead of counter. No correctness benefit here; trivially more expensive.
3. **Composite key (index + content-length):** One-liner but wrong — key changes on every delta, forcing React to unmount/remount `StreamingText` on every event.

**Recommendation:** Approach 1 — `_partId` counter. Client-only field, not added to `TextPartSchema`.

---

### Bug 2 — Session ID Guard

1. **`string | null` signature + `enabled: !!sessionId` (Recommended):** Change hook signatures; add guard; remove `?? ''` at call sites. Matches existing `use-chat-session.ts` pattern exactly.
2. **`skipToken` pattern (TanStack Query v5):** `queryFn: sessionId ? () => ... : skipToken`. Official v5 pattern, but deviates from codebase's `enabled: boolean` convention.
3. **Keep `''` coercion, add guard inside hook:** One-liner, but `['tasks', '', selectedCwd]` cache entry is an anti-pattern with a semantically wrong sentinel value.

**Recommendation:** Approach 1 — match existing pattern.

---

### Bug 3 — Optimistic Message Consistency

1. **Remove optimistic + add `pendingUserContent` state (Recommended):** Remove `setMessages(..., userMessage)`. Add `pendingUserContent: string | null` state, render as a distinct "pending" bubble. Fixes Part A (delivery failure consistency) and Part B (race condition) simultaneously. Clean architectural boundary: `messages` = JSONL-sourced, `pendingUserContent` = ephemeral UI.
2. **Just remove, no placeholder:** Fixes both parts but creates a visible UX gap (~0.5–2s) between submit and first streaming token.
3. **Keep optimistic + content-hash dedup:** Fixes Part B only. Does not fix Part A. Fragile with `transformContent`. Not consistent with ADR-0003.
4. **React 19 `useOptimistic`:** Purpose-built but conflicts with the streaming model (transition settles on 202, not `done`); has known bugs in React 19 (#31967, #30637).

**Recommendation:** Approach 1 — remove optimistic + add `pendingUserContent` ephemeral state.

---

## 6) Decisions

| #   | Decision                                     | Choice                                                                                                                                                                                                                                  | Rationale                                                                                                                                                                                                                                                |
| --- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Stable key strategy for streaming text parts | Positional `_partId` counter string, assigned once at text part creation in `stream-event-handler.ts`; used as React key in `AssistantMessageContent`                                                                                   | Cheapest stable ID; never changes through a part's lifetime; `_partId` is a client-only convention not added to the wire-protocol `TextPartSchema`; history-loaded parts gracefully fall back to index key                                               |
| 2   | Session ID guard pattern                     | Change hook signatures to `string \| null`; add `enabled: !!sessionId` to both `useTaskState` and `useSessionStatus`; remove `?? ''` coercions in `ChatPanel.tsx`                                                                       | Matches the existing `enabled: sessionId !== null` pattern in `use-chat-session.ts:186`; TypeScript enforces caller updates at compile time; semantically correct (null = "not yet assigned")                                                            |
| 3   | Optimistic user message UX approach          | Remove `setMessages(..., userMessage)` from executeSubmission; add `pendingUserContent: string \| null` state; thread through `ChatPanel` → `MessageList` to render a distinct "pending" bubble outside the JSONL-sourced message array | Eliminates both Part A (delivery-failure consistency) and Part B (mid-stream race) simultaneously; preserves immediate visual feedback; makes the architectural boundary explicit: `messages` = JSONL-sourced, `pendingUserContent` = ephemeral UI state |
