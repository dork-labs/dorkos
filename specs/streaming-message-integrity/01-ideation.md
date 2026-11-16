---
slug: streaming-message-integrity
number: 150
created: 2026-03-19
status: ideation
---

# Streaming Message Integrity

**Slug:** streaming-message-integrity
**Author:** Claude Code
**Date:** 2026-03-19

---

## 1) Intent & Assumptions

- **Task brief:** Fix two bugs in the DorkOS chat UI — message flash on stream completion and disappearing error messages — caused by the post-stream history replace in `use-chat-session.ts`. Additionally, fix the transcript parser to extract error/subagent/hook parts from JSONL, and implement server-echo ID to replace content/position matching with exact ID-based dedup.

- **Assumptions:**
  - The `_streaming` boolean flag on `ChatMessage` is sufficient (no richer metadata needed)
  - The SDK's JSONL transcript format is stable enough to add parser support for error/subagent/hook blocks
  - The `done` SSE event payload can be extended to include JSONL-assigned message IDs without breaking existing clients
  - Cross-client sync and message polling will continue to work correctly with the incremental append path after the replace is removed
  - The bounded tagged set (0-2 messages per streaming turn) means content/position matching is performant and reliable as an interim approach

- **Out of scope:**
  - Event-sourced chat model (confirmed as correct long-term direction but not justified for these bugs)
  - Moving streaming state from local React state into TanStack Query cache (deliberate architecture choice for performance)
  - Adopting the SDK's `getSessionMessages()` API (returns `unknown`-typed messages, doesn't solve data loss)
  - Fixing the Vercel AI SDK's upstream reconciliation gap (different product, same problem)

## 2) Pre-reading Log

- `specs/streaming-message-integrity/00-summary.md`: Pre-ideation summary with root cause analysis, 6 alternatives considered, proposed 4-step solution, 5 research investigations
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` (567 lines): Central hook — seed effect (lines 283-307) with three branches, `executeSubmission` (lines 365-471) with the bug-triggering post-stream reset (lines 434, 439), history query (lines 252-265), incremental dedup (lines 300-301)
- `apps/client/src/layers/features/chat/model/stream-event-handler.ts` (302 lines): Done handler with session remap `setMessages([])` (line 265), error event pushing to `currentPartsRef` (lines 164-174), text/thinking delta handling (lines 71-141)
- `apps/client/src/layers/features/chat/model/chat-types.ts` (69 lines): `ChatMessage` interface (lines 3-13) — no `_streaming` flag exists yet; `ToolCallState` (lines 25-43)
- `apps/client/src/layers/features/chat/model/stream-event-helpers.ts` (115 lines): `ensureAssistantMessage` (lines 71-86) creates assistant message with client UUID; `updateAssistantMessage` (lines 88-104) immutable update; `deriveFromParts` (lines 11-34) backward compat
- `apps/client/src/layers/features/chat/model/stream-event-types.ts` (56 lines): `StreamingTextPart` with client-only `_partId` field (lines 9-12) — establishes underscore-prefix convention for internal fields
- `packages/shared/src/schemas.ts` (1063 lines): `ErrorPart` (lines 571-590), `HookPart` (lines 512-522), `SubagentPart` (lines 545-558), `MessagePartSchema` discriminated union (lines 582-590), `HistoryMessage` (lines 615-629)
- `apps/server/src/services/runtimes/claude-code/transcript-parser.ts`: Custom JSONL parser — only extracts `thinking`, `text`, `tool_use` blocks. Error/subagent/hook blocks silently skipped.
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-remap.test.ts` (121 lines): Remap test confirms `setMessages([])` is called (lines 74-98); non-remap test verifies it's not called (lines 100-119)
- `apps/client/src/layers/features/chat/model/__tests__/stream-event-handler-error.test.ts` (120 lines): Error part test verifies parts pushed to `currentPartsRef` (lines 62-84)
- `contributing/data-fetching.md`: TanStack Query patterns — `useQuery` for server state, `useMutation` for writes, `invalidateQueries` for cache sync
- `contributing/state-management.md`: Zustand for UI state, TanStack Query for server state — streaming chat messages are intentionally in local React state for performance
- `decisions/0117-client-direct-sse.md`: ADR establishing direct SSE architecture — POST response body IS the SSE stream; separate persistent EventSource for cross-client `sync_update` events only
- `research/20260307_fix_chat_streaming_history_consistency.md`: Prior research on auto-scroll and tool result orphan patterns
- `research/20260312_fix_chat_stream_remap_bugs.md`: Prior research identifying "Approach D" (stable assistant ID via server echo) as the correct long-term fix for ID mismatch
- `research/20260319_streaming_message_integrity_patterns.md`: New research — 13 searches covering optimistic update patterns (Slack, Vercel AI SDK, RTK Query), TanStack Query + SSE reconciliation, event sourcing for chat, session ID reassignment strategies

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Session hook: seed effect, executeSubmission, history query, message state
  - `apps/client/src/layers/features/chat/model/stream-event-handler.ts` — SSE event handler: text/thinking deltas, tool calls, errors, done/remap
  - `apps/client/src/layers/features/chat/model/stream-event-helpers.ts` — ensureAssistantMessage, updateAssistantMessage, deriveFromParts
  - `apps/client/src/layers/features/chat/model/chat-types.ts` — ChatMessage interface, ToolCallState
  - `apps/server/src/services/runtimes/claude-code/transcript-parser.ts` — JSONL parser (server-side)
  - `packages/shared/src/schemas.ts` — MessagePart union, HistoryMessage schema

- **Shared dependencies:**
  - TanStack Query (`useQuery`, `useQueryClient`, `invalidateQueries`)
  - React state (`useState`, `useRef`, `useEffect`, `useMemo`)
  - Transport interface (`transport.getMessages`, `transport.sendMessage`)
  - Zod schemas from `@dorkos/shared/schemas`

- **Data flow:**

  ```
  User submits → executeSubmission → transport.sendMessage(SSE) → streamEventHandler
    → ensureAssistantMessage → updateAssistantMessage → setMessages (React state)

  Parallel: historyQuery polls → seed effect → Branch 1 (full replace) or Branch 2 (incremental append)

  Post-stream: historySeededRef=false → seed effect runs with stale data → FLASH (Bug 1)
  Post-stream: transcript parser skips error parts → full replace loses them → VANISH (Bug 2)
  ```

- **Feature flags/config:**
  - `enableCrossClientSync` (Zustand, persisted) — gates SSE sync connection
  - `enableMessagePolling` (Zustand, persisted) — gates history refetch interval
  - `isTabVisible` — gates polling frequency (active vs background tab)

- **Potential blast radius:**
  - Direct: 4 files (chat-types.ts, use-chat-session.ts, stream-event-handler.ts, stream-event-helpers.ts) + transcript-parser.ts (server) + SSE event payload (server)
  - Indirect: Any component rendering `ChatMessage` that checks for new fields
  - Tests: 2 existing test files need updates; new tests needed for dedup logic and parser
  - Risk: The seed effect rewrite touches the core message rendering pipeline; any bug here affects all chat sessions

## 4) Root Cause Analysis

- **Repro steps:**
  1. Open a chat session in DorkOS
  2. Send a message that triggers a hook validation failure (e.g., missing env var)
  3. Observe the agent streaming response with an inline `ErrorMessageBlock`
  4. Wait for the agent to finish responding
  5. Bug 1: All messages visibly flash (disappear and reappear)
  6. Bug 2: The inline error message is permanently gone

- **Observed vs Expected:**
  - Observed: Messages flash on stream completion; error messages vanish permanently
  - Expected: Messages remain stable; error messages persist in the conversation

- **Evidence:**
  - `use-chat-session.ts:434`: `historySeededRef.current = false` resets the seed flag after streaming ends
  - `use-chat-session.ts:439`: `queryClient.invalidateQueries({ queryKey: ['messages'] })` triggers background refetch
  - `use-chat-session.ts:289-296`: Seed effect Branch 1 runs with stale history data → full `setMessages(history.map(mapHistoryMessage))` replace
  - `transcript-parser.ts`: Only parses `thinking`, `text`, `tool_use` — error blocks are silently dropped
  - `stream-event-handler.ts:168-173`: Error parts pushed to `currentPartsRef` during streaming — these exist only in-memory

- **Root-cause hypotheses:**
  1. **Post-stream replace with stale data causes flash** (HIGH confidence — traced exact code path)
  2. **Transcript parser gap causes permanent error loss** (HIGH confidence — confirmed by gap analysis)
  3. **ID mismatch prevents incremental dedup** (HIGH confidence — client UUID vs SDK UUID)

- **Decision:** All three hypotheses are confirmed and contribute to the bugs. The post-stream replace (hypothesis 1) triggers the flash. The transcript parser gap (hypothesis 2) ensures error parts are never recovered. The ID mismatch (hypothesis 3) is why the replace was added in the first place — fixing it removes the need for the replace.

## 5) Research

### Prior Research (from 00-summary.md)

1. **Polling landscape audit** — All 15+ polling hooks inventoried; `refetchIntervalInBackground: false` added to 5 always-on hooks (committed)
2. **Settings effectiveness review** — `enableCrossClientSync` and `enableMessagePolling` correctly gate their respective systems
3. **Transcript parser gap analysis** — Error, subagent, hook, and tool progress parts never extracted from JSONL
4. **Agent SDK history API** — `getSessionMessages()` returns `unknown`; doesn't solve data loss
5. **Performance analysis** — Tagged set bounded at 0-2 messages; O(n) dedup with n = server messages per poll

### New Research (from research/20260319_streaming_message_integrity_patterns.md)

**1. Optimistic Update Patterns in Production Chat UIs**

Slack uses `client_msg_id` (UUID) as a secondary dedup key alongside the server-assigned `ts` (timestamp ID). The client finds the optimistic bubble by `client_msg_id` and updates its primary ID in-place — never replaces the list. This is the industry standard.

The Vercel AI SDK faces the exact same problem and has not solved it. Their `appendResponseMessages` uses different ID logic than `useChat` during streaming, causing known mismatches. The gap DorkOS is solving is not unique.

RTK Query's `onCacheEntryAdded` pattern (streaming handler patches cache in-place) is architecturally equivalent to our proposed "skip the replace, let polling append."

**2. TanStack Query + SSE Reconciliation**

TanStack Query's canonical optimistic update pattern: Cancel → Snapshot → Write → Invalidate. The current DorkOS code does step 4 (Invalidate) without step 1 (Cancel), causing the stale-data flash. The fix (skip `invalidateQueries` after streaming) is the correct application of this pattern.

tkdodo's `isMutating() === 1` guard confirms: invalidation should only happen when the last concurrent mutation settles. A streaming session is a long-running mutation — deferring invalidation to natural polling is correct.

**3. Event Sourcing Assessment**

Event sourcing on the client (all events → immutable log → derived message list) is a real pattern (Rapport + React/Redux/Elixir). Solves the dual-source problem elegantly but requires a new event log type, reducer, and projection layer. Correct long-term direction if DorkOS adds replay, audit, or multi-stream. Overkill for two bugs.

**4. Session ID Reassignment**

Three strategies documented: Traditional Server (match by secondary signal), Client-ID Propagation (server echoes JSONL ID), Client-Owns-ID (not viable for DorkOS). Strategy 2 (Client-ID Propagation) is the industry standard and confirmed as the correct long-term fix by both external research and prior DorkOS research (`20260312` Approach D).

### Recommendation

Three-phase implementation:

1. **Phase 1 — Tagged-dedup** (client-only, fixes both bugs immediately): Skip the post-stream replace, tag streaming messages with `_streaming: true`, match to server messages by user-content + position-from-end, preserve client-only parts on match.

2. **Phase 2 — Transcript parser fix** (server-side): Extract error, subagent, and hook parts from JSONL. Fixes data loss when loading past sessions from disk.

3. **Phase 3 — Server-echo ID** (client + server): Include client UUID in streaming request, echo JSONL-assigned message ID in `done` event, update in-memory ID on done. Replaces content/position matching with exact ID-based dedup. Eliminates the `_streaming` tag.

## 6) Decisions

| #   | Decision                    | Choice               | Rationale                                                                                                                                                                                                                  |
| --- | --------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Transcript parser fix scope | Include in this spec | The parser gap causes data loss when loading past sessions — same problem domain. Fixing it alongside the streaming integrity fix provides complete coverage.                                                              |
| 2   | `_streaming` tag structure  | Simple boolean flag  | The bounded set (0-2 messages) and position-from-end matching make richer metadata unnecessary. If server-echo ID is implemented (Phase 3), the tag is removed entirely. Follows existing `_partId` underscore convention. |
| 3   | Server-echo ID scope        | Include in this spec | Research confirms this is the industry-standard approach (Slack `client_msg_id` → `ts` remap). Including it as Phase 3 provides the complete fix — content/position matching is an interim bridge, not the end state.      |
| 4   | Event sourcing              | Not included         | Confirmed as correct long-term architecture but not justified for these bugs. Complexity cost (event log, reducer, projection) far exceeds the benefit for a two-bug fix.                                                  |

---

## Alternatives Considered

### Alternative A: Fix the Stale Data Timing (Timestamp-Gated Replace)

**Approach:** Keep the full replace but delay it until fresh history arrives. Track a timestamp when streaming ends, and in the seed effect, only perform the full replace if `historyQuery.dataUpdatedAt > streamEndTimestamp`.

**Why not chosen:** Fixes the flash (Bug 1) but does NOT fix disappearing errors (Bug 2). The server transcript parser doesn't return error parts regardless of timing. Solves one symptom without addressing the architectural issue.

### Alternative B: Preserve Error Parts During the Replace

**Approach:** Keep the full replace but extract error/subagent/hook parts from outgoing streaming messages and graft them onto incoming history messages.

**Why not chosen:** Fragile matching heuristic when IDs differ. Only preserves parts we explicitly enumerate. The streaming messages already contain all the data — grafting is unnecessary complexity.

### Alternative C: Reconcile IDs Instead of Replacing Messages

**Approach:** After streaming, fetch history, match messages, extract server IDs, update client IDs in-place.

**Why not chosen:** This is the server-echo ID approach but done entirely client-side with more steps. The server-echo approach (Phase 3) is simpler because the server provides the mapping directly.

### Alternative D: Use Agent SDK's `getSessionMessages()`

**Approach:** Replace custom transcript parser with the SDK's official API.

**Why not chosen:** `SessionMessage.message` is typed as `unknown`. The SDK's API reads from the same JSONL files — it can't return data the SDK didn't persist. Orthogonal to the data loss problem.

### Alternative E: Master "Disable All Polling" Toggle

**Approach:** Add a single setting to turn off all background network activity.

**Why not chosen:** Debugging tool, not a fix. Masks the problem by preventing the replace.

### Alternative F: Match by Absolute Array Position

**Approach:** Match streaming messages to history messages by index.

**Why not chosen:** SSE produces richer data (error/subagent/hook parts) that can change message structure. Compact boundary markers create synthetic client messages with no server counterpart, shifting positions.

---

## Key Files

| File                                                                 | Role               | Changes Needed                                                                                                         |
| -------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `apps/client/src/layers/features/chat/model/chat-types.ts`           | ChatMessage type   | Add `_streaming?: boolean`                                                                                             |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`     | Session hook       | Remove post-stream reset (lines 434, 439); rewrite seed effect Branch 2 with tagged dedup; tag user/assistant messages |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts` | SSE handler        | Remove `setMessages([])` in remap case (line 265); accept server-echo IDs in done event                                |
| `apps/client/src/layers/features/chat/model/stream-event-helpers.ts` | Helpers            | Add `_streaming: true` to ensureAssistantMessage                                                                       |
| `apps/server/src/services/runtimes/claude-code/transcript-parser.ts` | JSONL parser       | Extract error, subagent, hook parts from JSONL blocks                                                                  |
| `packages/shared/src/schemas.ts`                                     | Schemas            | Already defines all part types — no changes needed                                                                     |
| Server SSE endpoint                                                  | Done event payload | Include JSONL-assigned message IDs for server-echo                                                                     |

---

## Sources

- [Real-time Messaging — Slack Engineering](https://slack.engineering/real-time-messaging/)
- [chat.postMessage — Slack API](https://api.slack.com/methods/chat.postMessage)
- [Client-Side Temporary IDs — DEV Community](https://dev.to/danielsc/client-side-temporary-ids-5c2k)
- [Optimistic Updates — TanStack Query Docs](https://tanstack.com/query/latest/docs/framework/react/guides/optimistic-updates)
- [Concurrent Optimistic Updates in React Query — tkdodo.eu](https://tkdodo.eu/blog/concurrent-optimistic-updates-in-react-query)
- [React Query caching with SSE](https://fragmentedthought.com/blog/2025/react-query-caching-with-server-side-events)
- [Streaming Updates — Redux Toolkit](https://redux-toolkit.js.org/rtk-query/usage/streaming-updates)
- [Guidance on persisting messages — vercel/ai #4845](https://github.com/vercel/ai/discussions/4845)
- [AI SDK 5 — Vercel](https://vercel.com/blog/ai-sdk-5)
- [Event Sourcing in React/Redux/Elixir — Rapport](https://medium.com/rapport-blog/event-sourcing-in-react-redux-elixir-how-we-write-fast-scalable-real-time-apps-at-rapport-4a26c3aa7529)
- [Optimistic mutation results — Apollo GraphQL](https://www.apollographql.com/docs/react/performance/optimistic-ui)
- [Understanding optimistic UI — LogRocket](https://blog.logrocket.com/understanding-optimistic-ui-react-useoptimistic-hook/)
- Prior DorkOS research: `research/20260307_fix_chat_streaming_history_consistency.md`, `research/20260312_fix_chat_stream_remap_bugs.md`, `research/20260319_streaming_message_integrity_patterns.md`
- Prior DorkOS ADR: `decisions/0117-client-direct-sse.md`
