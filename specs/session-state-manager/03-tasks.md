# Task Breakdown: Session State Manager

Generated: 2026-03-28
Source: specs/session-state-manager/02-specification.md
Last Decompose: 2026-03-28

## Overview

Decouple session chat state from React component lifecycle into a session-keyed Zustand store with an independent `StreamManager` singleton service. This enables multiple concurrent streaming sessions, instant session resume on switch, per-session input draft preservation, full-spectrum background activity indicators, and structurally eliminates cross-session state contamination.

The `useChatSession` hook (currently 670 lines, 15 `useState`, 28 `useRef`) will be thinned to ~300 lines. State moves to a Zustand store keyed by session ID. Streaming lifecycle moves to a module-level `StreamManager` singleton.

## Phase 1+2: Foundation + Core Migration (ship as one PR)

Zero user-visible behavior change in Phase 1 (except stopping works correctly across sessions). Phase 2 adds background indicators and input draft preservation.

### Task 1.1: Create session-chat-store with types, actions, and LRU eviction

**Size**: Large
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:

- Create `apps/client/src/layers/entities/session/model/session-chat-store.ts`
- Follow entity-layer Zustand store pattern from `discovery-store.ts`
- Middleware: `immer` for ergonomic nested updates + `devtools` gated on `import.meta.env.DEV`
- No `persist` middleware (messages must not reach localStorage)
- `MAX_RETAINED_SESSIONS = 20`
- `SessionState` interface with 26 fields matching the spec
- `DEFAULT_SESSION_STATE` exported constant
- Actions: `initSession`, `destroySession`, `renameSession`, `updateSession`, `touchSession`, `getSession`
- LRU eviction in `touchSession` skips sessions where `status === 'streaming'`
- `renameSession` does atomic key swap + `sessionAccessOrder` update
- `getSession` returns `DEFAULT_SESSION_STATE` for unknown IDs
- `updateSession` auto-initializes session if not present
- Selector hooks: `useSessionChatState`, `useSessionMessages`, `useSessionStatus` with `useCallback` memoization
- Update entity barrel `entities/session/index.ts`

**Test file**: `apps/client/src/layers/entities/session/model/__tests__/session-chat-store.test.ts` (10 tests)

**Acceptance Criteria**:

- [ ] Store file created at correct path
- [ ] All 6 actions implemented
- [ ] LRU eviction preserves streaming sessions
- [ ] Selector hooks use `useCallback`
- [ ] Barrel file updated
- [ ] All 10 tests pass
- [ ] `pnpm typecheck` passes

---

### Task 1.2: Create StreamManager singleton with start, abort, and event dispatch

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:

- Create `apps/client/src/layers/features/chat/model/stream-manager.ts`
- Module-level singleton `StreamManager` class + exported `streamManager` instance
- `activeStreams: Map<string, AbortController>` keyed by session ID
- `timers: Map<string, SessionTimers>` keyed by session ID
- `start()`: abort existing, create AbortController, init store state, add optimistic user message, call `transport.sendMessage`, handle errors (SESSION_LOCKED, retryable transient, mid-stream interruption)
- `abort(sessionId)`: abort controller, delete from map, clear timers
- `abortAll()`: iterate and abort all
- `isStreaming(sessionId)`: boolean check
- `getActiveSessionIds()`: array of active IDs
- Error handling mirrors current `executeSubmission` logic
- `snapshotUiState` helper reads from `useAppStore`

**Test file**: `apps/client/src/layers/features/chat/model/__tests__/stream-manager.test.ts` (8 tests)

**Acceptance Criteria**:

- [ ] StreamManager class and singleton exported
- [ ] `start()` manages full lifecycle
- [ ] `abort()` is safe for unknown sessions (no-op)
- [ ] Timer cleanup on abort
- [ ] Error handling matches current behavior
- [ ] All 8 tests pass
- [ ] `pnpm typecheck` passes

---

### Task 1.3: Wire useChatSession to delegate submit/stop to StreamManager

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

**Technical Requirements**:

- Remove `abortRef` from `useChatSession`
- `handleSubmit` -> `executeSubmission` -> `streamManager.start()` delegation
- `stop` delegates to `streamManager.abort(sessionId)`
- Add `useEffect` to initialize session in store on `sessionId` change
- Phase 1 bridge: hook still owns `useState` for all fields, StreamManager additionally writes to store (dual-write for backward compat)
- Switching sessions does NOT call `streamManager.abort()`

**Key acceptance test**: Multi-session streaming -- switching sessions while streaming does NOT abort background stream.

**Test file**: `apps/client/src/layers/features/chat/model/__tests__/multi-session-streaming.test.ts`

**Acceptance Criteria**:

- [ ] `abortRef` removed
- [ ] Submit delegates to StreamManager
- [ ] Stop delegates to StreamManager
- [ ] Session switch does not abort background streams
- [ ] All existing tests still pass
- [ ] Acceptance test passes
- [ ] `pnpm typecheck` passes

---

### Task 2.1: Migrate status, error, and sessionBusy from useState to store reads

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.2

**Technical Requirements**:

- Remove `useState` for `status`, `error`, `sessionBusy`
- Replace with store selectors
- Update `stream-event-handler.ts` to write status/error to store via `updateSession`
- Remove `statusRef` (store read replaces stale-closure workaround)
- Reduce tactical session-switch reset effect (no longer clears these fields)
- Remove `setStatus`, `setError` from `StreamEventDeps`
- Return interface unchanged

**Acceptance Criteria**:

- [ ] Three `useState` removed
- [ ] `statusRef` removed
- [ ] Store selectors used
- [ ] Event handler writes to store
- [ ] Return interface unchanged
- [ ] Tests updated and passing

---

### Task 2.2: Add SessionActivityIndicator to SessionItem for background status

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.1

**Technical Requirements**:

- `SessionActivityIndicator` component in `SessionItem.tsx`
- Reads `status`, `hasUnseenActivity`, and pending interactive tool calls from store
- Green pulse: streaming; Red: error; Amber pulse: waiting for approval; Blue: unseen activity
- Only shown for non-active sessions
- `hasUnseenActivity` cleared when session becomes active (effect in `useChatSession`)
- `hasUnseenActivity` set when background session stream completes (in StreamManager)
- Selectors use `useCallback` for memoization

**Test file**: `apps/client/src/layers/features/session-list/ui/__tests__/SessionItem.test.tsx`

**Acceptance Criteria**:

- [ ] Indicator renders with correct colors and animations
- [ ] Hidden for active session
- [ ] Unseen activity lifecycle works
- [ ] Tests pass

---

### Task 2.3: Migrate input draft and remaining transient state fields to store

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: None

**Technical Requirements**:

- Migrate all remaining `useState` fields (input, sessionStatus, presenceInfo, presencePulse, streamStartTime, estimatedTokens, isTextStreaming, isRateLimited, rateLimitRetryAfter, systemStatus, promptSuggestions)
- Remove corresponding `useRef` declarations (12+ refs)
- Update `stream-event-handler.ts` for all migrated fields
- Simplify `StreamEventDeps` interface significantly
- Remove tactical session-switch reset `useEffect` entirely
- Remove presence-reset `useEffect`
- Timers move to `StreamManager.timers` map
- Input drafts preserved per session across switches

**Acceptance Criteria**:

- [ ] All 15 `useState` removed (messages deferred to Phase 3)
- [ ] Corresponding refs removed
- [ ] All fields read from store
- [ ] Event handler writes to store
- [ ] Session-switch reset removed
- [ ] Input drafts preserved
- [ ] Return interface unchanged
- [ ] Tests passing

---

## Phase 3: Messages Migration + Remap (standalone PR)

Highest risk. User-visible: instant session switch (no loading flash), remap has no empty flash.

### Task 3.1: Migrate messages state and history reconciliation to store

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.3
**Can run parallel with**: None

**Technical Requirements**:

- Remove `messages` `useState` and `messagesRef`
- Replace with store selector
- Update `stream-event-helpers.ts`: `ensureAssistantMessage` and `updateAssistantMessage` write to store
- Replace `StreamEventDeps` with `StreamDispatchContext` interface
- Update all `setMessages` calls in `stream-event-handler.ts` to store writes
- History seeding uses `session.historySeeded` from store (not ref)
- `reconcileTaggedMessages` writes to store
- `markToolCallResponded` reads/writes store
- Remove `currentPartsRef`, `orphanHooksRef`, `assistantIdRef`, `assistantCreatedRef`, `pendingUserIdRef`, `historySeededRef`

**Acceptance Criteria**:

- [ ] `messages` useState removed
- [ ] 7 refs removed
- [ ] All message writes go through store
- [ ] History seeding writes to store
- [ ] `StreamDispatchContext` replaces `StreamEventDeps`
- [ ] Return interface unchanged
- [ ] All tests pass

---

### Task 3.2: Implement renameSession for create-on-first-message remap

**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: None

**Technical Requirements**:

- Done event handler uses `store.renameSession(oldId, newId)` before `onSessionIdChange` fires
- AbortController and timer entries moved to new session ID key
- Remove `isRemappingRef` from hook and `StreamEventDeps`
- Use `isRemapping` field in store instead
- Session change effect reads `isRemapping` from store
- Zero flash: data exists at new key before React re-renders

**Acceptance Criteria**:

- [ ] `renameSession` called before URL update
- [ ] Controller and timers moved to new key
- [ ] `isRemappingRef` removed
- [ ] No empty flash during remap
- [ ] Tests verify atomic state preservation

---

## Phase 4: Cleanup (standalone PR)

Zero behavior change. Code health only.

### Task 4.1: Remove dead useState/useRef declarations and thin useChatSession to ~300 lines

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 3.2
**Can run parallel with**: None

**Technical Requirements**:

- Audit all 15 `useState` removed
- Audit all streaming-related `useRef` removed (~20 of 28)
- Remove `resetStreamingState` callback
- Remove timer cleanup effect
- Remove ref-sync effects
- Clean up unused imports
- Verify ~300 line target
- Verify `useChatStatusSync` still bridges correctly
- Update barrel exports (`features/chat/index.ts`, `entities/session/index.ts`)
- `streamManager` is NOT exported from chat feature barrel
- Run full test suite (3370+ tests)
- Run `pnpm typecheck` and `pnpm lint`

**Acceptance Criteria**:

- [ ] `useChatSession` ~300 lines
- [ ] All dead code removed
- [ ] No unused imports
- [ ] `useChatStatusSync` works unchanged
- [ ] Barrel files correct
- [ ] All 3370+ tests pass
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes

---

## Summary

| Phase                                  | Tasks                        | PR Strategy   |
| -------------------------------------- | ---------------------------- | ------------- |
| Phase 1+2: Foundation + Core Migration | 1.1, 1.2, 1.3, 2.1, 2.2, 2.3 | Single PR     |
| Phase 3: Messages + Remap              | 3.1, 3.2                     | Standalone PR |
| Phase 4: Cleanup                       | 4.1                          | Standalone PR |

## Critical Path

1.1 -> 1.2 -> 1.3 -> 2.1 -> 2.3 -> 3.1 -> 3.2 -> 4.1

## Parallel Opportunities

- Tasks 2.1 and 2.2 can run in parallel (both depend on 1.3, independent of each other)

## Risk Assessment

- **Phase 3 (Messages)** is highest risk due to message mutation frequency during streaming (~20 events/sec)
- **immer performance** should be monitored; if benchmarking reveals issues, replace with manual spread for message updates only
- **Remap (3.2)** has a tight timing requirement: `renameSession` must complete before `onSessionIdChange` triggers React re-render
