---
slug: session-state-manager
number: 190
created: 2026-03-28
status: ideation
---

# Session State Manager

**Slug:** session-state-manager
**Author:** Claude Code
**Date:** 2026-03-28
**Branch:** preflight/session-state-manager

---

## 1) Intent & Assumptions

- **Task brief:** Decouple session chat state from React component lifecycle into a session-keyed Zustand store with an independent StreamManager service. This enables multiple concurrent streaming sessions, instant resume on session switch, per-session input draft preservation, background activity indicators, and eliminates cross-session state contamination.

- **Assumptions:**
  - Server-side architecture (session broadcaster, JSONL transcripts, POST+SSE streaming) stays unchanged — this is a client-only refactor
  - Zustand remains the state management library (no new dependencies except optionally TanStack Pacer for timer management)
  - The `useChatSession` hook's public return interface stays identical — ChatPanel and other consumers don't need changes
  - The 5-phase incremental migration allows each phase to ship independently with full test coverage
  - The Obsidian plugin's `DirectTransport` should work with StreamManager without modification (same Transport interface)

- **Out of scope:**
  - Server-side streaming protocol changes
  - Cross-tab state sync (already handled by cross-client sync SSE)
  - Obsidian plugin `DirectTransport` refactoring (verify compatibility only)
  - Full rewrite of `stream-event-handler.ts` event types (mechanical signature change only)
  - TanStack Pacer adoption (can be a follow-up spec)

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` (670 lines): Main hook managing ALL chat state — 15 useState, 28 useRef, 9 useCallback, 5 useMemo, 9 useEffect. Heart of the refactor. 35+ session-scoped state pieces need to move to the store.
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (374 lines): Factory creating SSE event dispatcher. Takes React setState callbacks as deps. Handles 20+ event types. Needs signature change to write to store instead of React state.
- `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` (482 lines): Primary consumer of useChatSession. Destructures 30+ properties. Should NOT need changes — hook return interface stays identical.
- `apps/client/src/layers/shared/model/app-store.ts` (547 lines): Existing Zustand global store. Session-related: `sessionId`, `isStreaming`, `isTextStreaming`, `isWaitingForUser`, `activeForm`. No chat message state here.
- `apps/client/src/layers/shared/lib/transport/http-transport.ts`: `sendMessage()` does POST + reads SSE from response body via fetch. AbortSignal is the lifecycle control. Stream survives component unmount unless explicitly aborted.
- `apps/client/src/layers/shared/model/use-sse-connection.ts` (112 lines): SSE connection resilience wrapper. Destroys on unmount. Shows ref-based handler stabilization pattern.
- `apps/client/src/layers/features/chat/model/use-message-queue.ts` (142 lines): Independent hook for FIFO message queue. Already clears on session change (line 82-85). Can remain independent or optionally integrate into session store.
- `apps/client/src/layers/features/chat/model/chat-types.ts`: Core types — ChatMessage, ToolCallState, TransportErrorInfo, ChatSessionOptions.
- `apps/client/src/layers/entities/discovery/model/discovery-store.ts` (83 lines): Precedent for entity-layer Zustand stores used for cross-feature coordination.
- `apps/client/src/layers/widgets/session/ui/SessionPage.tsx`: Renders `<ChatPanel sessionId={activeSessionId} />` — no `key` prop, so ChatPanel re-renders on switch rather than remounting.
- `apps/client/src/layers/features/session-list/ui/SessionItem.tsx`: Sidebar session items. Currently shows only selected/not-selected styling — no streaming or error indicators.
- `apps/client/src/layers/features/dashboard-sessions/model/use-active-sessions.ts`: "Active sessions" tracked via timestamp heuristic (updated within 2h). No real-time streaming status.
- `packages/shared/src/transport.ts`: Transport interface — `sendMessage()` accepts `onEvent` callback. Session-less design.
- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`: Server-side file watcher + SSE broadcaster. Per-session client tracking. Broadcasts `sync_update` with actual SDK events.
- `decisions/0005-zustand-ui-state-tanstack-query-server-state.md`: ADR establishing Zustand for UI state, TanStack Query for server state. Session store is UI state (client-only, not persisted).
- `decisions/0179-centralized-adapter-stream-manager.md`: ADR for centralized AdapterStreamManager — directly analogous pattern for decoupling stream lifecycle from component.
- `research/20260307_relay_streaming_bugs_tanstack_query.md`: Solution D ("Zustand for streaming state") identified as the correct long-term direction. Prior validation of this exact refactor.
- `research/20260312_fix_chat_stream_remap_bugs.md`: Remap timing analysis. `isRemappingRef` pattern. Key input for `renameSession` store action design.
- `research/20260319_streaming_message_integrity_patterns.md`: Industry patterns (Slack, RTK Query) for dual-source message reconciliation.
- `research/20260327_sse_singleton_strictmode_hmr.md`: Module-level singleton pattern for long-lived services. Validates StreamManager as module-scope singleton.
- `research/20260328_session_state_manager_architecture.md`: Comprehensive architecture research — Zustand Record vs Map, selector patterns, StreamManager class design, 5-phase migration, LRU eviction.
- `research/20260328_session_state_manager_library_evaluation.md`: Evaluated TanStack Store (skip), TanStack DB (skip/watch), TanStack Pacer (use selectively), Jotai (watch), XState (watch), Valtio/Legend State (skip).

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Core hook (670 lines, ~60% reduction target)
  - `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — SSE event dispatcher factory (374 lines)
  - `apps/client/src/layers/features/chat/model/stream-event-types.ts` — StreamEventDeps interface (71 lines)
  - `apps/client/src/layers/features/chat/ui/ChatPanel.tsx` — Primary consumer (482 lines, no changes expected)
  - `apps/client/src/layers/features/session-list/ui/SessionItem.tsx` — Sidebar item (add activity indicators)

- **New files to create:**
  - `apps/client/src/layers/entities/session/model/session-chat-store.ts` — Zustand store keyed by sessionId (~200 lines)
  - `apps/client/src/layers/features/chat/model/stream-manager.ts` — StreamManager singleton (~250 lines)

- **Shared dependencies:**
  - `apps/client/src/layers/shared/model/app-store.ts` — Global UI store (read `selectedCwd`, sync `isStreaming`)
  - `apps/client/src/layers/shared/lib/transport/http-transport.ts` — Transport.sendMessage()
  - `apps/client/src/layers/shared/model/use-sse-connection.ts` — Cross-client sync SSE
  - `packages/shared/src/transport.ts` — Transport interface

- **Data flow (current):**

  ```
  User submits → useChatSession.executeSubmission → transport.sendMessage (POST)
    → SSE events → streamEventHandler → React setState → component re-renders
  ```

- **Data flow (target):**

  ```
  User submits → useChatSession.handleSubmit → streamManager.start(sessionId, ...)
    → transport.sendMessage (POST) → SSE events → streamManager.dispatchEvent
    → sessionChatStore.getState().updateSession(sessionId, ...) → Zustand notifies subscribers
    → component re-renders (only if active session's selector output changed)
  ```

- **Feature flags/config:** None — this is an internal architecture change

- **Potential blast radius:**
  - Direct: 5 files (use-chat-session, stream-event-handler, stream-event-types, SessionItem, session barrel)
  - New: 2 files (session-chat-store, stream-manager)
  - Indirect: ~8 chat model hooks (use-background-tasks, use-task-state, use-chat-status-sync, use-message-queue, use-file-upload, use-input-autocomplete, use-celebrations, use-tool-shortcuts) — most need zero changes since they consume data via props/return values
  - Tests: ~8 test files directly affected, 24 total in chat feature

## 4) Root Cause Analysis

N/A — this is an architectural feature, not a bug fix. (The triggering bug — cross-session state contamination — was fixed earlier in this conversation with a tactical `useEffect` reset.)

## 5) Research

### Approach A: Global Zustand Store + Inline Event Dispatch (Minimal Disruption)

- **Description:** Create `useSessionChatStore` with `Record<string, SessionState>`. Replace `useState` calls in `useChatSession` with store reads/writes. Stream events dispatch inline to store. No separate StreamManager class. AbortController stays in the hook.
- **Pros:**
  - Smallest surface area change
  - Incremental field-by-field migration
  - No new singleton infrastructure
- **Cons:**
  - AbortController still tied to component lifecycle — cannot support concurrent streaming
  - Background activity indicators work (status in store) but stopping a background stream requires the hook to be mounted
  - Leaves the architecture structurally fragile
- **Complexity:** Medium
- **Verdict:** Suitable as an interim Phase 3 state, but not the end goal

### Approach B: Global Zustand Store + Class-Based StreamManager (Recommended)

- **Description:** Full decoupling. `useSessionChatStore` holds all session state keyed by sessionId. `StreamManager` is a module-level singleton that manages active POST streams, holds AbortControllers, calls `transport.sendMessage()`, and dispatches events directly to the store. `useChatSession` becomes a thin coordinator.
- **Pros:**
  - Concurrent streaming: multiple sessions stream simultaneously with independent AbortControllers
  - Instant session switch: store lookup is O(1), no loading flash
  - Background indicators: sidebar reads `sessions[id].status` trivially
  - Cross-session contamination eliminated structurally
  - Remap is atomic: `renameSession(oldId, newId)` — no empty flash, no ref dance
  - Aligns with existing patterns: SSEConnection singleton, AdapterStreamManager (ADR-0179)
  - Testable independently of React
- **Cons:**
  - Largest upfront structural change
  - `stream-event-handler.ts` needs mechanical signature update (every setState → store update)
  - `executeSubmission` (~200 lines) refactored into StreamManager
  - Timer management moves from React refs to service-level Maps
- **Complexity:** High (but mitigated by 5-phase incremental delivery)
- **Verdict:** The correct long-term architecture. Implement via phased migration.

### Approach C: Jotai Atom Family (Maximum Granularity)

- **Description:** Replace Zustand with Jotai for session state. `atomFamily(sessionId)` creates per-session atoms lazily. StreamManager writes via Jotai store API.
- **Pros:**
  - Finest re-render granularity (components subscribe to individual fields)
  - `atomFamily` is designed for exactly this keyed-state pattern
  - Clean eviction: `sessionStateAtom.remove(sessionId)`
- **Cons:**
  - Introduces second state library alongside Zustand — split-brain DX
  - Jotai store API for out-of-React writes is less documented than Zustand's `getState()`
  - atomFamily GC requires manual bookkeeping
  - Mixing paradigms confuses future developers
- **Complexity:** High
- **Verdict:** Architecturally sound but wrong for DorkOS given existing Zustand investment

### Library Evaluation

| Library          | Verdict                     | Rationale                                                                    |
| ---------------- | --------------------------- | ---------------------------------------------------------------------------- |
| TanStack Store   | Skip                        | Functionally identical to Zustand, alpha, no devtools                        |
| TanStack DB      | Skip (watch)                | Overkill — incremental computation for a handful of objects. Revisit at v1.0 |
| TanStack Pacer   | Use selectively (follow-up) | Good fit for timer cleanup but not a blocker for this spec                   |
| Jotai atomFamily | Watch                       | Natural fit but mixing with Zustand adds DX complexity                       |
| XState v5        | Watch                       | Would clean up implicit state machine but 19kB bundle                        |

### Recommendation

**Approach B — Global Zustand Store + StreamManager**, delivered via 5-phase incremental migration with zero new dependencies.

### Key Technical Decisions from Research

1. **`Record<string, SessionState>` over `Map`** — Map mutations are invisible to Zustand's `Object.is` equality; Record serializes cleanly with immer
2. **Session-scoped selectors with `useCallback`** — prevents cross-session re-renders: `useCallback((state) => state.sessions[sessionId]?.messages ?? [], [sessionId])`
3. **`immer` middleware** — recommended for ergonomic nested message array updates; benchmark at streaming rates during Phase 4
4. **`devtools` middleware in dev only** — serialization cost with 20 sessions at ~20 events/sec is non-trivial in production
5. **LRU eviction** — max 20 retained sessions, never evict `streaming` sessions
6. **`renameSession(oldId, newId)` atomic action** — eliminates the remap empty-flash entirely; called synchronously in done handler before `onSessionIdChange` fires
7. **No `persist` middleware** — message content must not be written to localStorage (security)
8. **`selectedCwd` passed as parameter** to `streamManager.start()`, not imported from `useAppStore` (avoids circular store dependency)

### Five-Phase Migration Path

| Phase | Scope                                                                                           | Risk   | Ships As        |
| ----- | ----------------------------------------------------------------------------------------------- | ------ | --------------- |
| 1     | Create store infrastructure + StreamManager class (zero behavior change)                        | Low    | PR with Phase 2 |
| 2     | Migrate AbortController into StreamManager; `handleSubmit` delegates to `streamManager.start()` | Low    | PR with Phase 1 |
| 3     | Migrate per-session state fields from useState to store (status, error, input, etc.)            | Medium | Standalone PR   |
| 4     | Migrate messages + history reconciliation to store                                              | High   | Standalone PR   |
| 5     | Thin down useChatSession to a selector/coordinator hook                                         | Low    | Standalone PR   |

**Acceptance test (write before Phase 2):** Verify that switching sessions while one is streaming does NOT abort the background stream, and switching back shows all accumulated messages.

## 6) Decisions

| #   | Decision                               | Choice                                                                          | Rationale                                                                                                                                                                             |
| --- | -------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Input draft behavior on session switch | **Preserve per session**                                                        | Like browser tabs preserving form state. Slack/Discord/VS Code behavior. Aligns with DorkOS quality bar — "Steve Jobs would use it as an example of excellence."                      |
| 2   | Background activity indicator scope    | **Full status spectrum** (streaming pulse + error badge + tool-approval-needed) | All three states exist in the store. Marginal effort since we're already reading `status`. These represent moments where the user genuinely needs to know about a background session. |
| 3   | Architecture approach                  | **Approach B: Zustand Store + StreamManager**                                   | All research converges. Solves all four stated problems. Aligns with existing SSEConnection/AdapterStreamManager patterns. Zero new dependencies.                                     |
| 4   | Store data structure                   | **`Record<string, SessionState>`**                                              | Map mutations invisible to Zustand equality. Record works with immer. Research unanimous.                                                                                             |
| 5   | FSD placement of session store         | **Entity layer** (`entities/session/model/session-chat-store.ts`)               | Matches `discovery-store.ts` precedent. Entities can be imported by features. Session state is a business domain object, not a feature implementation detail.                         |
| 6   | StreamManager placement                | **Feature layer** (`features/chat/model/stream-manager.ts`)                     | Internal to chat feature. Matches AdapterStreamManager pattern (ADR-0179). Close to stream-event-handler for testing.                                                                 |
| 7   | New dependencies                       | **None** (TanStack Pacer as optional follow-up)                                 | Zustand already installed. Zero new deps is the cleanest path.                                                                                                                        |
