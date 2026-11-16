---
slug: sse-resilience-connection-health
number: 174
created: 2026-03-24
status: draft
---

# SSE Resilience & Connection Health

**Status:** Draft
**Authors:** Claude Code, 2026-03-24
**Ideation:** `specs/sse-resilience-connection-health/01-ideation.md`
**Research:** `research/20260324_sse_resilience_production_patterns.md`

---

## Overview

Build production-grade SSE resilience infrastructure for DorkOS. This creates a shared `SSEConnection` class and `useSSEConnection` hook that encapsulates exponential backoff with full jitter, heartbeat watchdog, page visibility optimization, and connection state tracking. All three SSE connection types (POST chat stream, GET session sync, GET relay) are upgraded to use this infrastructure, and connection health is surfaced in the StatusLine UI.

## Background / Problem Statement

DorkOS uses SSE for three critical real-time features:

1. **POST message streaming** — Chat responses streamed inline on the POST response
2. **GET session sync** — Persistent connection for cross-client file change notifications
3. **GET relay stream** — Persistent connection for the inter-agent message bus

Current gaps:

- **Session sync has no heartbeat** — Zombie connections go undetected. The server sends no keepalive; the client has no watchdog timer.
- **Session sync has no reconnection logic** — Uses bare `EventSource` with zero error handling. If the connection drops, the client has no idea.
- **No connection status in the session UI** — Users cannot see if their session sync is healthy. Relay has `ConnectionStatusBanner`, but the session view has nothing.
- **POST stream has no retry** — If a network blip occurs mid-stream, the entire response is lost. The user must manually re-send.
- **No page visibility optimization** — SSE connections stay open in background tabs, consuming server resources (file watchers, connection slots).
- **Duplicate resilience patterns** — Relay has bespoke connection tracking; session sync has none. Neither shares code.

## Goals

- Eliminate zombie SSE connections via server heartbeat + client watchdog
- Auto-recover from transient network failures with exponential backoff + jitter
- Surface connection health in the StatusLine (always visible, zero disruption)
- Preserve partial chat responses on POST stream failure and offer retry
- Reduce server resource usage by closing SSE in background tabs
- Unify SSE resilience patterns into a single shared primitive
- Maintain world-class DX: the SSEConnection class is independently testable; the hook is thin

## Non-Goals

- WebSocket or WebTransport fallback
- Service Worker SSE proxying
- Server-side replay buffer for `Last-Event-ID`
- Changes to Obsidian plugin's `DirectTransport` (no SSE involved)
- MCP endpoint SSE resilience (separate concern)
- Custom EventSource polyfill (native browser API is sufficient)

## Technical Dependencies

- **Native `EventSource` API** — All modern browsers, no polyfill needed
- **`motion`** — Already used for animations, needed for banner enter/exit
- **TanStack Query** — Already used, needed for cache invalidation on reconnect
- **Zustand** — Not needed (connection state lives in the hook, not a global store)

No new external libraries required.

## Detailed Design

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                      SSEConnection Class                     │
│  shared/lib/transport/sse-connection.ts                      │
│                                                              │
│  ┌──────────┐    ┌───────────┐    ┌──────────────────────┐  │
│  │  State    │    │ Backoff   │    │ Heartbeat Watchdog   │  │
│  │ Machine   │    │ Engine    │    │ (45s timeout)        │  │
│  │           │    │           │    │                      │  │
│  │ connecting│    │ BASE=500ms│    │ Resets on any event  │  │
│  │ connected │    │ CAP=30s   │    │ Fires reconnect on   │  │
│  │reconnecti│    │ Full jitter│   │ silence              │  │
│  │disconnecte│   │           │    │                      │  │
│  └──────────┘    └───────────┘    └──────────────────────┘  │
│                                                              │
│  ┌──────────────────────┐    ┌────────────────────────────┐ │
│  │ Page Visibility      │    │ Event Emitter              │ │
│  │ (30s grace period)   │    │ onStateChange, onEvent,    │ │
│  │                      │    │ onError                    │ │
│  └──────────────────────┘    └────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    useSSEConnection Hook                      │
│  shared/model/use-sse-connection.ts                           │
│                                                              │
│  - Creates/destroys SSEConnection on mount/URL change        │
│  - Integrates with useTabVisibility                          │
│  - Returns { connectionState, failedAttempts, lastEventAt }  │
│  - Stable callback refs via useRef                           │
└─────────────────────────────────────────────────────────────┘
          │                    │                    │
          ▼                    ▼                    ▼
   ┌────────────┐     ┌──────────────┐     ┌────────────────┐
   │ Session    │     │ Relay Event  │     │ StatusLine     │
   │ Sync       │     │ Stream       │     │ Connection     │
   │ (chat)     │     │              │     │ Item           │
   └────────────┘     └──────────────┘     └────────────────┘
```

### 1. Shared Types

**File:** `packages/shared/src/types.ts` (add to existing)

```typescript
/** SSE connection health state. */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting' | 'disconnected';
```

This replaces the relay-specific `RelayConnectionState`. The relay type becomes an alias during migration, then is removed.

### 2. SSE Resilience Constants

**File:** `apps/server/src/config/constants.ts` (extend existing `SSE` object)

```typescript
export const SSE = {
  MAX_CLIENTS_PER_SESSION: 10,
  MAX_TOTAL_CLIENTS: 500,
  HEARTBEAT_INTERVAL_MS: 15_000, // Server keepalive interval
} as const;
```

**File:** `apps/client/src/layers/shared/lib/constants.ts` (or alongside TIMING/QUERY_TIMING)

```typescript
export const SSE_RESILIENCE = {
  HEARTBEAT_TIMEOUT_MS: 45_000, // 3× server heartbeat interval
  BACKOFF_BASE_MS: 500,
  BACKOFF_CAP_MS: 30_000,
  VISIBILITY_GRACE_MS: 30_000, // Close after 30s hidden
  DISCONNECTED_THRESHOLD: 5, // Consecutive failures before 'disconnected'
  POST_RETRY_DELAY_MS: 2_000,
  POST_MAX_RETRIES: 1,
  STABILITY_WINDOW_MS: 10_000, // Time connected before resetting attempts
} as const;
```

### 3. SSEConnection Class

**File:** `apps/client/src/layers/shared/lib/transport/sse-connection.ts`

The class manages a single SSE connection with full resilience. It is framework-agnostic (no React dependency) and independently testable.

```typescript
export interface SSEConnectionOptions {
  /** Event handlers for incoming SSE events, keyed by event type. */
  eventHandlers: Record<string, (data: unknown) => void>;
  /** Called when connection state changes. */
  onStateChange?: (state: ConnectionState, failedAttempts: number) => void;
  /** Called on unrecoverable error. */
  onError?: (error: Event) => void;
  /** Heartbeat watchdog timeout in ms. 0 disables. Default: 45000. */
  heartbeatTimeoutMs?: number;
  /** Backoff base in ms. Default: 500. */
  backoffBaseMs?: number;
  /** Backoff cap in ms. Default: 30000. */
  backoffCapMs?: number;
  /** Max consecutive failures before 'disconnected'. Default: 5. */
  disconnectedThreshold?: number;
  /** Time connected before resetting failure count. Default: 10000. */
  stabilityWindowMs?: number;
}
```

**State Machine:**

```
    connect()
        │
        ▼
  ┌───────────┐
  │ connecting │
  └─────┬─────┘
        │ onopen
        ▼
  ┌───────────┐  heartbeat timeout / onerror
  │ connected  │──────────────────────────────┐
  └─────┬─────┘                               │
        │ visibility hidden (after grace)      │
        ▼                                      ▼
  ┌───────────┐                        ┌──────────────┐
  │  (closed)  │                        │ reconnecting │
  └───────────┘                        └──────┬───────┘
        ▲                                      │
        │ visibility visible                   │ attempts < threshold
        │                                      │   → backoff → connect()
  ┌───────────┐                               │
  │ connecting │◄──────────────────────────────┘
  └───────────┘                               │
                                               │ attempts >= threshold
                                               ▼
                                        ┌──────────────┐
                                        │ disconnected │
                                        └──────────────┘
                                         (manual reconnect
                                          or visibility change)
```

**Key Methods:**

- `connect()` — Create EventSource, attach handlers, start watchdog
- `disconnect()` — Close EventSource, clear timers, set state
- `destroy()` — Permanent teardown (removes visibility listener)

**Backoff Algorithm (Full Jitter):**

```typescript
private calculateBackoff(): number {
  const exponential = Math.min(
    this.options.backoffCapMs,
    this.options.backoffBaseMs * Math.pow(2, this.failedAttempts)
  );
  return Math.random() * exponential;
}
```

**Heartbeat Watchdog:**

Resets a `setTimeout` on every incoming event (including `: keepalive` comments, which native `EventSource` does not expose — but named heartbeat events are). If timeout fires with no events, forces reconnection.

Note: Native `EventSource` does not fire events for SSE comments (`: keepalive`). The server must send named events for the watchdog to detect. We will add a `heartbeat` named event alongside the comment keepalive.

**Page Visibility:**

Listens to `document.visibilitychange`. On hidden: starts a grace timer (30s). If still hidden when timer fires, calls `disconnect()`. On visible: if disconnected/reconnecting, calls `connect()` immediately.

### 4. useSSEConnection Hook

**File:** `apps/client/src/layers/shared/model/use-sse-connection.ts`

```typescript
export interface UseSSEConnectionOptions {
  /** Event handlers for SSE events. Stable reference required. */
  eventHandlers: Record<string, (data: unknown) => void>;
  /** Enable page visibility optimization. Default: true. */
  visibilityOptimization?: boolean;
  /** Override heartbeat timeout. Default: 45000. */
  heartbeatTimeoutMs?: number;
}

export interface UseSSEConnectionReturn {
  connectionState: ConnectionState;
  failedAttempts: number;
  lastEventAt: number | null;
}

export function useSSEConnection(
  url: string | null,
  options: UseSSEConnectionOptions
): UseSSEConnectionReturn;
```

**Implementation Details:**

- `url` is null-safe — passing `null` means "don't connect" (used when streaming, session not selected, etc.)
- Event handlers are captured via `useRef` to prevent reconnection on handler identity changes
- `useTabVisibility` integration: passes visibility state to SSEConnection
- State updates batched to prevent render storms during rapid reconnection
- Cleanup on unmount: calls `connection.destroy()`

### 5. Server-Side Heartbeat

**File:** `apps/server/src/routes/sessions.ts` (modify GET `/:id/stream`)

Add to the session sync endpoint:

```typescript
// Send retry hint and initial heartbeat event
res.write(`retry: 3000\n\n`);

// Periodic heartbeat (named event so client watchdog can detect it)
const heartbeatInterval = setInterval(() => {
  try {
    res.write(`event: heartbeat\ndata: {}\n\n`);
  } catch {
    clearInterval(heartbeatInterval);
  }
}, SSE.HEARTBEAT_INTERVAL_MS);

res.on('close', () => {
  clearInterval(heartbeatInterval);
  unsubscribe();
});
```

Also add `id:` field to sync_update and presence_update events for future `Last-Event-ID` support:

```typescript
// In broadcastUpdate:
const eventId = `${sessionId}-${Date.now()}`;
const eventData = `id: ${eventId}\nevent: sync_update\ndata: ${JSON.stringify(event)}\n\n`;
```

### 6. POST Chat Stream Retry

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

Modify the `executeSubmission` catch block to handle transient retry:

```typescript
} catch (err) {
  if ((err as Error).name === 'AbortError') {
    // User-initiated cancel — no retry
    resetStreamingState();
    return;
  }

  const errorInfo = classifyTransportError(err);

  if (errorInfo.retryable && retryCountRef.current < POST_MAX_RETRIES) {
    // Transient error — auto-retry once after delay
    retryCountRef.current++;
    setError({ ...errorInfo, message: 'Connection interrupted. Retrying...' });
    await new Promise(resolve => setTimeout(resolve, POST_RETRY_DELAY_MS));

    // Re-attempt (preserving partial response in UI)
    try {
      await transport.sendMessage(/* same args */);
      retryCountRef.current = 0;
      pendingUserIdRef.current = null;
      setStatus('idle');
      setError(null);
      return;
    } catch (retryErr) {
      // Retry failed — fall through to error display
      const retryErrorInfo = classifyTransportError(retryErr);
      setError({ ...retryErrorInfo, retryable: true });
    }
  } else {
    setError(errorInfo);
  }

  // Keep partial assistant response visible (don't discard)
  // But remove the optimistic user message if it was never delivered
  if (pendingUserIdRef.current) {
    const failedId = pendingUserIdRef.current;
    setMessages(prev => prev.filter(m => m.id !== failedId));
    pendingUserIdRef.current = null;
  }

  retryCountRef.current = 0;
  setStatus('error');
  resetStreamingState();
}
```

Add a `retryMessage` callback that users can trigger from the error banner:

```typescript
const retryMessage = useCallback(
  async (content: string) => {
    setError(null);
    await executeSubmission(content, false, '');
  },
  [executeSubmission]
);
```

Return `retryMessage` from the hook for UI consumption.

### 7. Refactor useRelayEventStream

**File:** `apps/client/src/layers/entities/relay/model/use-relay-event-stream.ts`

Replace the bespoke EventSource management with `useSSEConnection`:

```typescript
import { useSSEConnection } from '@/layers/shared/model';
import type { ConnectionState } from '@dorkos/shared/types';

export function useRelayEventStream(
  enabled: boolean,
  pattern?: string
): { connectionState: ConnectionState; failedAttempts: number } {
  const queryClient = useQueryClient();

  const eventHandlers = useMemo(
    () => ({
      relay_message: () => {
        queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
      },
      relay_delivery: () => {
        queryClient.invalidateQueries({ queryKey: ['relay', 'conversations'] });
      },
    }),
    [queryClient]
  );

  const url = enabled
    ? `/api/relay/stream${pattern ? `?subject=${encodeURIComponent(pattern)}` : ''}`
    : null;

  return useSSEConnection(url, { eventHandlers });
}
```

This reduces the file from 67 lines to ~20 while preserving identical behavior (plus gaining backoff, watchdog, and visibility optimization).

### 8. Refactor Session Sync in useChatSession

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

Replace lines 286-326 (bare EventSource) with `useSSEConnection`:

```typescript
// Build sync URL (null when streaming or sync disabled)
const syncUrl = useMemo(() => {
  if (!sessionId || isStreaming || !enableCrossClientSync) return null;
  const clientIdParam = transport.clientId
    ? `?clientId=${encodeURIComponent(transport.clientId)}`
    : '';
  return `/api/sessions/${sessionId}/stream${clientIdParam}`;
}, [sessionId, isStreaming, enableCrossClientSync, transport.clientId]);

// Sync event handlers
const syncEventHandlers = useMemo(
  () => ({
    sync_update: () => {
      queryClient.invalidateQueries({ queryKey: ['messages', sessionId, selectedCwdRef.current] });
      queryClient.invalidateQueries({ queryKey: ['tasks', sessionId, selectedCwdRef.current] });
      // Pulse presence badge
      if (presenceInfoRef.current && presenceInfoRef.current.clientCount > 1) {
        setPresencePulse(true);
        if (presencePulseTimerRef.current) clearTimeout(presencePulseTimerRef.current);
        presencePulseTimerRef.current = setTimeout(() => {
          setPresencePulse(false);
        }, 1000);
      }
    },
    presence_update: (data: unknown) => {
      try {
        setPresenceInfo(data as PresenceUpdateEvent);
      } catch {
        /* ignore malformed */
      }
    },
  }),
  [sessionId, queryClient]
);

const { connectionState: syncConnectionState, failedAttempts: syncFailedAttempts } =
  useSSEConnection(syncUrl, { eventHandlers: syncEventHandlers });
```

Return `syncConnectionState` and `syncFailedAttempts` from the hook for StatusLine consumption.

### 9. ConnectionStatusBanner Generalization

**File:** `apps/client/src/layers/shared/ui/ConnectionStatusBanner.tsx` (move from features/relay)

```typescript
import { Wifi, WifiOff } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import type { ConnectionState } from '@dorkos/shared/types';

interface ConnectionStatusBannerProps {
  connectionState: ConnectionState;
  failedAttempts?: number;
  maxAttempts?: number;
  className?: string;
}

/** Displays an inline status banner when an SSE connection is degraded or lost. */
export function ConnectionStatusBanner({
  connectionState,
  failedAttempts,
  maxAttempts,
  className,
}: ConnectionStatusBannerProps) {
  if (connectionState === 'connected' || connectionState === 'connecting') return null;

  const isDisconnected = connectionState === 'disconnected';
  const attemptText = failedAttempts && maxAttempts
    ? ` (attempt ${failedAttempts}/${maxAttempts})`
    : '';

  return (
    <div
      className={cn(
        'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium',
        isDisconnected
          ? 'bg-red-500/10 text-red-600 dark:text-red-400'
          : 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
        className
      )}
    >
      {isDisconnected ? (
        <WifiOff className="size-3.5" />
      ) : (
        <Wifi className="size-3.5 animate-pulse" />
      )}
      <span>
        {isDisconnected
          ? 'Connection lost. Check your network.'
          : `Reconnecting...${attemptText}`}
      </span>
    </div>
  );
}
```

The relay-specific `ConnectionStatusBanner` becomes a re-export from `features/relay/` for backward compatibility during migration, then is removed.

### 10. StatusLine Connection Item

**File:** `apps/client/src/layers/features/status/ui/ConnectionItem.tsx`

A new StatusLine item showing connection health as a colored dot with tooltip:

```typescript
import { StatusLine } from './StatusLine';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/layers/shared/ui';
import type { ConnectionState } from '@dorkos/shared/types';

const STATE_CONFIG: Record<ConnectionState, { color: string; label: string }> = {
  connecting: { color: 'text-amber-500', label: 'Connecting...' },
  connected: { color: 'text-emerald-500', label: 'Connected' },
  reconnecting: { color: 'text-amber-500', label: 'Reconnecting' },
  disconnected: { color: 'text-red-500', label: 'Disconnected' },
};

interface ConnectionItemProps {
  connectionState: ConnectionState;
  failedAttempts?: number;
}

export function ConnectionItem({ connectionState, failedAttempts }: ConnectionItemProps) {
  const visible = connectionState !== 'connected';
  const config = STATE_CONFIG[connectionState];
  const label = failedAttempts && connectionState === 'reconnecting'
    ? `Reconnecting (attempt ${failedAttempts})`
    : config.label;

  return (
    <StatusLine.Item itemKey="connection" visible={visible}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex items-center gap-1.5 text-xs">
            <span className={cn('size-1.5 rounded-full', config.color, {
              'animate-pulse': connectionState === 'reconnecting' || connectionState === 'connecting',
            })} />
            <span className="text-muted-foreground">{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>
    </StatusLine.Item>
  );
}
```

Note: The item is only visible when NOT connected. When healthy, it disappears from the StatusLine entirely (zero disruption). Only shows up when something needs attention.

## User Experience

### Healthy State (default)

No connection indicators visible. StatusLine shows its normal items (cwd, git, model, cost, etc.). Zero visual overhead.

### Reconnecting State

StatusLine gains a small amber pulsing dot with "Reconnecting (attempt 2)" text. Appears via the existing StatusLine enter animation (opacity + scale). Non-disruptive — user can continue reading the chat.

### Disconnected State

After 5 consecutive failures, the StatusLine item turns red with "Disconnected" text. A `ConnectionStatusBanner` slides in above the StatusLine with "Connection lost. Check your network." This is the only state that demands attention.

### POST Stream Failure

If a chat response is interrupted mid-stream:

1. Partial response stays visible (not discarded)
2. Error banner appears: "Connection interrupted" with Retry and Dismiss buttons
3. For transient errors: auto-retry happens once after 2s (banner shows "Retrying...")
4. If retry succeeds: banner dismisses, streaming resumes
5. If retry fails: banner shows with Retry button for manual action

### Tab Background Behavior

When the user switches tabs:

1. SSE connections stay open for 30s (grace period for quick switches)
2. After 30s hidden, connections close gracefully
3. When the tab becomes visible again, connections reconnect immediately
4. TanStack Query refetches catch up on any missed sync events

## Testing Strategy

### Unit Tests: SSEConnection Class

**File:** `apps/client/src/layers/shared/lib/transport/__tests__/sse-connection.test.ts`

Test the class in isolation using a mock EventSource:

- **State transitions:** connecting → connected → reconnecting → disconnected
- **Backoff calculation:** Verify exponential growth, cap enforcement, jitter range
- **Heartbeat watchdog:** Verify timeout fires reconnection, resets on event
- **Page visibility:** Grace period, immediate reconnect on visible
- **Max retries:** Stops at threshold, enters disconnected state
- **Stability window:** Attempt counter resets after connected for 10s
- **Destroy cleanup:** All timers cleared, EventSource closed
- **Multiple rapid state changes:** No orphaned timers or connections

### Unit Tests: useSSEConnection Hook

**File:** `apps/client/src/layers/shared/model/__tests__/use-sse-connection.test.ts`

- **Lifecycle:** Creates connection on mount, destroys on unmount
- **URL changes:** Reconnects when URL changes, cleans up old connection
- **null URL:** No connection created
- **State exposure:** connectionState, failedAttempts, lastEventAt reflect SSEConnection state
- **Ref stability:** Handler identity changes don't cause reconnection

### Unit Tests: POST Retry Logic

**File:** `apps/client/src/layers/features/chat/model/__tests__/chat-retry.test.ts`

- **Transient error auto-retry:** Verify single retry after 2s delay
- **Permanent error no-retry:** 4xx and session locked show banner only
- **Partial response preservation:** Assistant messages not discarded on error
- **Retry button callback:** Manual retry triggers re-submission
- **Retry counter reset:** Counter resets after successful message

### Integration Tests: Server Heartbeat

- Verify `: keepalive` or `heartbeat` event arrives within 15s on session sync endpoint
- Verify `retry:` field is sent on initial connection
- Verify `id:` field present on sync_update events

### Existing Test Non-Regression

- Run existing `use-relay-event-stream` tests after refactor
- Run existing `use-chat-session` tests after refactor
- Run existing `ConnectionStatusBanner` tests with new type

## Performance Considerations

- **Heartbeat overhead:** One 15-byte comment write per connection per 15s — negligible
- **Backoff jitter:** Prevents thundering herd on server restart (N clients spread across 0-30s)
- **Page visibility:** Reduces active connections proportional to background tabs
- **Watchdog timer:** Single `setTimeout` per connection — negligible memory
- **State updates:** Batched via React 19 automatic batching — no render storms
- **Connection limits unchanged:** MAX_CLIENTS_PER_SESSION=10, MAX_TOTAL_CLIENTS=500

## Security Considerations

- Session IDs in SSE URLs are already the standard pattern — no change in exposure
- Reconnection validates server response (404 for deleted sessions handled gracefully)
- POST retry does not re-send if the server may have received the original (only retries on network-level failures where the request didn't reach the server, not on response-stream breaks after a 200 was received)
- No new auth surface — SSE uses same-origin fetch credentials

## Documentation

- Update `contributing/architecture.md` — Add SSE resilience section documenting the SSEConnection class and hook
- Update `contributing/data-fetching.md` — Add section on SSE connection management alongside TanStack Query patterns
- No external docs changes needed (SSE is internal infrastructure)

## Implementation Phases

### Phase 1: Shared Primitive + Server Heartbeat

1. Add `ConnectionState` type to `@dorkos/shared/types`
2. Add SSE resilience constants (server + client)
3. Implement `SSEConnection` class with full test suite
4. Implement `useSSEConnection` hook with tests
5. Add heartbeat to session sync endpoint
6. Export new modules from barrel files

### Phase 2: POST Chat Stream Retry (Priority)

7. Add retry logic to `executeSubmission` in `use-chat-session.ts`
8. Add `retryMessage` callback
9. Add "Connection interrupted" error variant to `classifyTransportError`
10. Test retry behavior

### Phase 3: Consumer Refactors

11. Refactor `useRelayEventStream` to use `useSSEConnection`
12. Refactor session sync in `useChatSession` to use `useSSEConnection`
13. Migrate `RelayConnectionState` → `ConnectionState`
14. Update existing tests

### Phase 4: UI

15. Move `ConnectionStatusBanner` to `shared/ui/`, generalize types
16. Create `ConnectionItem` for StatusLine
17. Wire connection state into StatusLine from `useChatSession`
18. Add retry button to chat error banner
19. Update relay UI to use generalized banner

## Open Questions

None — all decisions resolved in ideation.

## Related ADRs

- **ADR-0043** — Agent Storage (file-first write-through) — informs why session sync is file-watcher-based
- Related to the cross-client-session-sync spec (original SSE implementation)

## References

- Ideation: `specs/sse-resilience-connection-health/01-ideation.md`
- Research: `research/20260324_sse_resilience_production_patterns.md`
- [WHATWG HTML Standard — Server-Sent Events](https://html.spec.whatwg.org/multipage/server-sent-events.html)
- [AWS Architecture Blog — Exponential Backoff and Jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/)
- [MDN: EventSource API](https://developer.mozilla.org/en-US/docs/Web/API/EventSource)
