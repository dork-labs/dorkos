---
slug: fix-chat-streaming-and-model-selector-bugs
number: 113
created: 2026-03-10
status: ideation
---

# Fix Chat Streaming & Model Selector Bugs

**Slug:** fix-chat-streaming-and-model-selector-bugs
**Author:** Claude Code
**Date:** 2026-03-10
**Branch:** preflight/fix-chat-streaming-and-model-selector-bugs

---

## 1) Intent & Assumptions

- **Task brief:** Fix two chat UI bugs found during self-test (`test-results/chat-self-test/20260310-124718.md`): (1) P0 — user messages dropped during live Relay streaming due to a race condition in history seeding logic, (2) P1 — model selector dropdown doesn't visually update the status bar due to premature optimistic state clearing.
- **Assumptions:**
  - Relay transport is enabled and is the primary affected path for Bug 1
  - The create-on-first-message pattern (sessionId null -> UUID) triggers the race condition
  - The `historySeededRef` race was not caught earlier because it requires Relay + new session creation timing
  - The model selector bug affects both desktop (Radix RadioGroup) and mobile (custom MobileRadioItem) paths
- **Out of scope:**
  - Polling optimization (pulse/runs, git/status frequency)
  - Tool call card rendering (empty tool_use messages after reload)
  - Permission mode selector (may have similar issues but not confirmed)

## 2) Pre-reading Log

- `contributing/data-fetching.md`: TanStack Query patterns, Transport abstraction, SSE streaming via `sendMessage`/`sendMessageRelay`, session sync via persistent SSE
- `contributing/state-management.md`: Zustand for UI state, TanStack Query for server state, optimistic updates pattern with revert on failure
- `decisions/0104-client-side-message-queue-with-auto-flush.md`: Client-side FIFO queue collects messages during streaming, auto-flushes on idle with timing annotations; ephemeral queue (no persistence). Queue works correctly — bug is upstream in history seeding
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` (544 lines): Core chat hook. History reset effect at 195-203 resets `historySeededRef` unconditionally on sessionId change. Seed effect at 205-225 replaces entire messages array without streaming guard
- `apps/client/src/layers/features/chat/model/use-message-queue.ts` (152 lines): FIFO queue with auto-flush on streaming->idle transition. Works correctly
- `apps/client/src/layers/entities/session/model/use-session-status.ts` (103 lines): Priority chain at line 59: `localModel ?? streamingStatus?.model ?? session?.model ?? DEFAULT_MODEL`. updateSession at 77-100 clears optimistic state after PATCH
- `apps/client/src/layers/features/status/ui/ModelItem.tsx` (54 lines): RadioGroup value at line 38 receives `model`. RadioItem value at line 40 is `m.value` from ModelOption
- `apps/client/src/layers/features/status/ui/StatusLine.tsx` (184 lines): Passes `status.model` and `status.updateSession` to ModelItem
- `apps/client/src/layers/shared/ui/responsive-dropdown-menu.tsx` (267 lines): Wraps Radix DropdownMenuRadioGroup (desktop) and custom MobileRadioItem (mobile)
- `apps/client/src/layers/entities/session/model/use-models.ts` (15 lines): Fetches ModelOption[] via TanStack Query, staleTime 30 min

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Core chat hook managing message history, streaming, relay integration, optimistic messages. **Bug 1 location: lines 195-225**
- `apps/client/src/layers/entities/session/model/use-session-status.ts` — Session status with optimistic localModel state. **Bug 2 location: lines 59, 77-100**
- `apps/client/src/layers/features/status/ui/ModelItem.tsx` — Model selector dropdown. RadioGroup value/item matching at lines 38-40
- `apps/client/src/layers/features/status/ui/StatusLine.tsx` — Status bar composition, lines 88-92
- `apps/client/src/layers/features/chat/model/use-message-queue.ts` — Message queue (auto-flush). Works correctly, not modified
- `apps/client/src/layers/shared/ui/responsive-dropdown-menu.tsx` — Responsive menu wrapper. Not modified

**Shared Dependencies:**

- TanStack Query (`useQuery`, `useQueryClient`) for server state
- `useTransport` for API calls (HttpTransport/DirectTransport)
- `useAppStore` for selectedCwd
- React hooks (useRef, useEffect, useState, useCallback)

**Data Flow:**

Bug 1: User submits message -> `executeSubmission` -> optimistic message added to state -> sessionId changes (create-on-first-message) -> history reset effect fires -> `historySeededRef = false` -> historyQuery refetches -> seed effect replaces messages array -> optimistic message lost

Bug 2: User clicks model -> `onChangeModel` -> `updateSession({ model })` -> `setLocalModel(value)` (optimistic) -> PATCH to server -> `setLocalModel(null)` (clear) -> priority chain falls back to stale `session?.model` -> RadioGroup value mismatches items

**Feature Flags/Config:**

- `useRelayEnabled` — determines if Relay transport is used (triggers create-on-first-message pattern)
- `showStatusBarModel` from useAppStore — controls model item visibility

**Potential Blast Radius:**

- Bug 1: Only `use-chat-session.ts` modified. ChatPanel inherits fix automatically
- Bug 2: `use-session-status.ts` and possibly `ModelItem.tsx`. StatusLine inherits fix
- Tests: Regression tests needed for both bugs

## 4) Root Cause Analysis

### Bug 1: User Message Dropped During Live Relay Streaming (P0)

- **Repro steps:**
  1. Enable Relay transport
  2. Open DorkOS, start a new session (no prior messages)
  3. Send 3+ messages in sequence
  4. Observe message 3's user bubble missing during live streaming
  5. Reload page — user message appears correctly from history
- **Observed:** Message 3's user bubble not rendered during live streaming (DOM shows 9 elements, missing 1 user)
- **Expected:** All user messages visible immediately after submission
- **Evidence:**
  - JSONL contains all 5 user messages (verified in self-test)
  - DOM `data-role` query during streaming returned 4 user messages, not 5
  - After page reload, DOM returned all 5 user messages
  - The 3rd message is the one dropped — this aligns with the create-on-first-message sessionId change
- **Root-cause hypotheses:**
  1. **History seeding race condition during sessionId change** (HIGH confidence): The effect at lines 198-203 resets `historySeededRef.current = false` unconditionally when sessionId changes. The seed effect at line 211 has no `isStreaming` guard and replaces the entire messages array with server history, which doesn't yet include the optimistic user message
  2. Message queue auto-flush timing issue (LOW confidence): The message queue works correctly per ADR-0104
  3. SSE event delivery gap (LOW confidence): SSE streaming was verified working in self-test, no freezes detected
- **Decision:** Hypothesis 1 — the `historySeededRef` reset without streaming guard is the root cause. The guard at line 200 (`statusRef.current !== 'streaming'`) only protects `setMessages([])` but NOT the `historySeededRef` reset at line 199 or the seed path at line 213

### Bug 2: Model Selector Dropdown Doesn't Update (P1)

- **Repro steps:**
  1. Open DorkOS with an active session
  2. Click the model selector in the status bar
  3. Select a different model (e.g., Haiku)
  4. Observe: dropdown closes, status bar still shows previous model
  5. Observe: `aria-checked="false"` on ALL radio items
- **Observed:** Status bar shows "Opus" after selecting "Haiku". All radio items unchecked
- **Expected:** Status bar immediately reflects "Haiku", selected radio item checked
- **Evidence:**
  - Server-side `session.model` was updated to `claude-haiku-4-5-20251001` (verified via API)
  - `aria-checked="false"` on all items in dropdown (verified via JavaScript inspection)
  - The model eventually showed correctly after sending the next message
- **Root-cause hypotheses:**
  1. **Optimistic state cleared before TanStack Query cache propagates** (HIGH confidence): `setLocalModel(null)` at line 90-91 fires after PATCH success, but `useQuery` subscribers re-render asynchronously after `setQueryData`. For one render frame, `localModel` is null and `session?.model` is stale, causing the priority chain to resolve to the old model
  2. **RadioGroup value format mismatch** (MEDIUM confidence): The `model` value in the priority chain may not exactly match the `m.value` from the models list
- **Decision:** Hypothesis 1 is primary. The convergence effect pattern will eliminate the render gap

## 5) Research

### Bug 1 Solutions

**1. Streaming guard on seed effect (Recommended)**

- Add `if (isStreaming) return;` to the initial-seed branch in use-chat-session.ts
- Pros: 3-line change, matches existing guard philosophy, defers seeding until streaming completes
- Cons: If `done` event is lost, seed never fires (existing edge case handled by staleness detector)
- Complexity: Very low
- Maintenance: Clean, follows codebase conventions

**2. ID-based merge in seed path**

- Replace `setMessages(history.map(...))` with ID-based merge
- Pros: More robust against future paths that reset historySeededRef
- Cons: Ordering complexity, ID mismatch between client UUID and server-persisted ID
- Complexity: Medium
- Maintenance: More brittle

**3. Don't reset historySeededRef during streaming**

- Skip the reset when `statusRef.current === 'streaming'`
- Pros: Simple
- Cons: Logically insufficient — for create-on-first-message, historySeededRef was already false
- Complexity: Low but incomplete

### Bug 2 Solutions

**1. Convergence effect (Recommended)**

- Remove `setLocalModel(null)` from success path; add useEffect that clears localModel only when `session?.model === localModel`
- Pros: Eliminates render gap, data-driven, self-documenting
- Cons: If server normalizes model ID differently, convergence never fires (need fallback timer or onSettled cleanup)
- Complexity: Low
- Maintenance: Clean

**2. React 19 useOptimistic**

- Replace useState with useOptimistic hook
- Pros: Purpose-built, eliminates bug class permanently
- Cons: Requires wrapping updateSession in startTransition, structural change
- Complexity: Medium
- Maintenance: Lower long-term (idiomatic React 19)

**3. Query invalidation after PATCH**

- Add queryClient.invalidateQueries instead of setQueryData
- Pros: Simpler
- Cons: Network round-trip, still has brief render gap
- Complexity: Low
- Maintenance: Medium

### Sources

- TanStack Query optimistic updates documentation
- Radix UI RadioGroup controlled value patterns
- React 19 useOptimistic reference
- TanStack Query discussions on race conditions (#7932, #8328)

## 6) Decisions

| #   | Decision        | Choice               | Rationale                                                                                                                                                                                                                               |
| --- | --------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | P0 fix approach | Streaming guard only | 3-line change, matches existing guard philosophy in the file. Defers seeding until streaming completes, which is semantically correct since server history is incomplete during streaming. No new state, no ordering complexity.        |
| 2   | P1 fix approach | Convergence effect   | Surgical fix that eliminates the render gap between optimistic clear and query cache propagation. Holds localModel until session.model confirms the same value. No structural changes required, aligns with existing codebase patterns. |
