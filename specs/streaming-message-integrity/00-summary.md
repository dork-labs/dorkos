# Streaming Message Integrity

**Slug:** streaming-message-integrity
**Date:** 2026-03-19
**Status:** pre-ideation

---

## Problem Statement

Two bugs in the DorkOS chat UI stem from the same root cause: the post-stream history replace in `use-chat-session.ts`.

### Bug 1: Message Flash on Stream Completion

When an agent finishes responding, chat messages visibly flash — they disappear and reappear in rapid succession. This happens because the seed effect replaces all messages with stale pre-streaming history data before fresh history arrives.

### Bug 2: Disappearing Error Messages

Inline `ErrorMessageBlock` components (e.g., `execution_error` from hook validation failures) vanish after the agent finishes responding. The error is visible during streaming but permanently lost once the post-stream history replace occurs.

---

## Root Cause Analysis

### The Post-Stream Replace Sequence

After streaming completes, `executeSubmission` in `use-chat-session.ts:434-440` does:

```
historySeededRef.current = false    // Reset seed flag
queryClient.invalidateQueries(...)  // Trigger background refetch
setStatus('idle')                   // End streaming
```

This causes the seed effect (`use-chat-session.ts:283-307`) to run with **stale** history data (the refetch hasn't returned yet), performing a full `setMessages(history.map(mapHistoryMessage))` replace. The stale history is missing the messages from the current streaming session, causing them to briefly disappear (flash). When the fresh refetch arrives, the incremental append path adds the new messages back.

### Why Error Parts Are Lost

The full replace is compounded by a server-side gap: the transcript parser (`transcript-parser.ts:338-394`) only extracts `thinking`, `text`, and `tool_use` blocks from the SDK JSONL. It does not parse error blocks. So even when fresh history arrives, the error part is absent — the server never returns it.

The streaming assistant message had the error part in-memory (pushed at `stream-event-handler.ts:168-173`). The full replace swaps it for the server's version which has no error part. The error is permanently lost.

### Additional Data Loss from History Replace

The transcript parser gap extends beyond errors. A full comparison of SSE streaming vs JSONL history reveals:

| Data Element                            | In SSE Stream?                | In JSONL History? | Impact                              |
| --------------------------------------- | ----------------------------- | ----------------- | ----------------------------------- |
| Text response                           | Yes                           | Yes               | No loss                             |
| Thinking blocks                         | Yes (with `elapsedMs` timing) | Text only         | Thinking duration lost              |
| Tool calls (input + result)             | Yes                           | Yes               | No loss                             |
| **Error parts**                         | Yes                           | **No**            | Errors vanish from history          |
| **Subagent parts**                      | Yes (started/progress/done)   | **No**            | Multi-agent orchestration invisible |
| **Hook parts** (stdout/stderr/exitCode) | Yes                           | **No**            | Build/test output lost              |
| **Tool progress output**                | Yes                           | **No**            | Real-time execution output lost     |

---

## Why the Replace Exists

The post-stream replace exists to solve an **ID mismatch problem**. During streaming, the client creates messages with `crypto.randomUUID()` IDs. The server's JSONL transcript uses different IDs assigned by the SDK. Without the replace, both copies would appear as duplicates (the incremental append path deduplicates by ID, so different IDs = different messages).

A secondary purpose: when the SDK assigns a different session ID than the client-generated one (session remap on first message), the done handler clears messages and triggers a remap. The full replace then populates the new session's history.

---

## Alternatives Considered

### Alternative A: Fix the Stale Data Timing (Timestamp-Gated Replace)

**Approach:** Keep the full replace but delay it until fresh history arrives. Track a timestamp when streaming ends, and in the seed effect, only perform the full replace if `historyQuery.dataUpdatedAt > streamEndTimestamp`.

**Why not chosen:** This fixes the flash (Bug 1) but does NOT fix disappearing errors (Bug 2). The server transcript parser doesn't return error parts regardless of timing. Even with fresh data, the full replace still loses error/subagent/hook parts. Solves one symptom without addressing the architectural issue.

### Alternative B: Preserve Error Parts During the Replace

**Approach:** Keep the full replace but, before replacing, extract error/subagent/hook parts from the outgoing streaming messages and graft them onto the incoming history messages (matching by last assistant message position).

**Why not chosen:** Fragile matching heuristic — requires pairing outgoing and incoming assistant messages when their IDs differ. Also only preserves parts we explicitly enumerate (errors today, but what about future part types?). Treats the symptom rather than questioning whether the replace should happen at all. The streaming messages already contain all the data we need — grafting parts from one copy to another is unnecessary complexity.

### Alternative C: Reconcile IDs Instead of Replacing Messages

**Approach:** After streaming ends, update the client-generated IDs on the streaming messages to match the server's IDs. Then the incremental append path's ID-based dedup works naturally — no duplicates, no replace needed.

**Why not chosen:** We don't know the server's IDs until we fetch history. The done event includes `sessionId` but not message-level IDs. We'd need to fetch history, match messages, extract IDs, and update in-place — which is essentially a more complex version of the full replace with extra steps. Also doesn't help with the session remap case where the session ID itself changes.

### Alternative D: Use the Agent SDK's `getSessionMessages()` Instead of Custom JSONL Parsing

**Approach:** Replace our custom transcript parser with the SDK's official `getSessionMessages()` API, which abstracts JSONL reading.

**Why not chosen:** The SDK's `SessionMessage.message` field is typed as `unknown` — it returns raw JSONL payloads without typed content blocks. Our custom parser provides richer typed access (tool call correlation, question/answer extraction, command detection). More importantly, the SDK's API still reads from the same JSONL files — it can't return data the SDK didn't persist (errors, subagents, hooks). Switching the reader doesn't solve the data loss problem. Worth considering long-term for resilience to JSONL format changes, but orthogonal to this issue.

### Alternative E: Add a Master "Disable All Polling" Toggle

**Approach:** Add a single setting to turn off all background network activity, which would also prevent the post-stream refetch.

**Why not chosen:** This is a debugging tool, not a fix. It masks the problem by preventing the replace from happening, but the user loses cross-client sync and session list updates. The right fix is to make the replace unnecessary, not to give users a kill switch. The existing `enableCrossClientSync` and `enableMessagePolling` toggles are already correctly scoped for diagnostics.

### Alternative F: Match by Absolute Array Position

**Approach:** Instead of matching by ID, match streaming messages to history messages by their index in the message array.

**Why not chosen:** SSE produces richer data than the transcript — error parts, subagent parts, and hook parts exist as parts within messages but can change the message structure. More critically, compact boundary markers create synthetic messages in the client that have no server counterpart, shifting positions. Position matching is fragile when the two sources have different message counts or structures.

---

## Proposed Solution (Chosen)

**Core idea: Skip the post-stream replace entirely. Streaming messages are the source of truth — they contain richer data than the transcript. Use tagged-message dedup to prevent duplicates when polling resumes.**

### Step 1: Stop Resetting `historySeededRef` After Streaming

Remove lines 434 and 439 from `executeSubmission` (the `historySeededRef.current = false` and `queryClient.invalidateQueries`). After streaming ends, the local messages stay as-is. No flash, no data loss.

### Step 2: Tag Streaming Messages

Mark the optimistic user message and the streaming assistant message with a `_streaming: true` flag (or similar internal marker). This flag identifies messages whose IDs were client-generated and don't match server IDs.

### Step 3: Smart Dedup in the Incremental Append Path

When polling or cross-client sync brings in server history, the incremental append path currently checks `currentIds.has(m.id)`. Enhance this to also check: "does a tagged streaming message exist that matches this server message by role and corresponds to the same turn?"

The matching strategy (in order of preference):

- **Position-from-end**: The tagged messages are always the last user + last assistant messages. Server history's last user + assistant messages correspond to them.
- **Content match on user message**: The user message content is exact (we submitted it). The assistant message is the one immediately following the matched user message.

When a match is found: replace the tagged message with the server version, **carrying over any client-only parts** (error, subagent, hook parts) that the server version lacks. Clear the `_streaming` tag.

### Step 4: Handle Session ID Remap

The done handler's session remap case (`stream-event-handler.ts:258-266`) currently clears messages with `setMessages([])`. Instead, keep the messages on screen and let the session change effect + history fetch handle the transition. The tagged-message dedup will prevent duplicates. The visual result: messages stay visible throughout the remap instead of flashing empty.

---

## Research Conducted

### 1. Polling Landscape Audit

Inventoried all 15+ polling hooks in the client. Found that only `useChatSession` and `useGitStatus` respected tab visibility — all others polled at full speed in background tabs. Fixed by adding `refetchIntervalInBackground: false` to 5 hooks (already committed).

### 2. Settings Effectiveness Review

Confirmed that `enableCrossClientSync` and `enableMessagePolling` settings correctly gate chat SSE and chat message polling respectively. Other subsystem polling (Relay, Mesh, Pulse, Tunnel) is either panel-gated (only polls when dialog is open) or uses feature flags. The settings are correctly scoped as diagnostic tools.

### 3. Transcript Parser Gap Analysis

Compared every SSE event type against every JSONL block type the transcript parser handles. Confirmed that error, subagent, hook, and tool progress parts are never extracted from JSONL. The `MessagePartSchema` union in `packages/shared/src/schemas.ts` defines all these types, but the parser only handles three: `thinking`, `text`, `tool_use`.

### 4. Agent SDK History API

The Agent SDK provides `getSessionMessages(sessionId, options?)` which returns `SessionMessage[]`. However, `SessionMessage.message` is typed as `unknown` — it provides raw JSONL payloads without typed content blocks. DorkOS's custom parser provides richer typed access but still can't extract data that the SDK doesn't write to JSONL (errors, subagents, hooks). Neither approach solves the data loss problem — the gap is in what the SDK persists, not in how we read it.

**Source:** [Agent SDK Sessions docs](https://platform.claude.com/docs/en/agent-sdk/sessions), [GitHub Issue #14](https://github.com/anthropics/claude-agent-sdk-typescript/issues/14) (feature request for historical message replay on resume).

### 5. Performance Analysis of Content Matching

The tagged-message set is bounded at 0-2 messages (one user, one assistant) per streaming turn. Tags are cleared when server versions arrive. The dedup comparison is O(n) where n = server messages per poll response, with a constant-factor check against the tagged set. Content string comparison only occurs against the user message (which is short) — the assistant message is matched by position relative to the matched user message. No unbounded growth, no performance concern.

---

## Key Files

| File                                                                 | Role                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `apps/client/src/layers/features/chat/model/use-chat-session.ts`     | Session hook — seed effect, executeSubmission, history query             |
| `apps/client/src/layers/features/chat/model/stream-event-handler.ts` | SSE event handler — done handler, error handling, session remap          |
| `apps/client/src/layers/features/chat/model/stream-event-helpers.ts` | Helper functions for stream event processing                             |
| `apps/client/src/layers/features/chat/model/chat-types.ts`           | ChatMessage type definition (needs `_streaming` flag)                    |
| `apps/server/src/services/runtimes/claude-code/transcript-parser.ts` | JSONL parser — currently skips error/subagent/hook blocks                |
| `packages/shared/src/schemas.ts`                                     | MessagePart union — defines all part types including error/subagent/hook |

---

## Open Questions for Ideation

1. **Should we also fix the transcript parser?** Improving it to extract errors, subagents, and hooks would fix data loss for initial session loads (opening a past session). This is orthogonal to the streaming integrity fix but valuable for the same reasons.

2. **What about the session remap case?** The proposed fix (Step 4) keeps messages on screen during remap instead of clearing. Need to verify this doesn't cause visual artifacts when the session ID changes and the history query key shifts.

3. **Should the `_streaming` tag be a boolean flag or a richer structure?** A richer structure (e.g., `_streamMeta: { originalId, timestamp }`) could enable more robust matching.

4. **Long-term: should we move to an event-sourced model?** Instead of alternating between "streaming state" and "history state," accumulate all events into a single ordered log. The message list derives from the log. History fetches merge into the log rather than replacing it.
