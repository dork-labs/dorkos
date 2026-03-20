---
slug: fix-relay-sse-delivery-pipeline
number: 95
created: 2026-03-06
status: ideation
---

# Fix Relay SSE Message Delivery Pipeline

**Slug:** fix-relay-sse-delivery-pipeline
**Author:** Claude Code
**Date:** 2026-03-06
**Branch:** preflight/fix-relay-sse-delivery-pipeline

---

## 1) Intent & Assumptions

- **Task brief:** Fix intermittent SSE stream freezes (~40-50% of messages) when Relay transport is enabled. The SDK processes messages completely (JSONL has full response) but response chunks never reach the client SSE stream. The backpressure fix in session-broadcaster.ts (write queue + drain handling) is already applied — the issue is upstream: response chunks are never published to the relay subject that session-broadcaster subscribes to, OR are published but lost due to timing/serialization bugs.
- **Assumptions:**
  - The non-Relay (legacy) message path works correctly and should not be changed
  - The backpressure drain handling in `broadcastUpdate()` is correct and proven
  - RelayCore's in-memory pub/sub dispatch is reliable (synchronous invocation, no message loss in the bus itself)
  - The SDK's async generator produces all events correctly (verified by JSONL completeness)
- **Out of scope:**
  - UI-side rendering changes
  - Non-Relay message path modifications
  - Relay persistence/durability (disk-backed queues)
  - Session-broadcaster's JSONL file-watching path (working correctly)

## 2) Pre-reading Log

- `specs/fix-relay-sse-backpressure/04-implementation.md`: Documents the backpressure fix (commit ebea3a7) — added write queue + drain handling to `subscribeToRelay()` inner flush loop. Fix is correct but incomplete: the `void flush()` call site was not addressed.
- `plans/2026-03-06-chat-self-test-findings.md`: Run 1 — 4 of 5 messages froze. JSONL had complete responses. History reload rendered full content.
- `plans/2026-03-06-chat-self-test-findings-2.md`: Run 2 — 2 of 5 messages froze + 1 retry. 50+ GET /messages requests returned 503. SSE /stream initially returned 503 before connecting. Agent-ID vs SDK-Session-ID mismatch identified.
- `apps/server/src/services/session/session-broadcaster.ts`: Core of Issue #1 — `subscribeToRelay()` at line 176-210 has `void flush()` fire-and-forget at line 206. Compare with `broadcastUpdate()` at line 343 which correctly awaits drain.
- `apps/server/src/services/core/stream-adapter.ts`: Reference implementation — `sendSSEEvent()` is properly awaited by callers, serializing writes naturally.
- `apps/server/src/services/relay/claude-code-adapter.ts`: `handleAgentMessage()` at line 437-465 properly awaits `publishResponse()`. `publishResponse()` at line 847-860 properly awaits `relay.publish()`. Not the source of the bug.
- `apps/server/src/routes/sessions.ts`: POST /messages Relay fork at line 241. GET /stream SSE setup at line 340-357, calls `registerClient()` with `clientId`.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Relay path at line 238-309 — calls `sendMessageRelay()` then relies on EventSource for relay_message events. EventSource setup in separate useEffect — NO guarantee it's ready before POST.
- `apps/client/src/layers/shared/lib/transports/http-transport.ts`: `sendMessageRelay()` at line 426-444 — POST with X-Client-Id header, returns 202.
- `apps/server/src/index.ts`: Initialization wiring — RelayCore created at line 114, passed to SessionBroadcaster.setRelay() at line 271.
- `packages/relay/src/relay-core.ts`: Publish at line 291+ — synchronous subscriber invocation, no message loss in the bus.
- `research/20260306_sse_relay_delivery_race_conditions.md`: Research on SSE delivery guarantees, subscribe-first patterns, Mercure dual-buffer design, MCP Streamable HTTP patterns.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/services/session/session-broadcaster.ts` — SSE client management, relay subscription, write queue/flush (BUG HERE)
  - `apps/server/src/routes/sessions.ts` — POST /messages (Relay publish), GET /stream (SSE setup), GET /messages (history)
  - `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Client relay message path, EventSource lifecycle
  - `apps/client/src/layers/shared/lib/transports/http-transport.ts` — `sendMessageRelay()` HTTP transport
  - `apps/server/src/services/relay/claude-code-adapter.ts` — SDK event → relay publish pipeline
  - `packages/relay/src/relay-core.ts` — In-memory pub/sub core
- **Shared dependencies:**
  - `apps/server/src/services/core/stream-adapter.ts` — SSE write helpers (reference pattern)
  - `packages/relay/src/subscription-registry.ts` — Pattern matching for relay subjects
  - `apps/server/src/services/session/transcript-reader.ts` — JSONL reading (affected by session ID mismatch)
- **Data flow:**
  ```
  Client POST /messages → routes/sessions.ts (Relay fork)
    → relay.publish('relay.agent.{sessionId}')
    → ClaudeCodeAdapter.deliver()
    → AgentManager.sendMessage() (SDK query)
    → for each SDK event: relay.publish('relay.human.console.{clientId}')
    → SessionBroadcaster.subscribeToRelay callback
    → queue.push() + void flush()  ← BUG: fire-and-forget
    → res.write() to SSE stream
    → Client EventSource receives relay_message events
  ```
- **Feature flags/config:** `DORKOS_RELAY_ENABLED` gates the entire Relay path. `isRelayEnabled()` checked in routes and client hooks.
- **Potential blast radius:**
  - Direct: 4 files (session-broadcaster, sessions route, use-chat-session, relay-core)
  - Indirect: http-transport (minor), claude-code-adapter (minor)
  - Tests: session-broadcaster.test.ts, use-chat-session tests, sessions route tests

## 4) Root Cause Analysis

- **Repro steps:**
  1. Enable Relay (`DORKOS_RELAY_ENABLED=true`)
  2. Open DorkOS chat UI, start a session
  3. Send 5+ messages, including some that produce longer responses
  4. Observe: ~40-50% of messages show 0 tokens and spinning indicator for 60+ seconds
  5. Click Stop, resend — often succeeds on retry
  6. Check JSONL — complete responses are present

- **Observed vs Expected:**
  - **Observed:** SSE stream freezes mid-response. Client shows 0 tokens. Session-broadcaster's relay subscription callback never fires for frozen messages. GET /messages returns 503 repeatedly.
  - **Expected:** All SDK response chunks should stream to the client in real-time via SSE, matching the non-Relay path behavior.

- **Evidence:**
  - Self-test Run 1: 4/5 messages froze, JSONL complete
  - Self-test Run 2: 2/5 froze + 1 retry, 50+ GET /messages 503s
  - `session-broadcaster.ts:206`: `void flush()` — fire-and-forget async call
  - `session-broadcaster.ts:343`: `broadcastUpdate()` — correctly awaits drain (working reference)
  - `stream-adapter.ts:19-26`: `sendSSEEvent()` — correctly awaited by callers (working reference)
  - `use-chat-session.ts:272-277`: POST fires before EventSource is confirmed ready

- **Root-cause hypotheses:**
  1. **`void flush()` write serialization loss** (HIGH confidence): The `subscribeToRelay()` callback pushes events to a queue and calls `void flush()`. When backpressure occurs (socket buffer full), `flush()` awaits `drain`. But subsequent events call `void flush()` which returns immediately because `writing === true`. The queue fills but no new flush is triggered after drain resolves if the while-loop already exited. Events accumulate, including the terminal `done` event, causing indefinite client hang.
  2. **Subscribe-first timing race** (HIGH confidence): `sendMessageRelay()` returns 202 immediately. The server starts processing and publishing response chunks. But the client's EventSource subscription may not be registered yet — events published to `relay.human.console.{clientId}` with zero subscribers are silently dropped by RelayCore.
  3. **Session ID duality** (MEDIUM confidence): Routes use Agent-ID from URL params, but SDK assigns a different UUID as the session ID. GET /messages tries to find `{agentId}.jsonl` which doesn't exist, returning 503. This doesn't cause the SSE freeze directly but compounds the user experience (can't load history as fallback).

- **Decision:** All three are real bugs that compound to produce the 40-50% failure rate. Hypothesis #1 (void flush) causes write stalls when backpressure occurs. Hypothesis #2 (timing race) causes early event drops. Hypothesis #3 (session ID) causes the 503 flood. Fix all three.

## 5) Research

- **Potential solutions:**

  **1. Fix `void flush()` serialization + Add subscribe-first pattern**
  - Description: Fix the fire-and-forget flush call to properly serialize writes. Add a `stream_ready` event that the client waits for before sending the POST.
  - Pros: Addresses both root causes directly; proven patterns (stream-adapter.ts for flush, MCP Streamable HTTP for subscribe-first)
  - Cons: Requires coordinated client + server changes
  - Complexity: Medium
  - Maintenance: Low — straightforward control flow fix

  **2. Replace relay subscription path with direct SSE streaming**
  - Description: Bypass Relay entirely for console chat — have ClaudeCodeAdapter write directly to the SSE response object.
  - Pros: Eliminates all relay-related issues; simpler architecture
  - Cons: Loses Relay benefits (tracing, metrics, message persistence); regression from intended architecture
  - Complexity: Low
  - Maintenance: Low but architectural step backward

  **3. Add relay-level message buffering (pending buffer)**
  - Description: Buffer messages published to subjects with no active subscriber, replay when subscriber connects.
  - Pros: Defense-in-depth; catches edge cases (reconnects, race conditions)
  - Cons: Significant architectural change to RelayCore; memory overhead
  - Complexity: High
  - Maintenance: Medium — buffer lifecycle management

- **Recommendation:** Solution #1 (fix flush + subscribe-first) as the primary fix, with a 5-second pending buffer in RelayCore as defense-in-depth. This addresses the root causes directly while adding a safety net.

## 6) Decisions

| #   | Decision                 | Choice                                           | Rationale                                                                                                                                                                                            |
| --- | ------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Primary fix target       | Fix both `void flush()` AND add subscribe-first  | Both are real bugs that compound. Exploration confirmed void flush() causes write serialization loss; research confirmed subscribe-first eliminates the timing window.                               |
| 2   | Session ID resolution    | Standardize on SDK-Session-ID in messaging layer | The duality is the fundamental bug. Agent-ID is metadata about a session, not its identity. A bidirectional mapping would be a band-aid. World-class apps don't have confused identity abstractions. |
| 3   | Relay pending buffer     | Yes — add 5-second pending buffer in RelayCore   | Defense-in-depth: even with subscribe-first, reconnects and edge cases could still drop messages. Short-lived buffer catches these. Follows Mercure's dual-buffer design pattern.                    |
| 4   | Generator error handling | Add try/catch/finally to CCA generator loop      | Ensures terminal `done` event is always sent, preventing silent hangs when SDK generator throws. 30-minute fix with high reliability impact.                                                         |
