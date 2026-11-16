---
slug: sse-connection-optimization-01-consolidate
number: 187
created: 2026-03-27
status: implemented
project: sse-connection-optimization
phase: 1
---

# Phase 1: Consolidate SSE Connections

**Status:** Specified
**Authors:** Claude Code
**Date:** 2026-03-27
**Branch:** feat/sse-connection-consolidate

---

## Table of Contents

1. [Overview](#1-overview)
2. [Background / Problem Statement](#2-background--problem-statement)
3. [Goals](#3-goals)
4. [Non-Goals](#4-non-goals)
5. [Technical Design](#5-technical-design)
6. [Data Flow](#6-data-flow)
7. [Implementation Phases](#7-implementation-phases)
8. [File Changes](#8-file-changes)
9. [Testing Strategy](#9-testing-strategy)
10. [Acceptance Criteria](#10-acceptance-criteria)
11. [Risks & Mitigations](#11-risks--mitigations)

---

## 1. Overview

DorkOS opens up to 4 persistent `EventSource` connections per browser tab: tunnel status (`/api/tunnel/stream`), extension lifecycle (`/api/extensions/events`), relay events (`/api/relay/stream`), and per-session sync (`/api/sessions/:id/stream`). Combined with the active message POST stream, this exhausts the browser's 6-connection-per-origin HTTP/1.1 limit. When all slots are occupied, tool approval POST requests queue behind them and time out.

This spec consolidates the 3 global SSE connections (tunnel, extensions, relay) into a single `GET /api/events` endpoint. The session sync stream stays separate because it is session-scoped and only active when a session is open. This drops persistent connections from 4 to 2, freeing 2 connection slots for normal HTTP requests (tool approvals, API calls, fetches).

The approach uses the SSE spec's built-in `event:` field for type routing, which the existing `SSEConnection` class already supports via its `eventHandlers` map. On the server, a lightweight fan-out service listens to the existing `EventEmitter` sources (tunnel manager, extension broadcaster, relay core) and writes to a shared set of SSE response objects. No new dependencies, no protocol changes, no external infrastructure.

---

## 2. Background / Problem Statement

### HTTP/1.1 Connection Exhaustion

Browsers enforce a hard limit of 6 concurrent TCP connections per origin under HTTP/1.1. `EventSource` connections hold their slot open indefinitely. The current connection budget:

```
Connection 1: EventSource /api/tunnel/stream         (tunnel status)
Connection 2: EventSource /api/extensions/events      (extension lifecycle)
Connection 3: EventSource /api/relay/stream           (relay messages)
Connection 4: EventSource /api/sessions/:id/stream    (session sync)
Connection 5: POST /api/sessions/:id/messages         (active message stream)
Connection 6: [ONLY ONE SLOT FOR ALL OTHER REQUESTS]
```

With only 1 remaining slot, any concurrent fetch competes with tool approval POSTs. The tool approval request queues behind other pending requests and the 10-minute timeout (`SESSIONS.INTERACTION_TIMEOUT_MS`) can expire before the POST reaches the server.

### After Consolidation

```
Connection 1: EventSource /api/events                 (tunnel + extensions + relay)
Connection 2: EventSource /api/sessions/:id/stream    (session sync)
Connection 3: POST /api/sessions/:id/messages         (active message stream)
Connections 4-6: [THREE SLOTS FOR NORMAL REQUESTS]
```

Three free slots eliminates the tool approval timeout under normal operation.

---

## 3. Goals

- Reduce persistent SSE connections from 4 to 2 per browser tab
- Preserve all existing event names and data shapes (no breaking changes for consumers)
- Reuse the `SSEConnection` class and `initSSEStream`/`sendSSEEvent` infrastructure
- Maintain the BroadcastChannel cross-tab tunnel sync alongside the unified stream
- Provide a clean React context API for consumers to subscribe to specific event types
- Deprecate and remove the 3 individual SSE endpoints

---

## 4. Non-Goals

- Consolidating the session sync stream (`GET /api/sessions/:id/stream`) -- it is session-scoped by design
- Replacing `EventSource` with `fetch()` + `ReadableStream` (Phase 2 scope)
- HTTP/2 server migration or WebSocket adoption
- Selective server-side subscription filtering (`?subscribe=` param) -- always send everything in v1
- Changes to the Obsidian plugin (uses `DirectTransport`, unaffected by HTTP transport)

---

## 5. Technical Design

### 5.1 Server: Unified Event Stream Endpoint

Create `apps/server/src/routes/events.ts` with a single `GET /api/events` endpoint.

```typescript
// apps/server/src/routes/events.ts
import { Router } from 'express';
import { initSSEStream } from '../services/core/stream-adapter.js';
import { SSE } from '../config/constants.js';
import { eventFanOut } from '../services/core/event-fan-out.js';

const router = Router();

router.get('/', (req, res) => {
  initSSEStream(res);

  // Register this client with the fan-out service
  const unsubscribe = eventFanOut.addClient(res);

  // Send initial connection confirmation
  res.write(
    `event: connected\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`
  );

  // Shared heartbeat at server interval
  const keepalive = setInterval(() => {
    if (res.writableEnded) {
      clearInterval(keepalive);
      return;
    }
    try {
      res.write(`: keepalive\n\n`);
    } catch {
      clearInterval(keepalive);
    }
  }, SSE.HEARTBEAT_INTERVAL_MS);

  req.on('close', () => {
    clearInterval(keepalive);
    unsubscribe();
  });
});

export default router;
```

Mount in `apps/server/src/app.ts` (or `index.ts` where relay is conditionally mounted):

```typescript
import eventsRouter from './routes/events.js';
app.use('/api/events', eventsRouter);
```

**Key behaviors:**

- Uses `initSSEStream` for standardized SSE headers (including `X-Accel-Buffering: no`)
- Single heartbeat at `SSE.HEARTBEAT_INTERVAL_MS` (15s) serves the whole connection
- Client count is bounded by `SSE.MAX_TOTAL_CLIENTS` (500), enforced in the fan-out service
- A `connected` event fires on initial connection so the client can confirm the stream is alive

### 5.2 Server: Event Fan-Out Service

Create `apps/server/src/services/core/event-fan-out.ts` -- a lightweight in-process broadcaster that collects events from existing sources and distributes them to all connected SSE clients.

```typescript
// apps/server/src/services/core/event-fan-out.ts
import type { Response } from 'express';
import { SSE } from '../../config/constants.js';
import { logger } from '../../lib/logger.js';

class EventFanOut {
  private clients = new Set<Response>();

  /** Register an SSE client. Returns an unsubscribe function. */
  addClient(res: Response): () => void {
    if (this.clients.size >= SSE.MAX_TOTAL_CLIENTS) {
      logger.warn(`[EventFanOut] Max clients reached (${SSE.MAX_TOTAL_CLIENTS}), rejecting`);
      res.status(503).json({ error: 'Too many SSE clients' });
      return () => {};
    }

    this.clients.add(res);

    return () => {
      this.clients.delete(res);
    };
  }

  /** Broadcast an SSE event to all connected clients. */
  broadcast(eventName: string, data: unknown): void {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;

    for (const client of this.clients) {
      if (client.writableEnded) {
        this.clients.delete(client);
        continue;
      }
      try {
        const canContinue = client.write(payload);
        if (!canContinue) {
          // Backpressure: skip events for this client until drained.
          // The client will catch up via query invalidation on reconnect.
          client.once('drain', () => {
            // Resume is implicit -- next broadcast will succeed
          });
        }
      } catch {
        this.clients.delete(client);
      }
    }
  }

  /** Number of currently connected clients. */
  get clientCount(): number {
    return this.clients.size;
  }
}

export const eventFanOut = new EventFanOut();
```

**Backpressure strategy:** Adopts the relay stream's existing write-or-queue pattern. When `res.write()` returns `false` (kernel buffer full), subsequent events are skipped for that client until the `drain` event fires. This is acceptable because all event consumers use TanStack Query cache invalidation -- missed events result in a slightly delayed refetch, not data loss.

### 5.3 Server: Wiring Event Sources to Fan-Out

Each existing event source registers its events with `eventFanOut.broadcast()`. This wiring happens at server startup in `apps/server/src/index.ts`, after the relevant services are initialized.

#### Tunnel Events

```typescript
// In apps/server/src/index.ts, after tunnelManager is available
import { eventFanOut } from './services/core/event-fan-out.js';

// Tunnel status changes -> unified stream
tunnelManager.on('status_change', (status: TunnelStatus) => {
  eventFanOut.broadcast('tunnel_status', status);
});
```

**Initial state:** The tunnel stream currently sends current status immediately on connection (line 48 of `tunnel.ts`). In the unified stream, the client instead fetches `GET /api/tunnel/status` on mount (which it already does via `useTunnelStatus`). The SSE stream only pushes subsequent changes. This avoids sending domain-specific initial state from a generic endpoint.

#### Extension Events

Replace the module-level `sseClients` Set and `broadcastExtensionReloaded` function in `extensions.ts`:

```typescript
// In apps/server/src/routes/extensions.ts
import { eventFanOut } from '../services/core/event-fan-out.js';

export function broadcastExtensionReloaded(extensionIds: string[]): void {
  eventFanOut.broadcast('extension_reloaded', {
    type: 'extension_reloaded',
    extensionIds,
    timestamp: Date.now(),
  });
}
```

The existing `broadcastExtensionReloaded` function signature stays the same -- only the internal broadcast mechanism changes. Callers (extension watcher, reload endpoint) are unaffected.

#### Relay Events

Wire relay subscriptions in `index.ts` after `relayCore` is initialized:

```typescript
// In apps/server/src/index.ts, inside the relay-enabled block
if (relayEnabled && relayCore) {
  // Console-bound messages -> unified stream
  const unsubMessages = relayCore.subscribe('relay.human.console.>', (envelope) => {
    eventFanOut.broadcast('relay_message', envelope);
  });

  // System signals -> unified stream
  const unsubSignals = relayCore.onSignal('relay.human.console.>', (_subject, signal) => {
    const eventType = signal.type === 'backpressure' ? 'relay_backpressure' : 'relay_signal';
    eventFanOut.broadcast(eventType, signal);
  });

  // Send initial connection event
  eventFanOut.broadcast('relay_connected', {
    pattern: 'relay.human.console.>',
    connectedAt: new Date().toISOString(),
  });
}
```

**Note:** The relay stream currently supports `?subject=` query param for server-side filtering. The unified stream always subscribes to `relay.human.console.>` (the default pattern used by the web client). External adapter SSE consumers that need custom subject filtering should continue using `GET /api/relay/stream` directly -- that endpoint is not deprecated for external use.

### 5.4 Event Name Registry

All event names passing through the unified stream, preserved exactly from their original endpoints:

| Event Name           | Source                              | Data Shape                                                    | Original Endpoint        |
| -------------------- | ----------------------------------- | ------------------------------------------------------------- | ------------------------ |
| `connected`          | Fan-out service                     | `{ connectedAt: string }`                                     | New (unified only)       |
| `tunnel_status`      | `tunnelManager.on('status_change')` | `TunnelStatus`                                                | `/api/tunnel/stream`     |
| `extension_reloaded` | `broadcastExtensionReloaded()`      | `{ type: string, extensionIds: string[], timestamp: number }` | `/api/extensions/events` |
| `relay_connected`    | Relay init                          | `{ pattern: string, connectedAt: string }`                    | `/api/relay/stream`      |
| `relay_message`      | `relayCore.subscribe()`             | `RelayEnvelope`                                               | `/api/relay/stream`      |
| `relay_backpressure` | `relayCore.onSignal()`              | `RelaySignal`                                                 | `/api/relay/stream`      |
| `relay_signal`       | `relayCore.onSignal()`              | `RelaySignal`                                                 | `/api/relay/stream`      |

Because event names are preserved, client-side handler code requires zero changes to its event processing logic.

### 5.5 Client: Global Event Stream Provider

Create a React context provider at the `shared` layer that manages the single `SSEConnection` for `/api/events` and exposes a subscription API.

**New file:** `apps/client/src/layers/shared/model/event-stream-context.tsx`

```typescript
// apps/client/src/layers/shared/model/event-stream-context.tsx
import { createContext, useContext, useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import type { ConnectionState } from '@dorkos/shared/types';
import { SSEConnection } from '@/layers/shared/lib/transport';

type EventHandler = (data: unknown) => void;
type Unsubscribe = () => void;

interface EventStreamContextValue {
  /** Subscribe to a specific SSE event type. Returns an unsubscribe function. */
  subscribe: (eventName: string, handler: EventHandler) => Unsubscribe;
  /** Current connection state of the unified stream. */
  connectionState: ConnectionState;
  /** Number of consecutive failed connection attempts. */
  failedAttempts: number;
}

const EventStreamContext = createContext<EventStreamContextValue | null>(null);

export function EventStreamProvider({ children }: { children: ReactNode }) {
  const [connectionState, setConnectionState] = useState<ConnectionState>('connecting');
  const [failedAttempts, setFailedAttempts] = useState(0);
  const connectionRef = useRef<SSEConnection | null>(null);
  const listenersRef = useRef(new Map<string, Set<EventHandler>>());

  // Initialize the SSEConnection once on mount
  useEffect(() => {
    // Build a dispatcher that routes events to registered listeners
    const knownEvents = [
      'connected',
      'tunnel_status',
      'extension_reloaded',
      'relay_connected',
      'relay_message',
      'relay_backpressure',
      'relay_signal',
    ];

    const eventHandlers: Record<string, (data: unknown) => void> = {};
    for (const eventName of knownEvents) {
      eventHandlers[eventName] = (data: unknown) => {
        const handlers = listenersRef.current.get(eventName);
        if (handlers) {
          for (const handler of handlers) {
            try {
              handler(data);
            } catch {
              // Consumer error should not break the stream
            }
          }
        }
      };
    }

    const connection = new SSEConnection('/api/events', {
      eventHandlers,
      onStateChange: (state, attempts) => {
        setConnectionState(state);
        setFailedAttempts(attempts);
      },
    });

    connection.connect();
    connection.enableVisibilityOptimization();
    connectionRef.current = connection;

    return () => {
      connection.destroy();
      connectionRef.current = null;
    };
  }, []);

  const subscribe = useCallback((eventName: string, handler: EventHandler): Unsubscribe => {
    if (!listenersRef.current.has(eventName)) {
      listenersRef.current.set(eventName, new Set());
    }
    listenersRef.current.get(eventName)!.add(handler);

    return () => {
      const handlers = listenersRef.current.get(eventName);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          listenersRef.current.delete(eventName);
        }
      }
    };
  }, []);

  return (
    <EventStreamContext.Provider value={{ subscribe, connectionState, failedAttempts }}>
      {children}
    </EventStreamContext.Provider>
  );
}

/** Access the global event stream subscription API. */
export function useEventStream(): EventStreamContextValue {
  const ctx = useContext(EventStreamContext);
  if (!ctx) {
    throw new Error('useEventStream must be used within an EventStreamProvider');
  }
  return ctx;
}

/**
 * Subscribe to a specific event type from the unified stream.
 * The handler is ref-stabilized to prevent re-subscriptions on identity changes.
 */
export function useEventSubscription(eventName: string, handler: EventHandler): void {
  const { subscribe } = useEventStream();
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return subscribe(eventName, (data) => handlerRef.current(data));
  }, [subscribe, eventName]);
}
```

**Provider placement in `main.tsx`:**

```
QueryClientProvider
  → TransportProvider
    → EventStreamProvider        ← NEW (before ExtensionProvider)
      → ExtensionProvider
        → PasscodeGateWrapper
          → RouterProvider
```

The `EventStreamProvider` must mount before `ExtensionProvider` because the extension context subscribes to `extension_reloaded` events.

**Key design decisions:**

1. **Listener map via ref, not state.** The `listenersRef` is a `Map<string, Set<EventHandler>>` stored in a ref. Adding/removing listeners does not trigger re-renders. The `SSEConnection`'s event handlers dispatch to the current listener set synchronously.

2. **Known event list is static.** The `knownEvents` array is hardcoded to match the server's event name registry. This is intentional: `EventSource.addEventListener` requires registering event names up front. If a new event type is added later, it must be added to both the server fan-out and this array.

3. **Visibility optimization is always on.** The `SSEConnection` disconnects after 30s when the tab is hidden and reconnects immediately when visible. This is the same behavior the relay stream uses today.

### 5.6 Client: Consumer Migration

Each existing consumer migrates from its own EventSource/SSEConnection to the shared `useEventSubscription` hook. The handler logic stays identical -- only the event source changes.

#### Tunnel Sync (`use-tunnel-sync.ts`)

Before:

```typescript
// Creates its own EventSource
const eventSource = new EventSource('/api/tunnel/stream');
eventSource.addEventListener('tunnel_status', (event) => { ... });
```

After:

```typescript
import { useEventSubscription } from '@/layers/shared/model';

export function useTunnelSync(): void {
  const queryClient = useQueryClient();

  useEventSubscription('tunnel_status', (data) => {
    const status = data as TunnelStatus;
    queryClient.setQueryData(['tunnel-status'], status);
    queryClient.invalidateQueries({ queryKey: ['config'] });
  });

  // BroadcastChannel cross-tab sync remains unchanged
  useEffect(() => {
    const channel = createChannel<{ type: string }>(CHANNEL_NAME);
    const unsubscribe = channel.onMessage(() => {
      queryClient.invalidateQueries({ queryKey: ['tunnel-status'] });
      queryClient.invalidateQueries({ queryKey: ['config'] });
    });
    return () => {
      unsubscribe();
      channel.close();
    };
  }, [queryClient]);
}
```

The `BroadcastChannel` remains because it handles cross-tab sync within the same browser (same origin, different tabs). The unified SSE stream handles cross-device sync (different browsers hitting the same server). These are complementary, not redundant.

#### Extension Context (`extension-context.tsx`)

Before:

```typescript
// Creates its own EventSource in a useEffect
const eventSource = new EventSource('/api/extensions/events');
eventSource.addEventListener('extension_reloaded', (event) => { ... });
```

After:

```typescript
import { useEventSubscription } from '@/layers/shared/model';

// Inside ExtensionProvider, replace the SSE useEffect with:
useEventSubscription('extension_reloaded', (data) => {
  const loader = loaderRef.current;
  if (!loader) return;

  void (async () => {
    try {
      const payload = data as { extensionIds: string[]; timestamp: number };
      const { extensions, loaded } = await loader.reloadExtensions(payload.extensionIds);
      setState({ extensions, loaded, ready: true });
      queryClient.invalidateQueries({ queryKey: extensionKeys.lists() });
    } catch (err) {
      console.error('[extensions] Hot reload failed:', err);
    }
  })();
});
```

**Note:** The current extension SSE handler reads from `event.data` and calls `JSON.parse`. The `SSEConnection` class already parses JSON (line 108 of `sse-connection.ts`) and passes the parsed object to the handler. The `extension_reloaded` handler receives a pre-parsed object, so the `JSON.parse` call is removed. The data shape is `{ type, extensionIds, timestamp }` on the server side -- the handler accesses `extensionIds` directly.

However, the server currently sends `{ type: 'extension_reloaded', extensionIds, timestamp }` but the existing client-side handler reads it as `{ extensions: string[], timestamp: string }` (the `extensionIds` field is what it accesses, via `data.extensions`). This needs to be reconciled -- the server data field is `extensionIds`, not `extensions`. Check the actual runtime behavior and align the field names. The migrated handler should use `extensionIds` to match the server.

#### Relay Event Stream (`use-relay-event-stream.ts`)

Before:

```typescript
// Uses useSSEConnection with a dedicated URL
const url = enabled ? `/api/relay/stream?subject=...` : null;
const { connectionState, failedAttempts } = useSSEConnection(url, { eventHandlers });
```

After:

```typescript
import { useEventStream, useEventSubscription } from '@/layers/shared/model';

export function useRelayEventStream(
  enabled: boolean,
  _pattern?: string
): { connectionState: ConnectionState; failedAttempts: number } {
  const queryClient = useQueryClient();
  const { connectionState, failedAttempts } = useEventStream();

  useEventSubscription('relay_message', () => {
    if (!enabled) return;
    queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
  });

  useEventSubscription('relay_delivery', () => {
    if (!enabled) return;
    queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
  });

  return { connectionState, failedAttempts };
}
```

The `pattern` parameter becomes a no-op since the unified stream always subscribes to `relay.human.console.>` server-side. The parameter is kept in the signature for API compatibility but ignored. The `enabled` flag now gates the handler logic rather than the connection lifecycle.

The `connectionState` and `failedAttempts` now reflect the unified stream's health rather than a relay-specific connection. This is acceptable because the relay SSE stream was the only consumer displaying connection health in the UI (`RelayPanel.tsx`), and the unified stream's health is a superset.

### 5.7 Deprecation: Individual SSE Endpoints

The 3 individual endpoints are deprecated but not immediately removed, enabling a safe rollout:

**Phase 1 (this spec):** Add `GET /api/events`, migrate all client consumers. Mark old endpoints as deprecated via comments and a deprecation log warning on first client connection:

```typescript
// In tunnel.ts GET /stream handler
logger.warn('[Tunnel] Deprecated: /api/tunnel/stream — use /api/events');
```

**Phase 2 (follow-up):** After confirming the unified endpoint works in production for at least 1 release cycle, remove:

- `GET /api/tunnel/stream` handler from `routes/tunnel.ts` (lines 39-56)
- `GET /api/extensions/events` handler and the `sseClients` Set from `routes/extensions.ts` (lines 14-15, 23-38, 62-79)
- `GET /api/relay/stream` handler from `routes/relay.ts` (lines 363-429) -- **only for web client use**. If external adapters use this endpoint, it must be preserved or an alternative provided.

---

## 6. Data Flow

### Before (4 connections)

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser Tab                                                      │
│                                                                  │
│  useTunnelSync ──── EventSource ──── /api/tunnel/stream     [1] │
│  ExtensionProvider ─ EventSource ──── /api/extensions/events [2] │
│  useRelayEventStream SSEConnection ── /api/relay/stream     [3] │
│  useChatSession ──── SSEConnection ── /api/sessions/:id/stream [4] │
│  sendMessage ─────── POST ──────────── /api/sessions/:id/messages │
│  [tool approval] ─── POST ──────────── /api/sessions/:id/tool    │
│                           ↑                                      │
│                    6 CONNECTIONS EXHAUSTED                        │
└─────────────────────────────────────────────────────────────────┘
```

### After (2 connections)

```
┌─────────────────────────────────────────────────────────────────┐
│ Browser Tab                                                      │
│                                                                  │
│  EventStreamProvider ── SSEConnection ── /api/events         [1] │
│    ├── useTunnelSync ←─── tunnel_status                          │
│    ├── ExtensionProvider ← extension_reloaded                    │
│    └── useRelayEventStream ← relay_message, relay_signal         │
│                                                                  │
│  useChatSession ──── SSEConnection ── /api/sessions/:id/stream [2] │
│  sendMessage ─────── POST ──────────── /api/sessions/:id/messages │
│  [tool approval] ─── POST ──────────── /api/sessions/:id/tool    │
│  [API fetches] ────── GET/POST ─────── /api/*                    │
│                           ↑                                      │
│                    3 FREE CONNECTIONS                             │
└─────────────────────────────────────────────────────────────────┘
```

### Server-Side Fan-Out

```
tunnelManager.on('status_change') ──┐
                                    │
broadcastExtensionReloaded() ───────┼──→ eventFanOut.broadcast()
                                    │         │
relayCore.subscribe() ─────────────┘         │
relayCore.onSignal() ──────────────┘         ▼
                                        Set<Response>
                                        ┌─────────┐
                                        │ Client 1 │ ← res.write('event: ...\n')
                                        │ Client 2 │ ← res.write('event: ...\n')
                                        │ Client N │ ← res.write('event: ...\n')
                                        └─────────┘
```

---

## 7. Implementation Phases

Execute in order. Each phase is independently testable.

### Phase A: Server Fan-Out Service (no client changes)

1. Create `apps/server/src/services/core/event-fan-out.ts` with the `EventFanOut` class
2. Create `apps/server/src/routes/events.ts` with `GET /api/events`
3. Mount the route in `app.ts` or `index.ts`: `app.use('/api/events', eventsRouter)`
4. Wire tunnel events: `tunnelManager.on('status_change', ...)` → `eventFanOut.broadcast()`
5. Wire extension events: modify `broadcastExtensionReloaded()` to call `eventFanOut.broadcast()`
6. Wire relay events: `relayCore.subscribe()` and `relayCore.onSignal()` → `eventFanOut.broadcast()`
7. **Verify:** Open `/api/events` in the browser directly, toggle tunnel on/off, confirm `tunnel_status` events appear in the raw stream

### Phase B: Client Provider (old connections still active)

1. Create `apps/client/src/layers/shared/model/event-stream-context.tsx`
2. Export from `apps/client/src/layers/shared/model/index.ts`
3. Add `<EventStreamProvider>` to `main.tsx` (before `ExtensionProvider`)
4. **Verify:** Open Chrome DevTools Network tab, confirm the `/api/events` connection opens alongside the old individual streams

### Phase C: Consumer Migration (one at a time)

1. Migrate `useTunnelSync` to use `useEventSubscription('tunnel_status', ...)`
2. Migrate `ExtensionProvider` to use `useEventSubscription('extension_reloaded', ...)`
3. Migrate `useRelayEventStream` to use `useEventSubscription('relay_message', ...)` and `useEventSubscription('relay_delivery', ...)`
4. After each migration, verify the corresponding old EventSource no longer appears in DevTools Network tab

### Phase D: Deprecation Markers

1. Add deprecation warnings to old SSE handlers (`logger.warn` on first connection)
2. Update OpenAPI/route docs to mark endpoints as deprecated
3. Old endpoints remain functional for external consumers

---

## 8. File Changes

### New Files

| File                                                                          | Description                                                     |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `apps/server/src/services/core/event-fan-out.ts`                              | Fan-out broadcaster: manages SSE client set, broadcasts events  |
| `apps/server/src/routes/events.ts`                                            | `GET /api/events` unified SSE endpoint                          |
| `apps/client/src/layers/shared/model/event-stream-context.tsx`                | `EventStreamProvider`, `useEventStream`, `useEventSubscription` |
| `apps/server/src/services/core/__tests__/event-fan-out.test.ts`               | Unit tests for fan-out service                                  |
| `apps/server/src/routes/__tests__/events.test.ts`                             | Integration tests for unified endpoint                          |
| `apps/client/src/layers/shared/model/__tests__/event-stream-context.test.tsx` | Tests for provider and hooks                                    |

### Modified Files

| File                                                                     | Change                                                                                                          |
| ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/index.ts`                                               | Wire tunnel/relay EventEmitters to `eventFanOut.broadcast()`, mount `/api/events` route                         |
| `apps/server/src/app.ts`                                                 | Add `app.use('/api/events', eventsRouter)` if route mounting is here                                            |
| `apps/server/src/routes/extensions.ts`                                   | Change `broadcastExtensionReloaded()` to use `eventFanOut.broadcast()` instead of module-level `sseClients` Set |
| `apps/server/src/routes/tunnel.ts`                                       | Add deprecation warning to `GET /stream` handler                                                                |
| `apps/server/src/routes/relay.ts`                                        | Add deprecation warning to `GET /stream` handler                                                                |
| `apps/client/src/main.tsx`                                               | Add `<EventStreamProvider>` wrapping `<ExtensionProvider>`                                                      |
| `apps/client/src/layers/shared/model/index.ts`                           | Export `EventStreamProvider`, `useEventStream`, `useEventSubscription`                                          |
| `apps/client/src/layers/entities/tunnel/model/use-tunnel-sync.ts`        | Replace raw `EventSource` with `useEventSubscription`                                                           |
| `apps/client/src/layers/features/extensions/model/extension-context.tsx` | Replace raw `EventSource` with `useEventSubscription`                                                           |
| `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`  | Replace `useSSEConnection` with `useEventStream` + `useEventSubscription`                                       |

### Test Files Requiring Updates

| File                                                                        | Change                                                                     |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/client/src/layers/entities/tunnel/__tests__/use-tunnel-sync.test.tsx` | Mock `useEventSubscription` instead of `EventSource` constructor           |
| `apps/client/src/layers/entities/relay/model/__tests__/` (if exists)        | Mock `useEventStream`/`useEventSubscription` instead of `useSSEConnection` |

### Files to Delete (Phase 2 follow-up, not this spec)

- SSE handler blocks within `routes/tunnel.ts`, `routes/extensions.ts`, `routes/relay.ts`
- Module-level `sseClients` Set in `routes/extensions.ts`

---

## 9. Testing Strategy

### Unit Tests

**`event-fan-out.test.ts`:**

- `addClient` registers a response and `broadcast` writes to it
- `addClient` rejects when `MAX_TOTAL_CLIENTS` is reached (returns 503)
- `broadcast` removes clients whose `writableEnded` is true
- `broadcast` handles `res.write()` throwing (removes client, does not propagate)
- `broadcast` handles backpressure (`res.write()` returns false)
- `clientCount` reflects add/remove operations

**`events.test.ts` (integration with supertest):**

- `GET /api/events` returns SSE headers (`text/event-stream`, `no-cache`, `keep-alive`)
- Client receives `connected` event on connection
- `tunnel_status` events appear when `eventFanOut.broadcast('tunnel_status', ...)` is called
- `extension_reloaded` events appear when `eventFanOut.broadcast('extension_reloaded', ...)` is called
- Connection cleanup on client disconnect (client count drops)

**`event-stream-context.test.tsx`:**

- `useEventSubscription` calls handler when matching event fires
- `useEventSubscription` does not call handler for non-matching events
- Unsubscribe on unmount cleans up listener
- `useEventStream` throws outside provider
- `connectionState` reflects SSEConnection state changes
- Multiple subscribers to the same event all receive the data

### Integration Verification

Manual verification in Chrome DevTools:

1. Open DevTools > Network tab
2. Filter by `EventStream` type
3. Confirm only 2 SSE connections: `/api/events` and `/api/sessions/:id/stream`
4. Toggle tunnel on/off → confirm `tunnel_status` events in the `/api/events` stream
5. Trigger extension reload → confirm `extension_reloaded` event
6. Send a relay message → confirm `relay_message` event
7. Open a session and approve a tool call → confirm no timeout

### Existing Test Updates

Existing tests for `useTunnelSync`, `ExtensionProvider`, and `useRelayEventStream` need mock updates:

- Replace `EventSource` constructor mocks with mocks for `useEventSubscription` / `useEventStream`
- The handler logic tests remain unchanged (same inputs, same outputs)

---

## 10. Acceptance Criteria

- [ ] `GET /api/events` endpoint exists and returns `text/event-stream` with correct headers
- [ ] Tunnel status changes appear as `event: tunnel_status` on the unified stream
- [ ] Extension reloads appear as `event: extension_reloaded` on the unified stream
- [ ] Relay messages appear as `event: relay_message` on the unified stream
- [ ] Server heartbeat comment (`: keepalive`) fires every 15s on the unified stream
- [ ] Client `EventStreamProvider` creates exactly one `SSEConnection` to `/api/events`
- [ ] `useTunnelSync` no longer creates its own `EventSource`
- [ ] `ExtensionProvider` no longer creates its own `EventSource`
- [ ] `useRelayEventStream` no longer creates its own `SSEConnection`
- [ ] BroadcastChannel cross-tab sync in `useTunnelSync` continues to work
- [ ] Chrome DevTools Network tab shows exactly 2 SSE connections (unified + session sync) when a session is active
- [ ] Chrome DevTools shows exactly 1 SSE connection (unified only) when no session is active
- [ ] Tool approval POST requests complete without timeout under normal operation
- [ ] `SSE.MAX_TOTAL_CLIENTS` limit is enforced on the unified endpoint (503 when exceeded)
- [ ] All existing tests pass (with mock updates)
- [ ] New tests cover fan-out service, unified endpoint, and client provider
- [ ] Old SSE endpoints still function (deprecated, not removed) for backward compatibility
- [ ] Obsidian plugin continues to work (no changes needed -- uses DirectTransport)

---

## 11. Risks & Mitigations

| Risk                                                                                                                                                                                       | Impact                                                                                                                                                                               | Mitigation                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Event ordering across sources.** Tunnel, extension, and relay events may interleave in the unified stream.                                                                               | Low. Consumers process events independently by type. No cross-source ordering dependency exists.                                                                                     | No mitigation needed.                                                                                                                              |
| **Relay subject filtering lost.** The unified stream subscribes to `relay.human.console.>` only. External adapters using custom `?subject=` patterns lose that capability.                 | Medium for external consumers.                                                                                                                                                       | Preserve `GET /api/relay/stream` for external adapter use. Only deprecate it for the web client.                                                   |
| **Extension `broadcastExtensionReloaded` caller changes.** The function is called from the extension watcher and the reload endpoint. Changing its internals must not break those callers. | Low. The function signature is unchanged -- only the broadcast mechanism changes internally.                                                                                         | Keep the function signature identical. Test both call sites.                                                                                       |
| **Provider mount order matters.** `EventStreamProvider` must mount before `ExtensionProvider` or extension reload events will be missed.                                                   | Medium if misordered.                                                                                                                                                                | Document the required order. The provider tree is in `main.tsx` which is a single controlled location.                                             |
| **Missed events during reconnection.** If the unified stream reconnects (visibility change, network blip), events during the gap are lost.                                                 | Low. All consumers use TanStack Query with polling. Missed SSE events result in a delayed poll-based update, not permanent data loss. Tunnel also has initial status fetch on mount. | Existing pattern -- same risk profile as the individual streams today.                                                                             |
| **Memory leak if clients are not cleaned up.** Server must remove disconnected clients from the Set.                                                                                       | Medium if not handled.                                                                                                                                                               | `req.on('close')` calls `unsubscribe()`. `broadcast()` also prunes `writableEnded` clients defensively.                                            |
| **`knownEvents` array on client must stay in sync with server.** If a new event type is added to the server but not the client array, it silently won't be dispatched.                     | Low. Adding a new event type is a deliberate code change that should update both sides.                                                                                              | Document the requirement in a code comment above the `knownEvents` array. Consider a shared constant in `@dorkos/shared/constants` in a follow-up. |
