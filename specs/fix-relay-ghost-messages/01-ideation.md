---
slug: fix-relay-ghost-messages
number: 103
created: 2026-03-08
status: ideation
---

# Fix Relay-Mode SSE Subscriber Race Condition (Ghost Messages)

**Slug:** fix-relay-ghost-messages
**Author:** Claude Code
**Date:** 2026-03-08
**Branch:** preflight/fix-relay-ghost-messages

---

## 1) Intent & Assumptions

- **Task brief:** The Relay-mode SSE subscriber race condition causes ghost messages. When a user sends a message shortly after the previous one completes, the new message appears in the UI but is never delivered to the SDK session. The JSONL is not updated, and the UI displays a phantom response (replay of the previous message's response with concatenated user text).
- **Assumptions:**
  - The bug only manifests when Relay mode is enabled (`DORKOS_RELAY_ENABLED=true`)
  - The bug requires rapid successive messages (sending before the previous message's events have fully drained)
  - The fix should be backward-compatible with the non-Relay message path
  - The persistent EventSource design (one connection per session, not per message) is correct and should be preserved
- **Out of scope:**
  - Non-Relay message delivery path
  - UI rendering changes
  - Model name display inconsistency (P3 from self-test)
  - Scroll position on history load (P3 from self-test)

## 2) Pre-reading Log

- `research/20260306_sse_relay_delivery_race_conditions.md`: Prior research identifying 4 root causes and 5 fix priorities for SSE relay delivery race conditions. Directly applicable — covers the subscribe-first handshake, `streamReadyRef` staleness, and relay event leakage.
- `research/20260307_relay_streaming_bugs_tanstack_query.md`: Prior research on relay streaming bugs related to TanStack Query invalidation timing and `statusRef` guards.
- `test-results/chat-self-test/20260308-152646.md`: Self-test evidence showing the ghost message bug. Message 5 ("What is 2+2?") after Message 4 resulted in phantom response with concatenated user text, no JSONL update, no cost change.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Client-side relay message submission, `waitForStreamReady()` polling, relay EventSource effect lifecycle, `streamEventHandler`, `statusRef` guard.
- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`: Server-side SSE broadcaster, `registerClient()` with relay subscription and `stream_ready` emission, `deregisterClient()` cleanup.
- `apps/server/src/routes/sessions.ts`: Relay POST handler `publishViaRelay()`, `/stream` SSE endpoint, message history.
- `packages/relay/src/adapters/claude-code-adapter.ts`: ClaudeCodeAdapter message handling, SDK event streaming, response publishing to `envelope.replyTo`.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Main chat hook. Contains `waitForStreamReady()` (lines 17-34), relay EventSource effect (lines 244-292), `handleSubmit()` (lines 355-379), `streamEventHandler` (processes incoming relay events into UI state)
- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts` — SSE broadcaster. `registerClient()` (lines 93-137) subscribes to relay and emits `stream_ready`. `deregisterClient()` (lines 225-265) unsubscribes relay. `subscribeToRelay()` (lines 275-339) handles relay fan-in
- `apps/server/src/routes/sessions.ts` — `publishViaRelay()` (lines 182-220) publishes to `relay.agent.{sessionId}`, returns 202 receipt. `/stream` endpoint delegates to `registerClient()`
- `packages/relay/src/adapters/claude-code-adapter.ts` — `handleAgentMessage()` (lines 323-543) iterates SDK event stream and publishes each event to `envelope.replyTo` via `publishResponse()`

**Shared Dependencies:**

- `@dorkos/shared/types` — `StreamEvent` type definitions
- `@dorkos/relay` — `RelayCore` for pub/sub, `ClaudeCodeAdapter` for SDK integration
- TanStack Query — `invalidateQueries` called by `sync_update` handler

**Data Flow:**

```
Client: handleSubmit()
  → waitForStreamReady() [polls streamReadyRef, 50ms interval, 5s timeout]
  → POST /api/sessions/:id/messages
  → Server: publishViaRelay()
    → relay.publish(relay.agent.{sessionId})
    → ClaudeCodeAdapter.handleAgentMessage()
      → SDK query() → event stream
      → publishResponse() → relay.human.console.{clientId}
  → Client: EventSource relay_message listener
    → streamEventHandler() → React state updates
```

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` — Gates the relay message path (both client `useRelayEnabled()` and server `isRelayEnabled()`)

**Potential Blast Radius:**

- Direct: 1-2 files (primarily `use-chat-session.ts`, possibly `sessions.ts` route)
- Indirect: `session-broadcaster.ts` (if stream_ready_ack is added), `claude-code-adapter.ts` (if correlation ID echoing needed)
- Tests: No existing tests directly cover the relay-mode race condition — new tests needed

## 4) Root Cause Analysis

- **Repro steps:**
  1. Start DorkOS with `DORKOS_RELAY_ENABLED=true`
  2. Open a session and send Message N (any prompt)
  3. Wait for Message N to complete streaming
  4. Immediately send Message N+1 (within ~500ms of completion)
  5. Observe: Message N+1 appears with phantom response (replay of Message N's content)
  6. Verify: JSONL file has no Message N+1, cost unchanged

- **Observed vs Expected:**
  - Observed: UI shows ghost message with concatenated user text and replayed assistant response. JSONL unchanged.
  - Expected: Message N+1 delivered to SDK, new response streamed, JSONL updated.

- **Evidence:** Self-test report `test-results/chat-self-test/20260308-152646.md`, Message 5 section. JSONL stayed at 32 lines. Cost unchanged at $0.03.

- **Root-cause hypotheses:**
  1. **`streamReadyRef` never resets between messages (HIGH confidence):**
     `streamReadyRef.current` is set to `true` on the first `stream_ready` event (line ~260) and only reset in the `onerror` handler (line 279) or effect cleanup (line 286). A graceful server close (`res.end()`) does NOT fire `onerror` — only network errors do. So after Message 1's `stream_ready`, the ref stays `true` forever. The `waitForStreamReady()` check at line 356-360 passes immediately for all subsequent messages, skipping the subscribe-first handshake entirely.

  2. **Late relay events from Message N bleed into Message N+1 (HIGH confidence):**
     The persistent `relay_message` listener calls `streamEventHandler(..., assistantIdRef.current)`. When Message N's late-arriving chunks (still draining through the relay pipeline after the `done` event) fire after `assistantIdRef.current` has been updated for Message N+1, those chunks create a new assistant bubble under Message N+1's ID but filled with Message N's content — the phantom response.

  3. **`statusRef.current` guard has a timing window (MEDIUM confidence):**
     `statusRef.current` is updated via `useEffect` (async after paint). The `sync_update` guard checks `statusRef.current === 'streaming'` — but immediately after `setStatus('streaming')`, there's a 10-50ms window where `statusRef` still reads `'idle'`, letting a `sync_update` from the previous message's JSONL write trigger `invalidateQueries` and a history overwrite.

- **Decision:** All three root causes are compounding. Root cause 1 is the primary enabler (messages send without handshake). Root cause 2 creates the phantom content. Root cause 3 enables the history overwrite. All three must be fixed for reliable delivery.

## 5) Research

**Potential Solutions:**

**1. Synchronous `statusRef` update + per-message `streamReadyRef` reset (Quick fix)**

- Description: Set `statusRef.current = 'streaming'` synchronously alongside `setStatus('streaming')` in `handleSubmit()`. Reset `streamReadyRef.current = false` before each message send so the subscribe-first handshake is enforced per-message.
- Pros: 1-2 line changes, fixes root causes 1 and 3 directly, no protocol changes
- Cons: Doesn't address root cause 2 (late event bleed). Relies on EventSource auto-reconnect to trigger a fresh `stream_ready`.
- Complexity: Low
- Maintenance: Low

**2. Per-message correlation ID (Comprehensive fix)**

- Description: Generate a `correlationId` (UUID) for each message send. Thread it through: POST body → relay envelope metadata → adapter response chunks → `relay_message` events. Client filters incoming events — discards any whose `correlationId` doesn't match the current message's ID.
- Pros: Eliminates root cause 2 completely. Events from Message N cannot leak into Message N+1 regardless of timing. Industry standard pattern (Slack, Discord use similar approaches).
- Cons: Requires changes across client, server route, and adapter. More surface area.
- Complexity: Medium
- Maintenance: Low (correlation IDs are self-documenting)

**3. `stream_ready_ack` from adapter (Hardening)**

- Description: ClaudeCodeAdapter publishes a synthetic `stream_ready_ack` event as the first chunk of each response. Client resets `streamReadyRef.current = false` before each send and waits for the ack — restoring per-message subscribe-first semantics.
- Pros: Guarantees the full relay pipeline (client → server → adapter → relay → back to client) is confirmed before the first real event. Most robust.
- Cons: Adds latency (~50-100ms per message). Requires adapter protocol change.
- Complexity: Medium-High
- Maintenance: Medium

**4. Request queue/serialization**

- Description: Queue messages client-side and process them serially — only send Message N+1 after Message N's `done` event AND a cooldown period.
- Pros: Simple to implement. Eliminates the rapid-succession scenario.
- Cons: Artificially limits throughput. Doesn't fix the root cause — just avoids triggering it. Bad UX for users who type fast.
- Complexity: Low
- Maintenance: Low

**Recommendation:** Solutions 1 + 2 together. Solution 1 is a quick fix that addresses root causes 1 and 3 with minimal code changes. Solution 2 (correlation ID) addresses root cause 2 and provides lasting protection against event leakage. Solution 3 (stream_ready_ack) is valuable but can be deferred — the combination of 1 and 2 is sufficient. Solution 4 is rejected as it masks the problem rather than fixing it.

## 6) Decisions

No ambiguities identified — task brief, evidence, and findings were sufficiently clear. The three root causes are well-understood and the fix approach (synchronous statusRef + per-message correlation ID) is the clear winner from both exploration and research.
