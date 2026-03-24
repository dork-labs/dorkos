# SSE Resilience & Connection Health — Task Breakdown

**Spec:** `specs/sse-resilience-connection-health/02-specification.md`
**Generated:** 2026-03-24
**Mode:** Full decomposition (4 phases, 12 tasks)

---

## Phase 1: Foundation

Shared types, constants, SSEConnection class, useSSEConnection hook, server heartbeat.

### Task 1.1 — Add ConnectionState type and SSE resilience constants

**Size:** Small | **Priority:** High | **Dependencies:** None

Add `ConnectionState` type to `@dorkos/shared/types`, `HEARTBEAT_INTERVAL_MS` to the server SSE constants, and a new `SSE_RESILIENCE` object to client constants with all tuning parameters (backoff base/cap, watchdog timeout, visibility grace period, retry config).

**Files:**

- `packages/shared/src/types.ts`
- `apps/server/src/config/constants.ts`
- `apps/client/src/layers/shared/lib/constants.ts`
- `apps/client/src/layers/shared/lib/index.ts`

---

### Task 1.2 — Implement SSEConnection class

**Size:** Large | **Priority:** High | **Dependencies:** 1.1

Create a framework-agnostic `SSEConnection` class in `shared/lib/transport/` that manages a single EventSource connection with:

- State machine: connecting → connected → reconnecting → disconnected
- Full-jitter exponential backoff (500ms base, 30s cap)
- Heartbeat watchdog (45s timeout, resets on any named event)
- Page visibility optimization (30s grace period)
- Stability window (10s connected resets failure counter)
- Clean destroy with timer and listener cleanup

**Files:**

- `apps/client/src/layers/shared/lib/transport/sse-connection.ts`

---

### Task 1.3 — Write SSEConnection class unit tests

**Size:** Large | **Priority:** High | **Dependencies:** 1.2

Comprehensive tests using a mock EventSource with `vi.useFakeTimers()`. Covers state transitions, backoff calculation, watchdog timeout/reset, visibility grace period, stability window, destroy cleanup, and multiple rapid state changes. At least 15 test cases.

**Files:**

- `apps/client/src/layers/shared/lib/transport/__tests__/sse-connection.test.ts`

---

### Task 1.4 — Implement useSSEConnection React hook

**Size:** Medium | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 1.3

Thin React wrapper around SSEConnection. Manages lifecycle (create on mount, destroy on unmount), exposes `connectionState`/`failedAttempts`/`lastEventAt` as state, uses ref-wrapped handlers to prevent reconnection on identity changes, and enables visibility optimization by default. Null-safe URL (no connection when null).

**Files:**

- `apps/client/src/layers/shared/model/use-sse-connection.ts`
- `apps/client/src/layers/shared/model/index.ts`

---

### Task 1.5 — Write useSSEConnection hook unit tests

**Size:** Medium | **Priority:** High | **Dependencies:** 1.4

Tests using `renderHook` with mocked SSEConnection class. Covers: creation, null URL, unmount cleanup, URL change reconnection, handler identity stability, visibility opt-in/out, state exposure.

**Files:**

- `apps/client/src/layers/shared/model/__tests__/use-sse-connection.test.ts`

---

### Task 1.6 — Add server heartbeat to session sync endpoint

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1 | **Parallel with:** 1.2, 1.3, 1.4

Modify GET `/api/sessions/:id/stream` to:

1. Send `retry: 3000` hint on initial connection
2. Send `event: heartbeat\ndata: {}\n\n` every 15s via setInterval
3. Add `id:` field to sync_update and presence_update events
4. Clean up heartbeat interval on connection close

**Files:**

- `apps/server/src/routes/sessions.ts`

---

## Phase 2: POST Chat Stream Retry

Retry logic for POST message streaming, preserving partial responses.

### Task 2.1 — Add POST chat stream retry logic to executeSubmission

**Size:** Large | **Priority:** High | **Dependencies:** 1.1

Modify `executeSubmission` in `useChatSession` to:

- Auto-retry transient errors (network, 5xx, timeout) once after 2s delay
- Skip retry for AbortError, SESSION_LOCKED, and non-retryable 4xx errors
- Preserve partial assistant response during retry
- Remove optimistic user message only on final failure
- Add `retryMessage` callback for manual retry from error banner
- Track retry count via ref, reset on terminal states

**Files:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts`

---

### Task 2.2 — Write POST chat stream retry tests

**Size:** Medium | **Priority:** High | **Dependencies:** 2.1

Tests for retry behavior using `renderHook` with mock transport. Covers: auto-retry on network error, no-retry for 4xx/lock/abort, partial response preservation, user message removal, retryMessage callback, counter reset.

**Files:**

- `apps/client/src/layers/features/chat/model/__tests__/chat-retry.test.ts`

---

## Phase 3: Consumer Refactors

Migrate existing SSE consumers to the shared primitive.

### Task 3.1 — Refactor useRelayEventStream to use useSSEConnection

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.4 | **Parallel with:** 3.2

Replace bespoke EventSource management with `useSSEConnection`. Reduces file from 67 to ~25 lines. Add `RelayConnectionState` type alias for backward compat. Gains backoff, watchdog, and visibility optimization.

**Files:**

- `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`
- `apps/client/src/layers/entities/relay/index.ts`

---

### Task 3.2 — Refactor session sync in useChatSession to use useSSEConnection

**Size:** Medium | **Priority:** Medium | **Dependencies:** 1.4, 1.6 | **Parallel with:** 3.1

Replace bare EventSource effect (lines 286-326) with `useSSEConnection`. Build sync URL as a memo (null during streaming or when sync disabled). Return `syncConnectionState` and `syncFailedAttempts` for UI consumption.

**Files:**

- `apps/client/src/layers/features/chat/model/use-chat-session.ts`

---

## Phase 4: UI

Connection health surfaces in the UI.

### Task 4.1 — Generalize ConnectionStatusBanner and move to shared layer

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 4.2

Move `ConnectionStatusBanner` from `features/relay/ui/` to `shared/ui/`. Change type from `RelayConnectionState` to `ConnectionState`. Add `failedAttempts`/`maxAttempts` props for attempt display. Leave re-export in relay feature for backward compat.

**Files:**

- `apps/client/src/layers/shared/ui/ConnectionStatusBanner.tsx`
- `apps/client/src/layers/shared/ui/index.ts`
- `apps/client/src/layers/features/relay/ui/ConnectionStatusBanner.tsx`

---

### Task 4.2 — Create ConnectionItem for StatusLine

**Size:** Small | **Priority:** Medium | **Dependencies:** 1.1 | **Parallel with:** 4.1

New StatusLine item showing connection health as a colored dot (emerald/amber/red) with label and tooltip. Only visible when NOT connected (zero visual overhead in normal state). Pulsing animation for connecting/reconnecting states.

**Files:**

- `apps/client/src/layers/features/status/ui/ConnectionItem.tsx`
- `apps/client/src/layers/features/status/index.ts`

---

### Task 4.3 — Wire ConnectionItem into StatusLine and add chat retry button

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.2, 4.2, 2.1

Thread `syncConnectionState`/`syncFailedAttempts` to StatusLine render site in the widget layer. Add ConnectionItem as a StatusLine child. Add Retry button to chat error banner when `error.retryable` is true, calling `retryMessage` with last user message content.

**Files:**

- Widget that renders StatusLine (search for `<StatusLine`)
- Chat error banner component

---

## Dependency Graph

```
1.1 ─────────────────────────────────────────────┐
 │                                                │
 ├─→ 1.2 ──→ 1.3                                 │
 │    │                                           │
 │    └──→ 1.4 ──→ 1.5                           │
 │          │                                     │
 │          ├──→ 3.1 ─┐                           │
 │          │         │                           │
 │          └──→ 3.2 ─┤ (parallel)                │
 │                │   │                           │
 ├─→ 1.6 ────────┘   │                           │
 │                    │                           │
 ├─→ 2.1 ──→ 2.2     │                           │
 │    │               │                           │
 ├─→ 4.1 ─┐          │                           │
 │         │          │                           │
 └─→ 4.2 ─┤ (parallel)                           │
           │          │                           │
           └──→ 4.3 ←┘                           │
                 ↑                                │
                 └── 2.1, 3.2                     │
```

## Summary

| Phase                  | Tasks  | Size Breakdown                       |
| ---------------------- | ------ | ------------------------------------ |
| P1: Foundation         | 6      | 1 small, 2 medium, 2 large, 1 medium |
| P2: POST Retry         | 2      | 1 large, 1 medium                    |
| P3: Consumer Refactors | 2      | 2 medium                             |
| P4: UI                 | 3      | 2 small, 1 medium                    |
| **Total**              | **13** | 3 small, 6 medium, 3 large           |
