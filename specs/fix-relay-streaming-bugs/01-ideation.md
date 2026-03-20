---
slug: fix-relay-streaming-bugs
number: 100
created: 2026-03-07
status: ideation
---

# Fix Two Relay-Mode Streaming Bugs

**Slug:** fix-relay-streaming-bugs
**Author:** Claude Code
**Date:** 2026-03-07
**Branch:** preflight/fix-relay-streaming-bugs

---

## 1) Intent & Assumptions

- **Task brief:** Two Relay-mode-only bugs degrade the chat UI during live streaming: (1) assistant text following a tool call renders twice on screen but disappears on history reload, and (2) GET /messages returns 503 repeatedly throughout a session because the client polls every 3 seconds even though SSE already handles history updates in Relay mode.
- **Assumptions:**
  - `DORKOS_RELAY_ENABLED` is true in the test environment where bugs reproduce
  - `statusRef` (line 134, `use-chat-session.ts`) accurately reflects streaming state and can be used as a guard
  - `HistoryMessage.id` is a stable UUID present on all history messages (needed for deduplication)
  - The 503s come from Express proxy/timeout after an unhandled async rejection — not a relay-specific business error
- **Out of scope:** Non-Relay (legacy SSE) streaming path; history reload path (already correct); structural refactor of streaming state into Zustand

---

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Core hook with dual-mode streaming (legacy SSE + Relay), message polling, sync_update SSE handler, and staleness detector
- `apps/server/src/routes/sessions.ts`: Express routes for POST /messages (Relay dispatch) and GET /messages (history); no try/catch around async operations
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts`: Pure event handler factory processing SSE events into React state; not involved in the bugs
- `apps/client/src/layers/shared/lib/constants.ts`: `QUERY_TIMING.MESSAGE_STALE_TIME_MS = 0`, `QUERY_TIMING.ACTIVE_TAB_REFETCH_MS = 3000` — polling is aggressive
- `apps/client/src/layers/features/chat/model/__tests__/use-chat-session-relay.test.ts`: Relay mode tests — confirms staleness detector is expected fallback for lost `done` events, not normal flow
- `research/20260307_relay_streaming_bugs_tanstack_query.md`: Deep-dive on TanStack Query v5 patterns, SSE+polling anti-patterns, and Express async error handling

---

## 3) Codebase Map

**Primary Components/Modules:**

| File                                                                             | Role                                                                                                         |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts` (436 lines)     | Main chat hook — streaming state, polling config, Relay EventSource, sync_update handler, staleness detector |
| `apps/server/src/routes/sessions.ts` (379 lines)                                 | Express routes — POST /messages dispatches via Relay; GET /messages reads transcript history                 |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (289 lines) | SSE event processor — not a bug site, but processes `relay_message` and text_delta events                    |

**Shared Dependencies:**

- `useRelayEnabled()` — reads server config for relay feature flag; `relayEnabled` is already in scope at line 85 of `use-chat-session.ts`
- `statusRef` (line 134) — ref tracking `'idle' | 'streaming' | 'error'`; already used throughout the hook
- `QUERY_TIMING.MESSAGE_STALE_TIME_MS = 0` / `ACTIVE_TAB_REFETCH_MS = 3000` — polling constants
- `queryClient.invalidateQueries()` — TanStack Query invalidation used in sync_update handler and staleness detector

**Data Flow (Relay Mode):**

```
POST /messages → publishViaRelay() → relay bus → ClaudeCodeAdapter
    ↓
Relay EventSource (persistent SSE on relay.human.console.{clientId})
    ↓
relay_message events → streamEventHandler() → setMessages() [local state update]
    ↓
sync_update SSE (transcript file watcher) → [BUG 1] invalidateQueries() unconditionally
    ↓
historyQuery refetch → seed effect runs → [BUG 1] appends already-rendered text

Concurrently: refetchInterval fires every 3s → GET /messages [BUG 2] → 503 (unhandled async rejection)
```

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` env var → `isRelayEnabled()` on server → surfaced in `/api/config` → `useRelayEnabled()` on client
- `relayEnabled` constant already destructured from `useRelayEnabled()` at line 85 of `use-chat-session.ts`

**Potential Blast Radius:**

- **Direct (bug sites):** 2 files — `use-chat-session.ts` (sync_update handler + refetchInterval), `sessions.ts` (GET /messages route)
- **Indirect:** None — changes are additive guards, no API or interface changes
- **Tests:** `use-chat-session-relay.test.ts` (may need new test cases for guard behavior), `sessions.test.ts` (route error handling)

---

## 4) Root Cause Analysis

**Bug 1 — Message Duplication**

- **Repro steps:** (1) Start a Relay-mode session, (2) Send a message that triggers tool calls (e.g., invokes Skill, TodoWrite, or Bash), (3) Observe the final assistant text appended twice in real-time; (4) Reload page — only one copy visible
- **Observed:** Final assistant text block appears twice during live streaming
- **Expected:** Each text block appears exactly once
- **Root-cause hypothesis (high confidence):**
  1. `relay_message` SSE events call `streamEventHandler()` which appends text to local `messages` state via `setMessages()`
  2. Concurrently, transcript writes by the SDK trigger the file watcher → server emits `sync_update` SSE
  3. `sync_update` handler at lines 270-273 calls `invalidateQueries()` unconditionally — no `isStreaming` guard
  4. `invalidateQueries()` triggers `historyQuery` to refetch GET /messages
  5. The refetch completes, `historyQuery.data` changes, the seed effect (lines 198-218) runs
  6. Guard `!isStreaming` in the seed effect fires correctly (streaming flag is true → skips append) during the refetch, BUT if the refetch completes slightly after the `done` event transitions `isStreaming → false`, the length-based slice `history.slice(currentMessages.length)` includes the just-streamed text and appends it
- **Evidence:** Exploration confirmed `sync_update` handler has no streaming guard; seed effect uses `history.slice(currentMessages.length)` not ID-based deduplication; test file confirms staleness detector fires async (timing dependent)
- **Decision:** Two-layer fix: (A) guard `sync_update` with `statusRef.current !== 'streaming'` to eliminate the unnecessary refetch during streaming; (B) replace length-slice in seed effect with ID-set filter as a defensive safety net

**Bug 2 — 503 Storm on GET /messages**

- **Repro steps:** (1) Enable Relay mode, (2) Start any session and observe network tab, (3) GET /messages fires every 3 seconds and returns 503 throughout the session
- **Observed:** Continuous 503 responses on GET /messages polling in Relay mode
- **Expected:** No polling in Relay mode (sync_update SSE handles invalidation); no 503s
- **Root-cause hypothesis (high confidence):**
  1. `refetchInterval` callback (lines 184-189) guards on `if (isStreaming) return false` but has no `relayEnabled` check
  2. In Relay mode, `isStreaming` may be false between messages — polling fires every 3s during those windows
  3. GET /messages route (`apps/server/src/routes/sessions.ts` ~line 116) calls `runtime.getMessageHistory()` inside an async route handler with no try/catch + `next(err)`
  4. Express 4 does not auto-forward unhandled async rejections to error middleware — the request hangs until the proxy times out and returns 503
  5. Root cause of the rejection likely: transcript read during session write lock, I/O contention, or Relay-mode state conflict
- **Evidence:** Exploration confirmed no try/catch in GET route; research confirms Express 4 async rejection behavior; `relayEnabled` is already in scope but not used in `refetchInterval`
- **Decision:** Two-layer fix: (A) add `|| relayEnabled` to `refetchInterval` to disable polling entirely in Relay mode; (B) add try/catch + `next(err)` to GET /messages route as correctness fix regardless of Relay mode

---

## 5) Research

**Potential solutions summary** (full analysis in `research/20260307_relay_streaming_bugs_tanstack_query.md`):

**Bug 1 approaches evaluated:**

1. **Guard `invalidateQueries` with `statusRef`** — 3 lines, surgical, uses existing ref. Recommended primary fix.
2. **ID-based deduplication in seed effect** — 4 lines, eliminates whole class of timing races. Recommended safety net.
3. **Optimistic `setQueryData` during streaming** — Requires reverse-mapping ChatMessage → HistoryMessage (non-trivial). Not recommended.
4. **Zustand for in-progress state** — Major refactor, multi-day effort. Out of scope.

**Bug 2 approaches evaluated:**

1. **`|| relayEnabled` in `refetchInterval`** — 1 line, `relayEnabled` already in scope. Recommended primary fix.
2. **try/catch + `next(err)` in Express route** — Fixes correctness issue for all callers, not just Relay. Recommended alongside fix A.
3. **`staleTime: Infinity` + remove `refetchInterval` in Relay mode** — Good long-term improvement but more code than needed now. Post-v1 option.
4. **`enabled: !relayEnabled`** — Breaks `invalidateQueries()` (disabled queries ignore invalidation in TanStack Query v5). Wrong approach.

**Key TanStack Query v5 pattern (confirmed):**

```typescript
// Correct: refetchInterval as function returning false disables polling
// Correct: invalidateQueries still works even when refetchInterval returns false
// Wrong: enabled: false causes invalidateQueries to be ignored entirely
refetchInterval: () => {
  if (isStreaming || relayEnabled) return false;
  return QUERY_TIMING.ACTIVE_TAB_REFETCH_MS;
};
```

**Recommendation:** Implement all four fixes. Total diff: ~10-15 lines across 2 files. Each fix is independently correct; together they fully resolve both bugs.

---

## 6) Decisions

No ambiguities required interactive clarification — task brief and exploration/research findings converged on the same implementation. All decisions were resolved by evidence:

| #   | Decision                    | Choice                                                                                   | Rationale                                                                                                                          |
| --- | --------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Bug 1 primary fix mechanism | Guard `sync_update` with `statusRef.current !== 'streaming'`                             | `statusRef` already exists at line 134 and tracks the exact state needed; surgical change with no refactor                         |
| 2   | Bug 1 safety net            | Add ID-set deduplication to seed effect (`history.filter((m) => !currentIds.has(m.id))`) | Eliminates the entire class of timing-race duplicates; `HistoryMessage.id` is already a UUID on all messages                       |
| 3   | Bug 2 primary fix mechanism | Add `\|\| relayEnabled` to `refetchInterval` guard                                       | `relayEnabled` is already in scope at line 85; sync_update SSE makes polling redundant in Relay mode; 1-line fix                   |
| 4   | Bug 2 secondary fix         | Add try/catch + `next(err)` to GET /messages Express route                               | Express 4 does not auto-forward async rejections; this is a correctness issue independent of Relay mode and should land regardless |
| 5   | Scope of Express fix        | All callers (not Relay-specific guard)                                                   | The try/catch is correct behavior for any GET /messages failure, not just Relay-mode failures; no reason to add a Relay branch     |
