# SSE Connection Optimization — Phase 1: Consolidate

**Spec:** `specs/sse-connection-optimization-01-consolidate/02-specification.md`
**Generated:** 2026-03-27
**Mode:** Full
**Tasks:** 8

---

## Phase 1: Server Fan-Out Service

Foundation phase — creates the server-side infrastructure for the unified SSE stream. No client changes.

| ID  | Task                                                            | Size   | Priority | Dependencies | Parallel |
| --- | --------------------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 1.1 | Create EventFanOut service with client management and broadcast | Medium | High     | —            | —        |
| 1.2 | Create unified GET /api/events SSE endpoint and mount route     | Medium | High     | 1.1          | —        |
| 1.3 | Wire tunnel, extension, and relay event sources to EventFanOut  | Medium | High     | 1.1          | —        |

### 1.1 — Create EventFanOut service

**File:** `apps/server/src/services/core/event-fan-out.ts`

Lightweight in-process broadcaster that manages a `Set<Response>` and distributes SSE events to all connected clients. Enforces `SSE.MAX_TOTAL_CLIENTS` (500) limit, handles backpressure (write returns false), prunes dead clients, and catches write errors. Exported as singleton `eventFanOut`.

**Tests:** `apps/server/src/services/core/__tests__/event-fan-out.test.ts` — 6 unit tests covering add/remove, max clients (503), dead client pruning, write errors, backpressure, and client count.

### 1.2 — Create unified GET /api/events SSE endpoint

**Files:** `apps/server/src/routes/events.ts` (new), `apps/server/src/app.ts` (modified)

Single `GET /api/events` endpoint using `initSSEStream` for standardized headers. Sends `event: connected` on connection, heartbeat every 15s via `SSE.HEARTBEAT_INTERVAL_MS`, cleanup on disconnect. Mounted in `app.ts` at `/api/events`.

**Tests:** `apps/server/src/routes/__tests__/events.test.ts` — integration tests with supertest for SSE headers, connected event, and client registration.

### 1.3 — Wire event sources to EventFanOut

**Files:** `apps/server/src/index.ts` (modified), `apps/server/src/routes/extensions.ts` (modified)

- **Tunnel:** `tunnelManager.on('status_change')` -> `eventFanOut.broadcast('tunnel_status', status)` in index.ts
- **Extensions:** `broadcastExtensionReloaded()` updated to call `eventFanOut.broadcast()` while preserving old `sseClients` broadcast for backward compat
- **Relay:** `relayCore.subscribe('relay.human.console.>')` and `relayCore.onSignal()` -> `eventFanOut.broadcast()` in index.ts relay-enabled block

---

## Phase 2: Client Event Stream Provider

Creates the React context that manages the single SSEConnection and exposes a subscription API.

| ID  | Task                                                     | Size  | Priority | Dependencies | Parallel |
| --- | -------------------------------------------------------- | ----- | -------- | ------------ | -------- |
| 2.1 | Create EventStreamProvider context with subscription API | Large | High     | 1.2          | —        |

### 2.1 — Create EventStreamProvider

**Files:**

- `apps/client/src/layers/shared/model/event-stream-context.tsx` (new)
- `apps/client/src/layers/shared/model/index.ts` (modified — add exports)
- `apps/client/src/main.tsx` (modified — add provider)

Three exports: `EventStreamProvider`, `useEventStream`, `useEventSubscription`.

- `EventStreamProvider` creates one `SSEConnection` to `/api/events` on mount with visibility optimization
- `useEventStream` returns `{ subscribe, connectionState, failedAttempts }`
- `useEventSubscription(eventName, handler)` is a convenience hook with ref-stabilized handler

Provider placed in main.tsx between `TransportProvider` and `ExtensionProvider` (must mount before ExtensionProvider).

**Tests:** `apps/client/src/layers/shared/model/__tests__/event-stream-context.test.tsx` — 7 tests covering mount/destroy, throws outside provider, state changes, event dispatch, unmount cleanup, and multiple subscribers.

---

## Phase 3: Consumer Migration

Migrate each existing SSE consumer to use the unified stream. All three migrations are independent and can run in parallel.

| ID  | Task                                                                      | Size   | Priority | Dependencies | Parallel |
| --- | ------------------------------------------------------------------------- | ------ | -------- | ------------ | -------- |
| 3.1 | Migrate useTunnelSync from raw EventSource to useEventSubscription        | Medium | High     | 2.1          | 3.2, 3.3 |
| 3.2 | Migrate ExtensionProvider from raw EventSource to useEventSubscription    | Medium | High     | 2.1          | 3.1, 3.3 |
| 3.3 | Migrate useRelayEventStream from useSSEConnection to useEventSubscription | Small  | High     | 2.1          | 3.1, 3.2 |

### 3.1 — Migrate useTunnelSync

**File:** `apps/client/src/layers/entities/tunnel/model/use-tunnel-sync.ts`

Remove raw `new EventSource('/api/tunnel/stream')`. Replace with `useEventSubscription('tunnel_status', handler)`. BroadcastChannel cross-tab sync unchanged.

**Tests:** Updated `use-tunnel-sync.test.tsx` — mock `useEventSubscription` instead of global `EventSource`.

### 3.2 — Migrate ExtensionProvider

**File:** `apps/client/src/layers/features/extensions/model/extension-context.tsx`

Remove the SSE useEffect creating `new EventSource('/api/extensions/events')`. Replace with `useEventSubscription('extension_reloaded', handler)`. Field name reconciliation: use `extensionIds` (matching server) instead of `extensions`.

### 3.3 — Migrate useRelayEventStream

**File:** `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`

Remove `useSSEConnection(url, { eventHandlers })`. Replace with `useEventStream()` for connection state + `useEventSubscription` for `relay_message` and `relay_delivery`. The `pattern` parameter becomes a no-op (prefixed with `_`). The `enabled` flag gates handler logic instead of connection lifecycle.

---

## Phase 4: Deprecation Markers

Add deprecation warnings and verify the complete implementation.

| ID  | Task                                                     | Size  | Priority | Dependencies       | Parallel |
| --- | -------------------------------------------------------- | ----- | -------- | ------------------ | -------- |
| 4.1 | Add deprecation warnings to old SSE endpoints            | Small | Medium   | 3.1, 3.2, 3.3      | 4.2      |
| 4.2 | Verify end-to-end SSE consolidation and connection count | Small | Medium   | 3.1, 3.2, 3.3, 4.1 | —        |

### 4.1 — Deprecation warnings

**Files:** `apps/server/src/routes/tunnel.ts`, `apps/server/src/routes/extensions.ts`, `apps/server/src/routes/relay.ts`

Add `logger.warn` deprecation messages and `@deprecated` JSDoc annotations to the SSE handler in each file. Endpoints remain functional. The relay deprecation notes that external adapters may continue using that endpoint.

### 4.2 — End-to-end verification

Run full test suite, typecheck, and lint. Manual verification: confirm 1 SSE connection with no session, 2 with active session. Verify tunnel toggle, extension reload, relay messages, and tool approval all work through the unified stream. Verify old endpoints still respond with deprecation warnings in logs.

---

## Dependency Graph

```
1.1 (EventFanOut service)
 ├── 1.2 (GET /api/events endpoint)
 │    └── 2.1 (EventStreamProvider)
 │         ├── 3.1 (Migrate tunnel)    ─┐
 │         ├── 3.2 (Migrate extensions) ├── parallel
 │         └── 3.3 (Migrate relay)     ─┘
 │              └── 4.1 (Deprecation warnings)
 │                   └── 4.2 (E2E verification)
 └── 1.3 (Wire event sources)
```

## Connection Budget Impact

**Before:** 4 persistent SSE connections + 1 POST stream = 5 of 6 HTTP/1.1 slots occupied

**After:** 2 persistent SSE connections + 1 POST stream = 3 of 6 slots occupied (3 free for tool approvals and API requests)
