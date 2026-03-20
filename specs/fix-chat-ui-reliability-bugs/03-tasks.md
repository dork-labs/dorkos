# Task Breakdown: Fix Chat UI Reliability Bugs

Generated: 2026-03-11
Source: specs/fix-chat-ui-reliability-bugs/02-specification.md
Last Decompose: 2026-03-11

## Overview

Fix three confirmed client-side reliability bugs in the DorkOS chat UI, discovered via automated self-testing on 2026-03-11. All changes are confined to `apps/client/src/` — no server changes required.

| #   | Bug                                   | Severity | Tasks              |
| --- | ------------------------------------- | -------- | ------------------ |
| 1   | React duplicate key storm             | High     | 2.1, 2.2, 2.3      |
| 2   | Empty session ID API errors           | High     | 1.1, 1.2, 1.3, 1.4 |
| 3   | Optimistic user message inconsistency | Medium   | 3.1, 3.2, 3.3, 3.4 |

---

## Phase 1: Bug 2 — Session ID Guard (Lowest Risk, No UX Impact)

Phase 1 is tackled first because it is the lowest risk (additive guard, no behavioral change for non-null sessions), has no UX impact, and the `enabled` pattern is already established in `use-chat-session.ts:186`.

### Task 1.1: Add enabled guard to useTaskState and update signature to accept null

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2

**Root Cause**: `useTaskState` signature is `(sessionId: string)`. `ChatPanel.tsx` passes `sessionId ?? ''` to convert null to `''`. The `useQuery` inside has no `enabled` guard, so it fires `GET /api/sessions//task-state → 400` on every render where `sessionId` is null.

**Technical Requirements**:

- Change function signature: `export function useTaskState(sessionId: string | null): TaskState`
- Add `enabled: !!sessionId` to the `useQuery` call in `use-task-state.ts`
- Use `sessionId!` non-null assertion in `queryFn` (safe because `enabled` prevents execution when null)
- Update TSDoc to document the `string | null` parameter

**Files**:

- `apps/client/src/layers/features/chat/model/use-task-state.ts`

**Implementation Steps**:

1. Change line 40: `export function useTaskState(sessionId: string): TaskState {` → `export function useTaskState(sessionId: string | null): TaskState {`
2. In the `useQuery` block (lines 48-53), add `enabled: !!sessionId` and change `queryFn` to use `sessionId!`
3. Update TSDoc comment on the exported function

**Acceptance Criteria**:

- [ ] Signature accepts `string | null`
- [ ] `enabled: !!sessionId` present in `useQuery`
- [ ] `sessionId!` non-null assertion in `queryFn`
- [ ] TypeScript compiles without errors

---

### Task 1.2: Add enabled guard to useSessionStatus and update signature to accept null

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1

**Root Cause**: `useSessionStatus` first parameter is `string`. `ChatPanel.tsx` passes `sessionId ?? ''`. The `useQuery` inside has no `enabled` guard, so it fires `GET /api/sessions//status → 404` on every render where `sessionId` is null.

**Technical Requirements**:

- Change first parameter: `sessionId: string | null`
- Add `enabled: !!sessionId` to the `useQuery` call
- Add `if (!sessionId) return;` guard at the top of `updateSession` callback
- Use `sessionId!` non-null assertion in `queryFn`

**Files**:

- `apps/client/src/layers/entities/session/model/use-session-status.ts`

**Implementation Steps**:

1. Change line 40: `export function useSessionStatus(sessionId: string, ...)` → `export function useSessionStatus(sessionId: string | null, ...)`
2. In the `useQuery` block (lines 52-56), add `enabled: !!sessionId` and use `sessionId!` in `queryFn`
3. In `updateSession` callback (line 78), add `if (!sessionId) return;` as first statement
4. Update TSDoc

**Acceptance Criteria**:

- [ ] First parameter accepts `string | null`
- [ ] `enabled: !!sessionId` present in `useQuery`
- [ ] `updateSession` is a no-op when `sessionId` is null
- [ ] TypeScript compiles without errors

---

### Task 1.3: Remove ?? '' coercions at useTaskState and useSessionStatus call sites in ChatPanel

**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 1.4

**Technical Requirements**:

- Remove `?? ''` coercions that converted null to empty string, which prevented the enabled guards from firing
- Both hooks now accept `string | null` directly

**Files**:

- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`

**Implementation Steps**:

1. Line 37: `useTaskState(sessionId ?? '')` → `useTaskState(sessionId)`
2. Line 114: `useSessionStatus(sessionId ?? '', ...)` → `useSessionStatus(sessionId, ...)`

**Acceptance Criteria**:

- [ ] No `?? ''` coercions for sessionId in ChatPanel
- [ ] TypeScript compiles without errors

---

### Task 1.4: Write tests for useTaskState null guard and useSessionStatus null guard

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: Task 1.3

**Files to Create**:

- `apps/client/src/layers/features/chat/model/__tests__/use-task-state.test.ts`
- `apps/client/src/layers/entities/session/model/__tests__/use-session-status-guard.test.ts`

**Test Cases**:

`use-task-state.test.ts`:

1. `does not call transport.getTasks when sessionId is null` — verifies the enabled guard
2. `calls transport.getTasks when sessionId is provided` — verifies guard doesn't over-suppress
3. `returns empty tasks when sessionId is null` — verifies stable empty state

`use-session-status-guard.test.ts`:

1. `does not call transport.getSession when sessionId is null` — verifies the enabled guard
2. `returns default permissionMode when sessionId is null` — verifies stable defaults
3. `updateSession is a no-op when sessionId is null` — verifies guard in callback

**Acceptance Criteria**:

- [ ] Both test files exist with 3+ test cases each
- [ ] `transport.getTasks` / `transport.getSession` not called when `sessionId` is null
- [ ] `transport.getTasks` / `transport.getSession` called correctly for non-null sessions
- [ ] All tests pass

---

## Phase 2: Bug 1 — Stable React Keys (Low Risk, No UX Impact)

Phase 2 addresses the React key storm. The fix is purely additive (a `_partId` field on streaming text parts) and does not change any wire protocol schemas.

### Task 2.1: Assign stable \_partId to new text parts in stream-event-handler

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 2.2 (no — 2.2 depends on 2.1)

**Root Cause**: `stream-event-handler.ts:139` creates new text parts without a stable identifier: `currentPartsRef.current = [...parts, { type: 'text', text }]`. When the `parts` array changes shape during streaming, index-based React keys collide, generating ~300 warnings per streaming response.

**Technical Requirements**:

- Define a local `StreamingTextPart` type in `stream-event-handler.ts` with an optional `_partId: string` field
- In the `text_delta` else branch (line 139), assign `_partId: \`text-part-${parts.length}\`` at part creation
- The `if (lastPart.type === 'text')` branch (lines 132-137) is unchanged — `{ ...lastPart, text: ... }` preserves `_partId` automatically
- `TextPartSchema` in `packages/shared/src/schemas.ts` must NOT be modified (wire protocol is unchanged)

**Files**:

- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`

**Implementation Steps**:

1. After imports, define: `type StreamingTextPart = { type: 'text'; text: string; _partId: string };`
2. In the `else` branch of `text_delta` case (line 139), replace: `currentPartsRef.current = [...parts, { type: 'text', text }];` with:
   ```ts
   const partId = `text-part-${parts.length}`;
   const newPart: StreamingTextPart = { type: 'text', text, _partId: partId };
   currentPartsRef.current = [...parts, newPart as MessagePart];
   ```
3. The `if (lastPart.type === 'text')` branch preserves `_partId` via spread — no changes needed there

**Acceptance Criteria**:

- [ ] `_partId` assigned to new text parts in the `else` branch of `text_delta`
- [ ] `_partId` is NOT assigned in the existing-part update branch (spread handles it)
- [ ] `TextPartSchema` in `packages/shared` is NOT modified
- [ ] TypeScript compiles without errors

---

### Task 2.2: Use \_partId as React key for text parts in AssistantMessageContent

**Size**: Small
**Priority**: High
**Dependencies**: Task 2.1

**Root Cause (Component Side)**: `AssistantMessageContent.tsx:121` uses `key={\`text-${i}\`}`. When the `parts` array shape changes mid-stream, these index-based keys collide.

**Technical Requirements**:

- Change line 121 from `key={\`text-${i}\`}`to use`\_partId` when available
- Fall back to `\`text-${i}\``for history-loaded parts (which have no`\_partId` and are static)
- Use a type cast `(part as { _partId?: string })._partId` — do NOT widen `TextPartSchema`

**Files**:

- `apps/client/src/layers/features/chat/ui/message/AssistantMessageContent.tsx`

**Implementation Steps**:

1. Change line 121:
   ```tsx
   // Before:
   <div key={`text-${i}`} className="msg-assistant">
   // After:
   <div key={(part as { _partId?: string })._partId ?? `text-${i}`} className="msg-assistant">
   ```

**Acceptance Criteria**:

- [ ] Line 121 uses `_partId` with index fallback
- [ ] No other changes to the component (tool call, approval, question branches unchanged)
- [ ] TypeScript compiles without errors

---

### Task 2.3: Write tests for stable \_partId assignment and React key stability

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.1, Task 2.2

**Files to Create**:

- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-part-id.test.ts` (or extend existing)
- `apps/client/src/layers/features/chat/ui/message/__tests__/AssistantMessageContent.test.tsx`

**Test Cases**:

`stream-event-handler-part-id.test.ts`:

1. `assigns _partId to new text part on first text_delta` — `_partId: 'text-part-0'`
2. `preserves _partId when subsequent text_delta appends to same part` — spread preserves it
3. `assigns a new _partId to a second text part after a tool_call` — `_partId: 'text-part-2'`

`AssistantMessageContent.test.tsx`:

1. `renders multi-block parts (text, tool_call, text) without key warnings` — zero `console.error` with "same key"
2. `renders a single text part with _partId without key warnings`
3. `falls back to index key for history parts without _partId (no warnings)` — static history is safe

**Acceptance Criteria**:

- [ ] 3 test cases for `_partId` assignment in stream-event-handler
- [ ] 3 test cases for key stability in `AssistantMessageContent`
- [ ] Multi-block parts (text, tool_call, text) produce zero React key collision warnings
- [ ] All tests pass

---

## Phase 3: Bug 3 — Pending User Content Architecture (Moderate Risk, Visible UX Change)

Phase 3 is the most complex change. It replaces the optimistic user message in `messages` (which could vanish on reload, violating ADR-0003) with an ephemeral `pendingUserContent` string state that provides immediate visual feedback without polluting the JSONL-sourced message array.

### Task 3.1: Remove optimistic setMessages and add pendingUserContent state to useChatSession

**Size**: Large
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Nothing (3.2 and 3.3 depend on this)

**Root Cause (Both Parts)**:

- Part A: `setMessages((prev) => [...prev, userMessage])` at line 379 adds a bubble before Relay confirms delivery. Page reload shows no bubble because JSONL has no entry (Relay may have dropped it).
- Part B: The optimistic `userMessage.id` is `crypto.randomUUID()` which never matches the SDK-assigned JSONL ID, so dedup logic fails, causing duplicate bubbles when `sync_update` fires near streaming `done`.

**Technical Requirements**:

- Add `const [pendingUserContent, setPendingUserContent] = useState<string | null>(null);`
- Remove `setMessages((prev) => [...prev, userMessage])` from `executeSubmission`
- Remove the secondary `setMessages` that updated optimistic message content after `transformContent`
- Replace optimistic `setMessages` with `setPendingUserContent(content)`
- Clear `pendingUserContent` when streaming begins (first `text_delta` via `StreamEventDeps`) or completes (`done`)
- Clear `pendingUserContent` in the `catch` block
- Add `pendingUserContent` to the hook's return value
- If using `setPendingUserContent` in `stream-event-handler.ts`, add to `StreamEventDeps` interface

**Files**:

- `apps/client/src/layers/features/chat/model/use-chat-session.ts`
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (if clearing on `text_delta`)

**Implementation Steps**:

1. Add `pendingUserContent` state declaration after line 92
2. In `executeSubmission`, remove the `userMessage` object declaration and `setMessages((prev) => [...prev, userMessage])`
3. Replace with `setPendingUserContent(content)`
4. Remove the `if (finalContent !== content) { setMessages(...) }` block that updated the optimistic message
5. Add `setPendingUserContent(null)` in the `catch` block (before the `if ((err as Error).name !== 'AbortError')` check)
6. Add `setPendingUserContent` to `StreamEventDeps` and call it in the `text_delta` case of `stream-event-handler.ts`
7. Add `pendingUserContent` to the return object

**Acceptance Criteria**:

- [ ] `useState<string | null>(null)` for `pendingUserContent` declared
- [ ] Optimistic `setMessages` call removed
- [ ] `setPendingUserContent(content)` added in its place
- [ ] Secondary `setMessages` for `finalContent` update removed
- [ ] `setPendingUserContent(null)` called on streaming start, completion, and error
- [ ] `pendingUserContent` in return value
- [ ] TypeScript compiles without errors

---

### Task 3.2: Thread pendingUserContent through ChatPanel to MessageList

**Size**: Small
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: Task 3.3

**Technical Requirements**:

- Destructure `pendingUserContent` from `useChatSession`
- Update empty-state guard from `messages.length === 0` to `messages.length === 0 && !pendingUserContent`
- Pass `pendingUserContent={pendingUserContent}` to `<MessageList>`
- Update scroll-to-bottom button visibility guard to account for `pendingUserContent`

**Files**:

- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx`

**Implementation Steps**:

1. Add `pendingUserContent` to the destructured return of `useChatSession`
2. Change empty-state guard (line 248): `messages.length === 0` → `messages.length === 0 && !pendingUserContent`
3. Add `pendingUserContent={pendingUserContent}` prop to `<MessageList>`
4. Update scroll button guard (line 293): `messages.length > 0` → `(messages.length > 0 || !!pendingUserContent)`

**Acceptance Criteria**:

- [ ] `pendingUserContent` destructured from `useChatSession`
- [ ] Empty-state guard updated
- [ ] Prop passed to `<MessageList>`
- [ ] Scroll button guard updated
- [ ] TypeScript compiles (requires Task 3.3 to update `MessageListProps`)

---

### Task 3.3: Add pendingUserContent prop to MessageList and render pending user bubble

**Size**: Small
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- Add `pendingUserContent?: string | null` to `MessageListProps`
- Destructure the prop in the component body
- Render a pending bubble with `aria-label="Sending…"` and `opacity-60` after the last message
- Place the pending bubble and `InferenceIndicator` in the same absolute container at `virtualizer.getTotalSize()` — no separate height constant needed

**Files**:

- `apps/client/src/layers/features/chat/ui/MessageList.tsx`

**Implementation Steps**:

1. Add `pendingUserContent?: string | null;` to `MessageListProps` interface
2. Destructure `pendingUserContent` in the component parameters
3. In the `position: absolute` container at `virtualizer.getTotalSize()`, wrap the `InferenceIndicator` with a conditional pending bubble:
   ```tsx
   <div style={{ position: 'absolute', top: virtualizer.getTotalSize(), left: 0, width: '100%' }}>
     {pendingUserContent && (
       <div className="flex justify-end px-4 py-1">
         <div className="msg-user opacity-60" aria-label="Sending…">
           {pendingUserContent}
         </div>
       </div>
     )}
     <InferenceIndicator ... />
   </div>
   ```

**Acceptance Criteria**:

- [ ] `pendingUserContent?: string | null` in `MessageListProps`
- [ ] Pending bubble renders with `aria-label="Sending…"` when `pendingUserContent` is non-null
- [ ] No pending bubble when `pendingUserContent` is null/undefined
- [ ] `InferenceIndicator` still renders correctly
- [ ] TypeScript compiles without errors

---

### Task 3.4: Update existing tests and write new tests for pendingUserContent behavior

**Size**: Large
**Priority**: High
**Dependencies**: Task 3.1, Task 3.2, Task 3.3

**Files to Modify/Create**:

- `apps/client/src/layers/features/chat/__tests__/use-chat-session.test.tsx` (MODIFY — update assertions, add new describe block)
- `apps/client/src/layers/features/chat/__tests__/MessageList.test.tsx` (MODIFY — add 3 test cases)

**Existing Tests to Update**:

- `'adds user message on submit and clears input'` — assert `pendingUserContent === 'Hello'`, not user in `messages`
- `'appends new messages after history'` — assert 3 messages (2 history + 1 assistant), check `pendingUserContent`
- `'does not create assistant message immediately on submit'` — assert `messages.length === 0`, `pendingUserContent === 'test'`
- `'creates assistant message on first text_delta'` — assert 1 message (assistant), `pendingUserContent === null`
- `'creates assistant message on first tool_call_start'` — assert 1 message (assistant only)

**New Test Cases to Add**:

`useChatSession — pendingUserContent` describe block:

1. `sets pendingUserContent on submit, does not add to messages`
2. `clears pendingUserContent when streaming begins (first text_delta)`
3. `clears pendingUserContent on transport error`

`MessageList` pending bubble tests:

1. `renders pending user bubble when pendingUserContent is set`
2. `does not render pending bubble when pendingUserContent is null`
3. `does not render pending bubble when pendingUserContent is not provided`

Also update `ChatPanel.test.tsx` mock to include `pendingUserContent: null` in the `useChatSession` mock return value, and update `useTaskState` and `useSessionStatus` mock signatures to accept `string | null`.

**Acceptance Criteria**:

- [ ] All existing tests updated to reflect no optimistic user message in `messages`
- [ ] New `pendingUserContent` describe block with 3 passing tests
- [ ] 3 new `MessageList` pending bubble tests passing
- [ ] `ChatPanel.test.tsx` mock updated
- [ ] All tests pass: `pnpm vitest run apps/client/src/layers/features/chat/`

---

## Phase 4: Verification

### Task 4.1: Run full test suite and verify zero regressions across all three bug fixes

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3, Task 1.4, Task 2.3, Task 3.4

**Commands**:

```bash
pnpm vitest run apps/client/src
pnpm typecheck
```

**Verification Checklist**:

Bug 1 (Stable React Keys):

- [ ] Zero `console.error` calls with "same key" in `AssistantMessageContent` tests
- [ ] `_partId` assigned correctly per `stream-event-handler` tests
- [ ] TypeScript: `_partId` type cast is clean

Bug 2 (Session ID Guard):

- [ ] `useTaskState(null)` → no `transport.getTasks` call
- [ ] `useSessionStatus(null, ...)` → no `transport.getSession` call
- [ ] `ChatPanel.tsx` type-checks with updated hook signatures

Bug 3 (Pending User Content):

- [ ] No optimistic user message in `messages` after `handleSubmit`
- [ ] `pendingUserContent` set on submit, cleared on streaming start/done/error
- [ ] `MessageList` renders pending bubble for non-null `pendingUserContent`
- [ ] Empty-state guard in `ChatPanel` accounts for `pendingUserContent`

No Regressions:

- [ ] `ChatPanel.test.tsx` passes (mocks updated)
- [ ] All other chat feature tests pass
- [ ] No new TypeScript errors

**Acceptance Criteria**:

- [ ] `pnpm vitest run apps/client/src` exits with 0 failures
- [ ] `pnpm typecheck` exits with 0 errors
