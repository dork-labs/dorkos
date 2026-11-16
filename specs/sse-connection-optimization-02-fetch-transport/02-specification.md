---
slug: sse-connection-optimization-02-fetch-transport
number: 188
created: 2026-03-27
status: specification
---

# SSE Connection Optimization Phase 2 — Fetch-Based SSE Transport

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-03-27
**Spec:** #188
**Project:** sse-connection-optimization (Phase 2 of 2)
**Depends on:** Phase 1 (#187, implemented)
**Source:** `specs/sse-connection-optimization-02-fetch-transport/01-ideation.md`

---

## Overview

Replace `EventSource` with `fetch()` + `ReadableStream` inside `SSEConnection`, extend `parseSSEStream` for full SSE spec compliance, and add refetch-on-reconnect cache invalidation. This removes `EventSource` limitations (HTTP/1.1-only, no custom headers, GET-only, opaque error events) while preserving the identical public API. Consumers require zero changes.

## Background / Problem Statement

After Phase 1, the client uses `SSEConnection` (wrapping `EventSource`) for persistent SSE streams. `EventSource` has fundamental limitations:

1. **HTTP/1.1 only** — cannot use HTTP/2 multiplexing even when the server supports it via a reverse proxy. Each `EventSource` consumes a dedicated TCP connection from the browser's per-origin pool (6 max).
2. **No custom headers** — cannot send `Authorization`, `X-Client-Id`, or `Last-Event-ID` as a request header.
3. **GET-only** — no control over HTTP method.
4. **Opaque errors** — `EventSource.onerror` provides no status code, no response headers, no error detail.
5. **Uncontrolled retry** — browser auto-reconnects with its own strategy; `SSEConnection` already reimplements reconnection, heartbeat watchdog, and visibility optimization on top.

Additionally, SSE events missed during disconnect windows (tab switch > 30s, network blip, server restart) leave TanStack Query caches stale until the next refetch cycle.

The `sendMessage()` flow in `HttpTransport` already uses `fetch()` + `parseSSEStream` successfully — this spec adopts the same proven pattern for persistent SSE streams.

## Goals

- Replace `EventSource` with `fetch()` + `ReadableStream` in `SSEConnection`
- Preserve identical public API — zero consumer changes
- Add custom header support to `SSEConnection` constructor
- Extend `parseSSEStream` to full SSE spec compliance (`id:`, `retry:`, comments, multi-line `data:`)
- Implement `Last-Event-ID` tracking (memory-only, sent as header on reconnect)
- Honor server `retry:` field as a backoff floor
- Add refetch-on-reconnect: invalidate TanStack Query caches when connection recovers
- Enable HTTP/2 multiplexing when behind a reverse proxy (Caddy)

## Non-Goals

- Adding HTTP/2 to Express directly (use Caddy as reverse proxy)
- WebSocket or WebTransport migration
- Server-side changes (no event IDs, no replay buffer)
- Adding Caddy to `pnpm dev` workflow
- Changes to `useSSEConnection` hook public API
- Adding `eventsource-parser` or any external SSE parsing dependency

## Technical Dependencies

- **Browser APIs:** `fetch()`, `ReadableStream`, `AbortController`, `AbortSignal.any()`, `TextDecoder`
- **Internal:** `parseSSEStream` from `sse-parser.ts`, `SSE_RESILIENCE` constants from `constants.ts`
- **TanStack Query:** `QueryClient.invalidateQueries()` for refetch-on-reconnect
- **Caddy** (optional, verification only): Reverse proxy for HTTP/2 termination

No new external dependencies.

## Detailed Design

### 1. `parseSSEStream` Extensions

**File:** `apps/client/src/layers/shared/lib/transport/sse-parser.ts`

The current parser handles `event:` and `data:` fields only. Extend to full SSE spec compliance:

#### 1.1 Updated `SSEEvent` Interface

```typescript
export interface SSEEvent<T = unknown> {
  type: string;
  data: T;
  id?: string; // From SSE id: field
  retry?: number; // From SSE retry: field (ms)
  comment?: boolean; // True for comment lines (: prefix)
}
```

#### 1.2 Field Parsing Additions

| SSE Field   | Current                  | After                    | Behavior                                                                                                                         |
| ----------- | ------------------------ | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `event:`    | Parsed                   | No change                | Sets event type                                                                                                                  |
| `data:`     | Single line, JSON-parsed | Multi-line concatenation | Multiple `data:` lines joined with `\n`, then JSON-parsed                                                                        |
| `id:`       | Ignored                  | Parsed                   | Yielded as `event.id`, stored for `Last-Event-ID`                                                                                |
| `retry:`    | Ignored                  | Parsed                   | Yielded as `event.retry` (integer ms), consumed by `SSEConnection` for backoff floor                                             |
| `:` comment | Ignored                  | Pass-through             | Yielded as `{ type: 'comment', data: commentText, comment: true }` — enables heartbeat watchdog reset for `: keepalive` comments |
| Empty line  | Implicit dispatch        | Explicit dispatch        | Empty line after field accumulation triggers event yield (per SSE spec)                                                          |

#### 1.3 Parsing Algorithm

Replace the current line-by-line approach with spec-compliant field accumulation:

```typescript
export async function* parseSSEStream<T = unknown>(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  options?: { onParseError?: 'skip' | 'throw' }
): AsyncGenerator<SSEEvent<T>> {
  const decoder = new TextDecoder();
  const errorMode = options?.onParseError ?? 'skip';
  let buffer = '';

  // Field accumulators (reset on empty line)
  let eventType = '';
  let dataLines: string[] = [];
  let eventId = '';
  let retryMs: number | undefined;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        // Flush any pending event on stream end
        if (dataLines.length > 0) {
          yield* flushEvent();
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (line === '') {
          // Empty line = dispatch accumulated event
          if (dataLines.length > 0) {
            yield* flushEvent();
          }
          continue;
        }

        if (line.startsWith(':')) {
          // Comment line — yield for heartbeat watchdog
          yield { type: 'comment', data: line.slice(1).trim() as T, comment: true };
          continue;
        }

        const colonIdx = line.indexOf(':');
        if (colonIdx === -1) continue; // Malformed, skip

        const field = line.slice(0, colonIdx);
        // Value starts after ': ' (space after colon is optional per spec)
        const value =
          line[colonIdx + 1] === ' ' ? line.slice(colonIdx + 2) : line.slice(colonIdx + 1);

        switch (field) {
          case 'event':
            eventType = value;
            break;
          case 'data':
            dataLines.push(value);
            break;
          case 'id':
            if (!value.includes('\0')) eventId = value; // Spec: ignore if contains NULL
            break;
          case 'retry':
            const parsed = parseInt(value, 10);
            if (!isNaN(parsed) && parsed >= 0) retryMs = parsed;
            break;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  function* flushEvent(): Generator<SSEEvent<T>> {
    const rawData = dataLines.join('\n');
    let data: T;
    try {
      data = JSON.parse(rawData) as T;
    } catch {
      if (errorMode === 'throw') throw new Error('Malformed SSE JSON');
      data = rawData as T;
    }

    const event: SSEEvent<T> = {
      type: eventType || 'message',
      data,
    };
    if (eventId) event.id = eventId;
    if (retryMs !== undefined) event.retry = retryMs;

    yield event;

    // Reset accumulators (id persists across events per spec, but type resets)
    eventType = '';
    dataLines = [];
    retryMs = undefined;
    // Note: eventId is NOT reset — per SSE spec, id persists until changed
  }
}
```

**Key behaviors:**

- Multi-line `data:` fields concatenated with `\n` before JSON parsing
- Comment lines (`: keepalive`) yielded as events with `comment: true` for watchdog reset
- `id:` persists across events until changed (per SSE spec)
- `retry:` yielded per-event for `SSEConnection` to consume
- Empty line triggers event dispatch (spec-compliant)
- Backward compatible — existing `sendMessage()` callers see no change (they never receive `id:`, `retry:`, or comment events from the server)

### 2. `SSEConnection` Refactor

**File:** `apps/client/src/layers/shared/lib/transport/sse-connection.ts`

#### 2.1 Updated Options Interface

```typescript
export interface SSEConnectionOptions {
  eventHandlers: Record<string, (data: unknown) => void>;
  onStateChange?: (state: ConnectionState, failedAttempts: number) => void;
  onError?: (error: Error) => void; // Changed: Error instead of Event (richer info)
  /** Custom headers to send with each fetch request. */
  headers?: Record<string, string>;
  heartbeatTimeoutMs?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  disconnectedThreshold?: number;
  stabilityWindowMs?: number;
}
```

**API change:** `onError` receives an `Error` (with HTTP status, message) instead of a generic `Event`. This is a minor improvement — existing callers that ignore the error argument are unaffected.

#### 2.2 Internal State Changes

Replace:

```typescript
private eventSource: EventSource | null = null;
```

With:

```typescript
private abortController: AbortController | null = null;
private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
private lastEventId: string | null = null;     // Last-Event-ID tracking
private serverRetryMs: number | null = null;   // Server retry: field
```

#### 2.3 `connect()` Implementation

```typescript
connect(): void {
  if (this.destroyed) return;
  this.closeConnection();
  this.setState('connecting');

  // New AbortController per connection attempt — never reuse
  const controller = new AbortController();
  this.abortController = controller;

  this.openFetchConnection(controller);
}

private async openFetchConnection(controller: AbortController): Promise<void> {
  try {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      ...this.options.headers,
    };

    // Send Last-Event-ID on reconnect (per SSE spec)
    if (this.lastEventId) {
      headers['Last-Event-ID'] = this.lastEventId;
    }

    const response = await fetch(this.url, {
      headers,
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    if (controller.signal.aborted) return; // Aborted during fetch

    this.setState('connected');
    this.startStabilityTimer();
    this.resetWatchdog();

    const reader = response.body!.getReader();
    this.reader = reader;

    for await (const event of parseSSEStream(reader)) {
      if (controller.signal.aborted) break;

      this.lastEventAt = Date.now();
      this.resetWatchdog();

      // Track Last-Event-ID
      if (event.id !== undefined) {
        this.lastEventId = event.id;
      }

      // Track server retry hint
      if (event.retry !== undefined) {
        this.serverRetryMs = event.retry;
      }

      // Comment lines reset watchdog but don't dispatch to handlers
      if (event.comment) continue;

      // Dispatch to event handler
      const handler = this.options.eventHandlers[event.type];
      if (handler) {
        handler(event.data);
      }
    }

    // Stream ended cleanly (server closed) — treat as connection error
    if (!controller.signal.aborted) {
      this.handleConnectionError(new Error('Stream ended'));
    }
  } catch (err) {
    if (controller.signal.aborted) return; // Expected abort — don't retry
    this.handleConnectionError(
      err instanceof Error ? err : new Error(String(err))
    );
  }
}
```

#### 2.4 `closeConnection()` (replaces `closeEventSource()`)

```typescript
private closeConnection(): void {
  if (this.abortController) {
    this.abortController.abort();
    this.abortController = null;
  }
  this.reader = null;
}
```

#### 2.5 Updated `handleConnectionError()`

```typescript
private handleConnectionError(error?: Error): void {
  this.closeConnection();
  this.clearTimers();
  this.failedAttempts++;

  if (error) {
    this.options.onError(error);
  }

  if (this.failedAttempts >= this.options.disconnectedThreshold) {
    this.setState('disconnected');
    return;
  }

  this.setState('reconnecting');
  const delay = this.calculateBackoff();
  this.backoffTimer = setTimeout(() => {
    this.backoffTimer = null;
    this.connect();
  }, delay);
}
```

#### 2.6 Updated `calculateBackoff()` (retry: floor)

```typescript
private calculateBackoff(): number {
  const exponential = Math.min(
    this.options.backoffCapMs,
    this.options.backoffBaseMs * Math.pow(2, this.failedAttempts)
  );
  const clientDelay = Math.random() * exponential;

  // Honor server retry: field as floor (never delay less than server requests)
  if (this.serverRetryMs !== null) {
    return Math.max(clientDelay, this.serverRetryMs);
  }
  return clientDelay;
}
```

#### 2.7 Updated Visibility Optimization

```typescript
enableVisibilityOptimization(graceMs: number = SSE_RESILIENCE.VISIBILITY_GRACE_MS): void {
  if (this.visibilityHandler) return;

  this.visibilityHandler = () => {
    if (document.hidden) {
      this.visibilityGraceTimer = setTimeout(() => {
        this.visibilityGraceTimer = null;
        this.closeConnection();    // Was: closeEventSource()
        this.clearTimers();
      }, graceMs);
    } else {
      if (this.visibilityGraceTimer) {
        clearTimeout(this.visibilityGraceTimer);
        this.visibilityGraceTimer = null;
      }
      // Was: !this.eventSource || this.eventSource.readyState === EventSource.CLOSED
      if (!this.abortController || this.abortController.signal.aborted) {
        this.connect();
      }
    }
  };

  document.addEventListener('visibilitychange', this.visibilityHandler);
}
```

#### 2.8 Updated `disconnect()` and `destroy()`

```typescript
disconnect(): void {
  this.closeConnection();    // Was: closeEventSource()
  this.clearAllTimers();
  if (this.state !== 'disconnected') {
    this.setState('disconnected');
  }
}

destroy(): void {
  this.destroyed = true;
  this.closeConnection();    // Was: closeEventSource()
  this.clearAllTimers();
  if (this.visibilityHandler) {
    document.removeEventListener('visibilitychange', this.visibilityHandler);
    this.visibilityHandler = null;
  }
}
```

#### 2.9 Complete Public API (Unchanged)

| Method                           | Signature                                      | Change                                    |
| -------------------------------- | ---------------------------------------------- | ----------------------------------------- |
| `constructor`                    | `(url: string, options: SSEConnectionOptions)` | Added optional `headers` field to options |
| `connect()`                      | `(): void`                                     | No change                                 |
| `disconnect()`                   | `(): void`                                     | No change                                 |
| `destroy()`                      | `(): void`                                     | No change                                 |
| `enableVisibilityOptimization()` | `(graceMs?: number): void`                     | No change                                 |
| `getState()`                     | `(): ConnectionState`                          | No change                                 |
| `getFailedAttempts()`            | `(): number`                                   | No change                                 |
| `getLastEventAt()`               | `(): number \| null`                           | No change                                 |

### 3. Refetch-on-Reconnect

**File:** `apps/client/src/layers/shared/model/event-stream-context.tsx`

When `SSEConnection` transitions from `reconnecting` → `connected`, invalidate TanStack Query caches to eliminate stale data from the disconnect window.

#### 3.1 Implementation

Add a previous-state ref to the `onStateChange` callback in the singleton factory:

```typescript
let previousConnectionState: ConnectionState = 'connecting';

function getOrCreateConnection(): SSEConnection {
  // ... existing code ...

  const conn = new SSEConnection('/api/events', {
    eventHandlers: buildEventHandlers(),
    onStateChange: (state, attempts) => {
      // Refetch-on-reconnect: invalidate caches when recovering from disconnect
      if (state === 'connected' && previousConnectionState === 'reconnecting') {
        // Lazy import to avoid circular dependency
        import('./query-client').then(({ queryClient }) => {
          queryClient.invalidateQueries();
        });
      }
      previousConnectionState = state;

      for (const listener of stateListeners) {
        listener(state, attempts);
      }
    },
  });

  // ... rest unchanged ...
}
```

**Design notes:**

- Lazy `import()` avoids circular dependency between event-stream-context and query-client
- `invalidateQueries()` with no arguments invalidates all active queries — this is intentional since any query could be stale after a disconnect
- Only triggers on `reconnecting` → `connected` (not on initial `connecting` → `connected`)
- The `previousConnectionState` is module-level alongside the singleton — preserved across HMR via `import.meta.hot.data`

#### 3.2 HMR Preservation

```typescript
let previousConnectionState: ConnectionState =
  (import.meta.hot?.data?.previousConnectionState as ConnectionState | undefined) ?? 'connecting';

// In getOrCreateConnection, after conn creation:
if (import.meta.hot?.data) {
  // ... existing preservation ...
  import.meta.hot.data.previousConnectionState = previousConnectionState;
}
```

### 4. HTTP/2 Verification (Caddy)

**File:** `docker-compose.caddy.yml` (new, project root)

Provide an optional Caddy configuration for verifying HTTP/2 multiplexing:

```yaml
services:
  caddy:
    image: caddy:2-alpine
    ports:
      - '443:443'
    volumes:
      - ./Caddyfile.dev:/etc/caddy/Caddyfile
    extra_hosts:
      - 'host.docker.internal:host-gateway'
```

**File:** `Caddyfile.dev` (new, project root)

```
localhost {
  reverse_proxy host.docker.internal:6242
}
```

**Verification procedure:**

1. Start DorkOS dev server: `pnpm dev`
2. Start Caddy: `docker compose -f docker-compose.caddy.yml up`
3. Open `https://localhost` in Chrome
4. DevTools → Network → right-click column header → enable "Protocol" and "Connection ID"
5. Verify two concurrent SSE streams (`/api/events` + session sync) show `h2` protocol and share the same Connection ID

## User Experience

No visible changes — this is an internal transport refactor. Users benefit from:

- **Faster reconnection** after tab switches (no behavioral change, but the groundwork enables HTTP/2 multiplexing in production)
- **Zero stale data** after disconnects (refetch-on-reconnect ensures dashboard, sessions, and relay state are current)
- **Custom header support** enables future features like per-request authentication tokens

## Testing Strategy

### Unit Tests: `parseSSEStream` Extensions

**File:** `apps/client/src/layers/shared/lib/transport/__tests__/sse-parser.test.ts`

New tests for spec compliance:

| Test                                         | Purpose                                                     |
| -------------------------------------------- | ----------------------------------------------------------- |
| `yields id field from SSE stream`            | Verify `event.id` populated from `id:` line                 |
| `id persists across events until changed`    | SSE spec: id is sticky                                      |
| `id with NULL byte is ignored`               | SSE spec: `id` containing `\0` must be ignored              |
| `yields retry field as integer ms`           | Verify `event.retry` from `retry:` line                     |
| `ignores non-numeric retry values`           | Only valid integers accepted                                |
| `yields comment lines with comment flag`     | `: keepalive` → `{ type: 'comment', comment: true }`        |
| `concatenates multi-line data with newline`  | `data: a\ndata: b` → parsed data is `"a\nb"`                |
| `dispatches on empty line (spec-compliant)`  | Empty line between fields triggers yield                    |
| `handles field with no space after colon`    | `data:value` (no space) works per spec                      |
| `existing sendMessage streaming still works` | Regression: existing flow with `event:` + `data:` unchanged |

### Unit Tests: `SSEConnection` Refactor

**File:** `apps/client/src/layers/shared/lib/transport/__tests__/sse-connection.test.ts`

The existing test suite (592 lines, 25+ tests) tests behavior, not implementation. The mock strategy changes from `MockEventSource` to a `MockFetch` helper:

#### Mock Strategy

Replace `vi.stubGlobal('EventSource', MockEventSource)` with:

```typescript
function createMockSSEStream() {
  const { readable, writable } = new TransformStream<Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  return {
    readable,
    writer,
    /** Send an SSE event through the mock stream. */
    sendEvent(type: string, data: unknown) {
      writer.write(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`));
    },
    /** Send a heartbeat comment. */
    sendHeartbeat() {
      writer.write(encoder.encode(': heartbeat\n\n'));
    },
    /** Simulate connection close. */
    close() {
      writer.close();
    },
    /** Simulate connection error. */
    error(err: Error) {
      writer.abort(err);
    },
  };
}

let mockStream: ReturnType<typeof createMockSSEStream>;

beforeEach(() => {
  vi.useFakeTimers();
  mockStream = createMockSSEStream();

  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      body: mockStream.readable,
    })
  );
});
```

#### Test Mapping

All existing behavioral tests remain, with mock method updates:

| Old Pattern                                          | New Pattern                                                                |
| ---------------------------------------------------- | -------------------------------------------------------------------------- |
| `MockEventSource.latest().simulateOpen()`            | `await vi.advanceTimersToNextTimerAsync()` (fetch resolves, stream starts) |
| `MockEventSource.latest().simulateError()`           | `mockStream.error(new Error('connection lost'))` or `mockStream.close()`   |
| `MockEventSource.latest().simulateEvent(type, data)` | `mockStream.sendEvent(type, data)`                                         |
| `MockEventSource.instances.length`                   | `vi.mocked(fetch).mock.calls.length`                                       |
| `MockEventSource.latest().readyState === CLOSED`     | Check `abortController.signal.aborted` (via connection state)              |

#### New Tests

| Test                                            | Purpose                                                   |
| ----------------------------------------------- | --------------------------------------------------------- |
| `sends custom headers in fetch request`         | Verify `headers` option flows to `fetch()`                |
| `sends Last-Event-ID header on reconnect`       | After receiving `id:` event, reconnect includes header    |
| `honors server retry: as backoff floor`         | After receiving `retry: 5000`, backoff is at least 5000ms |
| `resets watchdog on comment lines`              | `: keepalive` prevents heartbeat timeout                  |
| `handles HTTP error responses`                  | 4xx/5xx triggers `handleConnectionError` with status info |
| `handles fetch network error`                   | `TypeError: Failed to fetch` triggers reconnection        |
| `aborts fetch on disconnect()`                  | Calling `disconnect()` aborts the in-flight fetch         |
| `aborts fetch on visibility hide`               | Tab hidden + grace period → fetch aborted                 |
| `creates new AbortController on each connect()` | Never reuse aborted controllers                           |

### Integration Test: Refetch-on-Reconnect

**File:** `apps/client/src/layers/shared/model/__tests__/event-stream-context.test.tsx`

| Test                                                         | Purpose                                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `invalidates queries on reconnecting → connected transition` | Verify `queryClient.invalidateQueries()` called when state goes reconnecting → connected |
| `does not invalidate on initial connecting → connected`      | First connection should not trigger invalidation                                         |
| `does not invalidate on connected → connected (no-op)`       | Same-state transition is ignored                                                         |

## Performance Considerations

- **Bundle size:** Zero new bytes. Swapping `EventSource` (browser API) for `fetch` (browser API). Parser grows ~54 → ~120 lines — negligible.
- **Memory:** `lastEventId` adds one string field. `serverRetryMs` adds one number field.
- **CPU:** `parseSSEStream` does slightly more work per line (field switching vs. prefix matching). Negligible for SSE event rates (~1 event/second sustained, ~15s heartbeat interval).
- **HTTP/2 multiplexing:** When behind a reverse proxy, two concurrent `fetch()`-based SSE streams share a single TCP connection instead of consuming two from the browser's 6-per-origin pool. This is the primary performance benefit.
- **Refetch-on-reconnect:** `queryClient.invalidateQueries()` triggers refetches for all active queries. This is a burst of ~5-10 requests on reconnect, which is acceptable for a once-per-disconnect event.

## Security Considerations

- **Custom headers:** The `headers` option enables passing `Authorization` tokens for future authenticated SSE endpoints. Headers are same-origin only (no CORS implications for the current setup).
- **AbortController:** Proper cleanup prevents resource leaks. The `finally` block in `parseSSEStream` calls `reader.releaseLock()`, and `closeConnection()` calls `controller.abort()`.
- **Last-Event-ID:** Memory-only storage. No `localStorage` or `sessionStorage` — IDs are per-page-lifetime and cannot leak across sessions.
- **`id:` field sanitization:** Per SSE spec, `id:` values containing NULL byte (`\0`) are ignored (prevents injection).

## Documentation

- **No external docs needed** — this is an internal transport refactor with no public API changes.
- **Caddy config:** Document in `docker-compose.caddy.yml` comments for production HTTP/2 setup.
- **Contributing guide:** No update needed — `contributing/api-reference.md` describes server-side SSE, not client transport.

## Implementation Phases

### Phase 1: Extend `parseSSEStream`

- Add `id:`, `retry:`, comment line, and multi-line `data:` support
- Write new parser tests
- Verify existing `sendMessage()` flow is unaffected (regression test)

### Phase 2: Refactor `SSEConnection`

- Replace `EventSource` with `fetch()` + `ReadableStream` + `AbortController`
- Add `headers` option, `Last-Event-ID` tracking, `retry:` floor
- Update test mock strategy (EventSource → fetch)
- Verify all existing behavioral tests pass

### Phase 3: Wire Refetch-on-Reconnect

- Add `reconnecting` → `connected` detection in `event-stream-context.tsx`
- Invalidate TanStack Query caches on transition
- Write integration test
- Preserve across HMR

### Phase 4: HTTP/2 Verification

- Create `docker-compose.caddy.yml` and `Caddyfile.dev`
- Manual verification procedure (Chrome DevTools Protocol column)
- Document in compose file comments

## Open Questions

No open questions — all decisions resolved during ideation.

## Related ADRs

- **ADR-0189:** Shared SSE Resilience Primitive — established `SSEConnection` as the unified SSE connection manager
- **ADR-0190:** SSE Page Visibility Optimization — defined grace period + immediate reconnect pattern
- **ADR-0204:** Consolidate SSE Connections into Unified Stream — Phase 1, unified `/api/events` endpoint
- **ADR-0205:** Use SSE Event Field for Multiplexed Stream Routing — event-based routing in unified stream

## References

- **Ideation:** `specs/sse-connection-optimization-02-fetch-transport/01-ideation.md`
- **Brief:** `specs/sse-connection-optimization-02-fetch-transport/00-brief.md`
- **Research:** `research/20260327_fetch_sse_transport_migration.md`
- **Phase 1 Spec:** `specs/sse-connection-optimization-01-consolidate/02-specification.md`
- **SSE Resilience Spec:** `specs/sse-resilience-connection-health/02-specification.md`
- **SSE Spec (WHATWG):** https://html.spec.whatwg.org/multipage/server-sent-events.html
- **`eventsource-parser`:** https://github.com/rexxars/eventsource-parser (design reference, not a dependency)
- **Caddy:** https://caddyserver.com/ (reverse proxy for HTTP/2 termination)
