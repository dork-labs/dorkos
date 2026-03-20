---
slug: client-direct-sse
number: 125
created: 2026-03-12
status: ideation
---

# Client Direct SSE — Remove Relay Message Path from Web Client

**Slug:** client-direct-sse
**Author:** Claude Code
**Date:** 2026-03-12
**Branch:** preflight/client-direct-sse

---

## 1) Intent & Assumptions

- **Task brief:** Make the DorkOS web client always use direct SSE for sending messages and receiving streaming responses. Remove the relay message path from the web client entirely. SSE is no longer a "legacy" feature — it's the primary and only client transport. Relay stays for external adapters (Telegram, webhooks) and agent-to-agent communication.

- **Assumptions:**
  - The relay infrastructure (RelayCore, CCA adapter, external adapters) stays intact
  - External adapters are unaffected — they route through CCA → runtime → JSONL → file watcher → SSE
  - `sendMessageRelay()` stays on the Transport interface (backward compat) but is no longer called from the web client
  - The `useRelayEnabled()` hook and relay entity hooks stay (used by Relay UI panel, ConnectionsView, adapter management)
  - DirectTransport (Obsidian plugin) is unaffected — it never supported relay

- **Out of scope:**
  - Removing the relay infrastructure itself (RelayCore, adapters, relay routes)
  - Removing relay UI features (Relay panel, adapter management, observed chats)
  - Removing the `sendMessageRelay()` method from the Transport interface
  - Changes to agent-to-agent communication patterns

## 2) Pre-reading Log

- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: Core chat hook — branches at line 406 on `relayEnabled` flag. Relay path adds correlationId, stream_ready handshake, staleness detection. Legacy SSE path is ~10 lines.
- `apps/client/src/layers/shared/lib/transport/http-transport.ts`: Implements both `sendMessage()` (SSE) and `sendMessageRelay()` (relay) on Transport interface.
- `apps/client/src/layers/shared/lib/transport/relay-methods.ts`: Factory for relay-specific Transport methods — most stay (used by relay UI), but `sendMessageRelay()` stops being called from chat.
- `apps/server/src/routes/sessions.ts`: POST `/api/sessions/:id/messages` has dual paths — relay (lines 232-255, returns 202) and "legacy" SSE (lines 257-306, streams on POST). GET `/api/sessions/:id/stream` sends `stream_ready` event when relay enabled.
- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`: `registerClient()` sets up relay subscription via `subscribeToRelay()`. Relay fan-in forwards `relay_message` events to SSE stream.
- `apps/server/src/services/relay/relay-state.ts`: `DORKOS_RELAY_ENABLED` env var / config flag.
- `apps/client/src/layers/entities/relay/model/use-relay-config.ts`: `useRelayEnabled()` reads `config.relay.enabled` — stays (used by relay UI panels, ConnectionsView, adapter management).
- `packages/shared/src/transport.ts`: Transport interface with both `sendMessage()` and `sendMessageRelay()` methods.
- `contributing/architecture.md`: Documents hexagonal architecture with Transport interface.
- Prior relay bug-fix specs: `fix-relay-sse-delivery-pipeline`, `fix-relay-ghost-messages`, `fix-relay-streaming-bugs`, `fix-relay-sse-backpressure`, `fix-relay-history-sse-gaps` — all relay-specific failure modes that don't exist in direct SSE.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Core chat hook; relay branching at line 406
  - `apps/client/src/layers/shared/lib/transport/http-transport.ts` — Dual transport methods
  - `apps/server/src/routes/sessions.ts` — Dual POST paths, `publishViaRelay()`, `stream_ready`
  - `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts` — Relay fan-in via `subscribeToRelay()`

- **Shared dependencies:**
  - `packages/shared/src/transport.ts` — Transport interface (both methods stay)
  - `@dorkos/relay` — RelayCore (stays, used by external adapters)
  - `apps/client/src/layers/entities/relay/` — Relay entity hooks (stay for UI)

- **Data flow (current relay path):**

  ```
  Client useChatSession.executeSubmission()
    → correlationId = crypto.randomUUID()
    → waitForStreamReady(5000ms)
    → transport.sendMessageRelay(sessionId, content, {clientId, correlationId})
    → POST /api/sessions/:id/messages → 202
    → publishViaRelay() → relay bus → CCA → runtime.sendMessage()
    → Response chunks → relay.human.console.{clientId}
    → SessionBroadcaster.subscribeToRelay() → SSE stream
  ```

- **Data flow (direct SSE — the keeper):**

  ```
  Client useChatSession.executeSubmission()
    → transport.sendMessage(sessionId, content, onEvent, signal)
    → POST /api/sessions/:id/messages
    → Server streams SSE on POST response body
    → Client receives events inline
  ```

- **Feature flags/config:**
  - `DORKOS_RELAY_ENABLED` — server env var
  - `config.relay.enabled` — exposed to client via `GET /api/config`
  - `useRelayEnabled()` — client hook (stays, but no longer used by chat)

- **Potential blast radius:**
  - Direct: 4 files (use-chat-session.ts, sessions.ts, session-broadcaster.ts, http-transport.ts)
  - Naming cleanup: sessions.ts comments, use-chat-session.ts comments
  - Tests: use-chat-session-relay.test.ts (remove), sessions-relay.test.ts (update), session-broadcaster tests (update)
  - Total: ~200-300 lines removed

## 4) Root Cause Analysis

Not applicable — this is an architectural simplification, not a bug fix.

## 5) Research

Research saved to: `research/20260312_client_direct_sse_relay_removal.md`

**Potential solutions:**

1. **Clean removal (Approach A)** — Remove all relay code paths from client and server for the web client use case. External adapters unaffected.
   - Pros: No dead code, simpler codebase, eliminates all relay streaming bugs, one code path to reason about
   - Cons: Larger diff, requires careful testing
   - Complexity: Medium
   - Maintenance: Low (less code to maintain)

2. **Feature flag toggle (Approach B)** — Keep relay code but default to SSE. Allow opt-in to relay via config.
   - Pros: Easy rollback
   - Cons: Keeps dead code, both paths must be maintained, doesn't solve the complexity problem
   - Complexity: Low
   - Maintenance: High (two code paths forever)

3. **Phased removal (Approach C)** — Phase 1: default to SSE. Phase 2: remove relay code after validation.
   - Pros: Conservative
   - Cons: Unnecessary — direct SSE is already proven stable, the relay path is the one with bugs
   - Complexity: Medium
   - Maintenance: Medium

**Recommendation:** Clean removal (Approach A). The direct SSE path has been stable throughout — every streaming bug in the codebase was relay-specific. There's no risk in "falling back" because SSE is the proven path. Keeping relay code as dead code just adds confusion.

**Key insight from research:** External adapter messages (Telegram → CCA → runtime → JSONL → file watcher → SSE) already work without the web client being on the relay bus. The JSONL file is the bridge. The relay fan-in in SessionBroadcaster was only for the web client's own relay messages, not for external adapter messages.

## 6) Decisions

| #   | Decision            | Choice                                     | Rationale                                                                                                                                                                                                      |
| --- | ------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Removal depth       | Full stack removal                         | Server-side relay code for the web client (publishViaRelay, 202 path, SessionBroadcaster relay fan-in, stream_ready) is dead code that won't be reused. External adapters use completely different code paths. |
| 2   | Transport interface | Keep `sendMessageRelay()`, stop calling it | Avoids breaking change to the interface while relay feature settles. DirectTransport already has a no-op implementation.                                                                                       |
| 3   | Naming cleanup      | Rename "legacy" labels in this work        | SSE is now the primary and only client transport. Calling it "legacy" is confusing and contradicts the intent of this change.                                                                                  |
