---
slug: sse-resilience-connection-health
number: 174
created: 2026-03-24
status: ideation
---

# SSE Resilience & Connection Health

**Slug:** sse-resilience-connection-health
**Author:** Claude Code
**Date:** 2026-03-24
**Branch:** preflight/sse-resilience-connection-health

---

## 1) Intent & Assumptions

- **Task brief:** Build comprehensive SSE resilience infrastructure across all three SSE connection types (POST message streaming, GET session sync, GET relay stream). Priority is the POST chat response stream — the most-used feature. Extract a shared resilience primitive, add server-side heartbeats, implement reconnection with exponential backoff, surface connection health in the UI via StatusLine, and optimize for page visibility.

- **Assumptions:**
  - The server runs on localhost (local-first architecture), so network failures are less frequent than cloud-hosted apps, but still happen (laptop sleep/wake, Docker restarts, dev server restarts)
  - The existing `ConnectionStatusBanner` in Relay is a good pattern to generalize
  - The existing `useTabVisibility` hook can be leveraged for page visibility optimization
  - `classifyTransportError` already categorizes errors correctly — we build on it, not replace it
  - The POST message stream is fundamentally different from persistent GET streams (one-shot vs long-lived), requiring different resilience strategies

- **Out of scope:**
  - WebSocket fallback or WebTransport adoption
  - Service Worker SSE proxying
  - Server-side replay buffer for `Last-Event-ID` (sync events are invalidation signals, not data)
  - Changes to the Obsidian plugin's `DirectTransport` (no SSE involved)
  - MCP endpoint SSE resilience (separate concern)

## 2) Pre-reading Log

- `apps/server/src/services/core/stream-adapter.ts`: SSE wire format helpers (initSSEStream, sendSSEEvent, endSSEStream). Has backpressure handling. No heartbeat support.
- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`: File watcher + multi-client SSE broadcast. No heartbeat/keepalive. Has connection limits (10/session, 500 total). chokidar-based with debouncing.
- `apps/server/src/routes/sessions.ts` (lines 298-326): GET `/api/sessions/:id/stream` endpoint. Sends `sync_connected` on open. No heartbeat, no `id:` field on events, no `retry:` field.
- `apps/server/src/routes/relay.ts`: GET `/api/relay/stream` endpoint. Has 15s keepalive (`: keepalive\n\n`). Has backpressure handling with subscription pause/resume.
- `apps/client/src/layers/shared/lib/transport/sse-parser.ts`: Async generator SSE parser. Handles partial buffers, multi-line events. Used by POST message streaming only.
- `apps/client/src/layers/shared/lib/transport/http-transport.ts`: POST-based message streaming via fetch + ReadableStream. Uses `parseSSEStream`. Has AbortController support.
- `apps/client/src/layers/features/chat/model/use-chat-session.ts`: 545 lines. Two SSE connection types: POST streaming (lines 398-441) and GET persistent sync (lines 286-326). Sync uses native `EventSource` with zero reconnection logic, no error handlers, no heartbeat watchdog.
- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`: 67 lines. Native `EventSource` with connection state tracking (`connected`/`reconnecting`/`disconnected`), failed attempt counter, threshold of 3.
- `apps/client/src/layers/features/relay/ui/ConnectionStatusBanner.tsx`: 41 lines. Inline banner with Wifi/WifiOff icons, amber (reconnecting) and red (disconnected) states.
- `apps/client/src/layers/features/relay/lib/status-colors.ts`: Status color mapping including `reconnecting` state.
- `apps/client/src/layers/features/session-list/model/use-connections-status.ts`: Aggregate connection status for sidebar badge dot.
- `contributing/design-system.md`: Calm Tech design language reference — motion specs, color tokens, spacing.
- `contributing/animations.md`: Motion library patterns for enter/exit animations.
- `research/20260324_sse_resilience_production_patterns.md`: Comprehensive research on SSE best practices.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/services/core/stream-adapter.ts` — SSE wire helpers (needs heartbeat support)
- `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts` — File watcher + broadcast (needs keepalive timer)
- `apps/server/src/routes/sessions.ts` — Session sync SSE endpoint (needs heartbeat interval)
- `apps/server/src/routes/relay.ts` — Relay SSE endpoint (already has keepalive, reference implementation)
- `apps/client/src/layers/shared/lib/transport/sse-parser.ts` — Wire protocol parser (unchanged)
- `apps/client/src/layers/shared/lib/transport/http-transport.ts` — POST message streaming (needs retry logic)
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — Chat hook (needs: sync connection resilience, POST retry)
- `apps/client/src/layers/features/chat/model/chat-types.ts` — Chat type definitions
- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts` — Relay SSE hook (refactor to shared primitive)
- `apps/client/src/layers/features/relay/ui/ConnectionStatusBanner.tsx` — Banner component (generalize)
- `apps/client/src/layers/features/status/ui/StatusLine.tsx` — StatusLine component (add connection indicator)

**Shared Dependencies:**

- `apps/client/src/layers/shared/model/use-tab-visibility.ts` — Page visibility hook (leverage for SSE optimization)
- `apps/client/src/layers/shared/lib/cn.ts` — Class name utility
- `apps/client/src/layers/shared/lib/index.ts` — QUERY_TIMING, TIMING constants
- `apps/server/src/config/constants.ts` — SSE limits, watcher config

**Data Flow:**

```
Client EventSource → HTTP GET → Express route → initSSEStream →
  chokidar file watcher → broadcastUpdate → res.write(SSE event) →
  Client EventSource.onmessage → TanStack Query invalidation → refetch

Client fetch POST → Express route → AgentRuntime.sendMessage →
  SDK streaming → sendSSEEvent(res, event) →
  Client ReadableStream → parseSSEStream → streamEventHandler → setState
```

**Feature Flags/Config:**

- `enableCrossClientSync` — App store flag controlling session sync SSE
- `enableMessagePolling` — Fallback polling when SSE is unavailable
- `SSE.MAX_CLIENTS_PER_SESSION` (10), `SSE.MAX_TOTAL_CLIENTS` (500)

**Potential Blast Radius:**

- Direct: ~10 files (new SSEConnection class, new hook, server heartbeat additions, StatusLine, refactored relay hook, chat session hook, ConnectionStatusBanner generalization)
- Indirect: StatusLine consumers, ConnectionsTab, sidebar badge dot
- Tests: New tests for SSEConnection class, updated tests for relay hook, connection status tests

## 4) Root Cause Analysis

N/A — This is a feature/enhancement, not a bug fix.

## 5) Research

Research report saved to `research/20260324_sse_resilience_production_patterns.md`.

**Potential Solutions:**

**1. Shared SSEConnection Class + Hook (Selected)**

- Description: Extract a reusable `SSEConnection` class with state machine, exponential backoff with full jitter, heartbeat watchdog, and page visibility optimization. Wrap in a `useSSEConnection` hook for React consumption.
- Pros:
  - Class is testable in isolation without React
  - State machine is explicit and debuggable
  - Reusable across relay, session sync, and any future SSE consumers
  - Separation of concerns (transport logic vs React lifecycle)
- Cons:
  - More files than a hook-only approach
  - Class + hook pattern is slightly more complex to understand at first
- Complexity: Medium
- Maintenance: Low (well-tested class, thin hook wrapper)

**2. Hook-Only Approach**

- Description: All logic in a single `useSSEConnection` hook using `useReducer` for state machine.
- Pros: Fewer files, familiar React pattern
- Cons: Hard to unit test backoff/reconnection in isolation, tightly coupled to React lifecycle
- Complexity: Medium
- Maintenance: Medium

**3. Singleton SSEConnectionManager**

- Description: Module-level class managing a `Map<url, SSEConnection>` with Zustand store for reactive state.
- Pros: Connections survive route changes, shared across components
- Cons: Adds indirection, new Zustand store, overkill for session-scoped connections
- Complexity: High
- Maintenance: Medium-High

**Security Considerations:**

- SSE connections carry session IDs in URLs — ensure these aren't leaked in error messages or logs
- Reconnection should re-validate that the session still exists (handle 404 gracefully)
- Auto-retry on POST message stream must not cause duplicate message submission

**Performance Considerations:**

- Page visibility optimization reduces server resource usage (watchers, connections) for background tabs
- Heartbeat watchdog timer uses minimal resources (single setTimeout per connection)
- Exponential backoff with full jitter prevents thundering herd on server restart
- 30s grace period before closing background tab SSE prevents reconnection churn during brief tab switches

**Recommendation:**

**Recommended Approach:** Shared SSEConnection class + hook

**Rationale:**
The class encapsulates complex state machine logic (connecting → connected → reconnecting → disconnected) with exponential backoff, heartbeat watchdog, and page visibility handling — all of which are transport concerns, not React concerns. The hook is a thin wrapper that manages lifecycle (create on mount, destroy on unmount) and exposes reactive state. This gives the best of both worlds: testable, reusable transport logic and clean React integration.

**Caveats:**

- POST message streaming (chat responses) uses fetch + ReadableStream, not EventSource, so SSEConnection won't apply there. POST retry logic is a separate concern handled in `http-transport.ts` / `use-chat-session.ts`.

## 6) Decisions

| #   | Decision                              | Choice                                      | Rationale                                                                                                                                                                                                                  |
| --- | ------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Connection health UI location         | StatusLine integration + degraded banner    | StatusLine already shows streaming status and system info. Connection health is a natural addition. Degraded state promotes to a Tier 2 banner above StatusLine when action is needed. Follows Slack/Linear patterns.      |
| 2   | Shared resilience primitive structure | SSEConnection class + useSSEConnection hook | Class is testable in isolation, handles state machine/backoff/watchdog. Hook wraps it for React lifecycle. Both relay and session sync refactor to use this. Best DX.                                                      |
| 3   | Page visibility optimization          | Close when hidden (30s grace)               | Prevents zombie connections in background tabs. Leverages existing `useTabVisibility`. TanStack Query refetch catches missed events on reconnect. Grace period prevents churn on brief tab switches.                       |
| 4   | POST chat stream failure handling     | Auto-retry with user control                | Transient errors (network, 5xx) auto-retry once after 2s. Permanent errors (4xx, session locked) show banner only. Partial response preserved. Retry button for user control. Builds on existing `classifyTransportError`. |

## 7) Implementation Scope

### Server-Side (3 changes)

1. **Add heartbeat to session sync endpoint** — Send `: keepalive\n\n` every 15s on GET `/api/sessions/:id/stream`, matching the relay endpoint pattern
2. **Add `id:` field to sync events** — Enable native `Last-Event-ID` forwarding on reconnect (future-proofing, no replay buffer needed yet)
3. **Send `retry:` field on connect** — Tell client to use 3000ms as base reconnection delay

### Client-Side — Shared Layer (2 new files)

4. **`shared/lib/transport/sse-connection.ts`** — SSEConnection class:
   - State machine: `connecting → connected → reconnecting → disconnected`
   - Exponential backoff with full jitter: `BASE=500ms`, `CAP=30_000ms`
   - Heartbeat watchdog: 45s timeout (3× server keepalive interval)
   - Page visibility: close after 30s grace, reconnect immediately on visible
   - Event emitter for state changes, incoming events
   - Configurable: heartbeat timeout, backoff params, visibility optimization, max retries

5. **`shared/model/use-sse-connection.ts`** — useSSEConnection hook:
   - Creates/destroys SSEConnection on mount/unmount
   - Exposes `{ connectionState, failedAttempts, lastEventAt }`
   - Integrates with `useTabVisibility`
   - Stable callback refs for event handlers

### Client-Side — Refactors (3 files)

6. **Refactor `use-relay-event-stream.ts`** — Replace bespoke EventSource management with `useSSEConnection`
7. **Refactor `use-chat-session.ts`** (sync portion, lines 286-326) — Replace bare EventSource with `useSSEConnection`
8. **Add POST retry logic to `use-chat-session.ts`** — Auto-retry transient errors once after 2s, preserve partial response, show retry button

### Client-Side — UI (3 changes)

9. **Generalize `ConnectionStatusBanner`** — Move from `features/relay/ui/` to `shared/ui/` (or make the type generic). Accept a generic connection state type.
10. **Add connection indicator to StatusLine** — Show connection dot (green/amber/red) in StatusLine. Promote to banner on disconnect.
11. **Add retry action to error banner** — When POST stream fails with a retryable error, show "Connection interrupted" banner with Retry/Dismiss buttons

### Constants & Types

12. **Add SSE resilience constants** — `HEARTBEAT_INTERVAL_MS` (15000), `HEARTBEAT_TIMEOUT_MS` (45000), `BACKOFF_BASE_MS` (500), `BACKOFF_CAP_MS` (30000), `VISIBILITY_GRACE_MS` (30000), `DISCONNECTED_THRESHOLD` (5), `POST_RETRY_DELAY_MS` (2000)
13. **Add shared `ConnectionState` type** — `'connecting' | 'connected' | 'reconnecting' | 'disconnected'` in shared types, replacing the relay-specific `RelayConnectionState`
