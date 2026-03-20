# Fix Relay SSE Message Delivery Pipeline

**Status:** Draft
**Authors:** Claude Code, 2026-03-06
**Spec Number:** 95
**Ideation:** `specs/fix-relay-sse-delivery-pipeline/01-ideation.md`

---

## Overview

Fix four compounding bugs in the Relay SSE message delivery pipeline that cause ~40-50% of messages to freeze. The SDK processes messages completely (JSONL has full responses) but response chunks never reach the client SSE stream. This spec addresses: (1) EventSource lifecycle race condition, (2) missing subscribe-first handshake, (3) silent message loss when no subscriber is ready, and (4) missing terminal `done` event on generator errors.

## Background / Problem Statement

When `DORKOS_RELAY_ENABLED=true`, chat messages follow a relay-mediated path: POST publishes to RelayCore, ClaudeCodeAdapter streams SDK events back to `relay.human.console.{clientId}`, and SessionBroadcaster fans those events into the client's SSE stream. Self-test runs show 40-50% of messages freeze — the client shows 0 tokens and a spinning indicator indefinitely.

The backpressure fix (commit ebea3a7, spec `fix-relay-sse-backpressure`) added write queue + drain handling to SessionBroadcaster but did not fix the freeze. The root causes are upstream:

1. **EventSource lifecycle race:** `use-chat-session.ts` lists `isStreaming` as a `useEffect` dependency. When `handleSubmit` sets `status = 'streaming'`, the effect tears down and recreates the EventSource. During the TCP round-trip for the new connection, relay events are published with no SSE subscriber — they go to Maildir but are never drained.

2. **No subscribe-first handshake:** The client fires POST `/messages` immediately. The server returns 202 and CCA begins streaming. If the EventSource isn't connected yet, events are lost.

3. **Maildir stores but never drains:** `publishViaRelay()` registers the console endpoint before publishing, so messages go to Maildir instead of dead-letter. But there is no mechanism to replay Maildir messages when a subscriber later registers. Messages sit unread forever.

4. **No terminal `done` on error:** If `publishResponse()` throws in `claude-code-adapter.ts`, the catch block re-throws without publishing a `done` event. The client hangs indefinitely waiting for the stream to end.

## Goals

- Eliminate SSE stream freezes (0% freeze rate, down from 40-50%)
- All SDK response chunks stream to client in real-time via SSE when Relay is enabled
- GET /messages never returns 503 for valid sessions
- Terminal `done` event is always sent even when SDK generator throws
- Defense-in-depth: pending buffer catches edge cases (reconnects, slow subscribers)

## Non-Goals

- UI-side rendering changes
- Non-Relay (legacy) message path modifications
- Relay persistence/durability (disk-backed queues beyond existing Maildir)
- Session-broadcaster's JSONL file-watching path (working correctly)
- Session ID duality fix (deferred — the current subject-based routing works; the 503 issue is a separate concern tracked independently)

## Technical Dependencies

- Node.js `res.write()` / `drain` event (built-in)
- `chokidar` (existing dependency for file watching)
- RelayCore in-memory pub/sub (`packages/relay/src/relay-core.ts`)
- ClaudeCodeAdapter (`packages/relay/src/adapters/claude-code-adapter.ts`)
- SessionBroadcaster (`apps/server/src/services/session/session-broadcaster.ts`)
- React `useEffect` / `EventSource` (browser built-in)

## Detailed Design

### Fix 1: Stabilize EventSource Lifecycle (Client)

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

**Problem:** The `useEffect` that manages the EventSource has `isStreaming` in its dependency array. When `handleSubmit` calls `setStatus('streaming')`, React re-renders, the effect cleanup fires (closing EventSource A), and the effect re-runs (opening EventSource B). During the TCP handshake for B, relay events are lost.

**Fix:** Remove `isStreaming` from the EventSource `useEffect` dependency array for the Relay path. On the Relay path, the EventSource must remain open continuously — it is the sole delivery channel for response chunks. The EventSource should be opened once when `sessionId` is available and only closed on unmount or session change.

```typescript
// Before: effect deps include isStreaming
useEffect(() => {
  if (!sessionId || (isStreaming && !relayEnabled)) return;
  // ...
}, [sessionId, isStreaming, queryClient, relayEnabled, streamEventHandler]);

// After: relay path keeps EventSource stable
useEffect(() => {
  if (!sessionId) return;
  if (!relayEnabled && isStreaming) return; // Legacy path: close during streaming

  const params = new URLSearchParams();
  if (relayEnabled) {
    params.set('clientId', clientIdRef.current);
  }
  // ... create EventSource ...

  // For relay path, signal readiness
  if (relayEnabled) {
    eventSource.addEventListener('stream_ready', () => {
      streamReadyRef.current = true;
    });
  }

  return () => {
    eventSource.close();
  };
  // relayEnabled path: only sessionId triggers reconnect
  // legacy path: isStreaming still triggers close/reopen
}, [sessionId, relayEnabled ? null : isStreaming, relayEnabled, streamEventHandler]);
```

**Implementation detail:** Use two separate effects — one for the Relay path (deps: `[sessionId, relayEnabled]`) and one for the legacy path (existing behavior). This avoids conditional dependency arrays.

### Fix 2: Subscribe-First Handshake (Server + Client)

**File (server):** `apps/server/src/services/session/session-broadcaster.ts`

**File (server):** `apps/server/src/routes/sessions.ts`

**File (client):** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

**Problem:** POST `/messages` fires before the EventSource SSE connection is confirmed ready. Events published during the gap are lost.

**Fix:** Add a `stream_ready` SSE event that the server sends after `subscribeToRelay()` completes. The client waits for this event before sending the POST.

**Server side — SessionBroadcaster.registerClient():**

After calling `subscribeToRelay(res, clientId)`, send a `stream_ready` event:

```typescript
// In registerClient(), after subscribeToRelay():
if (clientId && this.relay) {
  this.subscribeToRelay(res, clientId);
  sendSSEEvent(res, { type: 'stream_ready', data: { clientId } });
}
```

**Client side — use-chat-session.ts handleSubmit():**

Before sending the POST on the Relay path, wait for `stream_ready`:

```typescript
if (relayEnabled) {
  // Wait for stream_ready (with 5s timeout)
  if (!streamReadyRef.current) {
    await waitForStreamReady(streamReadyRef, 5000);
  }
  await transport.sendMessageRelay(sessionId, finalContent, {
    clientId: clientIdRef.current,
  });
}
```

The `waitForStreamReady` helper polls the ref with a timeout:

```typescript
function waitForStreamReady(
  ref: React.MutableRefObject<boolean>,
  timeoutMs: number
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ref.current) return resolve();
    const start = Date.now();
    const interval = setInterval(() => {
      if (ref.current) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        resolve();
      } // Proceed anyway after timeout
    }, 50);
  });
}
```

On timeout, proceed anyway (best-effort) — the pending buffer (Fix 3) catches early events.

### Fix 3: Pending Buffer in RelayCore

**File:** `packages/relay/src/relay-core.ts`

**Problem:** When CCA publishes to `relay.human.console.{clientId}` and the endpoint is registered but has no active subscriber, messages go to Maildir but are never replayed. There is no mechanism to drain buffered messages when a subscriber registers.

**Fix:** Add a short-lived pending buffer in `SubscriptionRegistry` that captures messages published to subjects with no subscriber. When a subscriber registers, drain the buffer immediately.

**SubscriptionRegistry changes:**

```typescript
interface PendingMessage {
  envelope: RelayEnvelope;
  timestamp: number;
}

class SubscriptionRegistry {
  private pendingBuffers = new Map<string, PendingMessage[]>();
  private readonly PENDING_TTL_MS = 5000; // 5-second buffer

  /** Called by RelayCore when a publish finds no subscriber for the subject */
  bufferForPendingSubscriber(subject: string, envelope: RelayEnvelope): void {
    const buffer = this.pendingBuffers.get(subject) ?? [];
    buffer.push({ envelope, timestamp: Date.now() });
    this.pendingBuffers.set(subject, buffer);
  }

  /** Called when a new subscriber registers — drain pending messages */
  subscribe(subject: string, handler: SubscriptionHandler): () => void {
    // ... existing registration logic ...

    // Drain any pending messages for this subject
    const pending = this.pendingBuffers.get(subject);
    if (pending?.length) {
      const now = Date.now();
      const valid = pending.filter((p) => now - p.timestamp < this.PENDING_TTL_MS);
      this.pendingBuffers.delete(subject);
      // Drain async in next microtask to avoid blocking registration
      queueMicrotask(() => {
        for (const msg of valid) {
          handler(msg.envelope).catch(() => {}); // Best-effort
        }
      });
    }

    return unsubscribe;
  }
}
```

**RelayCore.publish() change:** After `deliverToEndpoint()`, if `dispatchToSubscribers()` found zero subscribers, call `bufferForPendingSubscriber()`:

```typescript
// In publish(), after delivery pipeline:
if (subscriberCount === 0 && matchingEndpoints.length > 0) {
  // Endpoint exists (Maildir) but no live subscriber — buffer for late arrival
  this.subscriptionRegistry.bufferForPendingSubscriber(subject, envelope);
}
```

**Periodic cleanup:** Add a 10-second interval that purges expired entries from `pendingBuffers`. Clean up on `shutdown()`.

### Fix 4: Terminal `done` Event in ClaudeCodeAdapter

**File:** `packages/relay/src/adapters/claude-code-adapter.ts`

**Problem:** In `handleAgentMessage()`, if the `for await` loop throws (e.g., `publishResponse()` fails), the catch block re-throws without sending a terminal `done` event. The client SSE stream hangs indefinitely.

**Fix:** Wrap the streaming loop in try/finally and always publish a `done` event:

```typescript
// In handleAgentMessage(), around the streaming loop:
let streamedDone = false;
try {
  for await (const event of eventStream) {
    if (controller.signal.aborted) break;
    eventCount++;

    if (event.type === 'done') streamedDone = true;

    if (envelope.replyTo && this.relay) {
      await this.publishResponse(envelope, event, ccaSessionKey);
    }
  }
} catch (err) {
  logger.error('[CCA] Streaming error:', err);
  this.deps.traceStore.updateSpan(envelope.id, { status: 'failed', error: String(err) });
} finally {
  clearTimeout(timeout);
  // Always send terminal done if not already sent
  if (!streamedDone && envelope.replyTo && this.relay) {
    try {
      await this.publishResponse(envelope, { type: 'done', data: {} }, ccaSessionKey);
    } catch {
      // Best-effort — if this fails too, client will timeout
    }
  }
}
```

**Additionally**, add a null check on `publishResponse()` return. While `relay.publish()` return is currently void in the adapter, log a warning when `deliveredTo === 0`:

```typescript
private async publishResponse(envelope, event, fromId): Promise<void> {
  if (!this.relay || !envelope.replyTo) return;
  const result = await this.relay.publish(envelope.replyTo, event, opts);
  if (result.deliveredTo === 0 && event.type !== 'done') {
    this.logger.warn(`[CCA] Published ${event.type} to ${envelope.replyTo} but deliveredTo=0`);
  }
}
```

### Fix 5: Clean Up Dead Subscriptions in SessionBroadcaster

**File:** `apps/server/src/services/session/session-broadcaster.ts`

**Problem:** When `res.write()` throws in `subscribeToRelay()`, the subscription is not cancelled. Events continue queuing to a dead connection.

**Fix:** On write error, unsubscribe from relay and clean up:

```typescript
const flush = async () => {
  if (writing) return;
  writing = true;
  while (queue.length > 0) {
    const data = queue.shift()!;
    try {
      const ok = res.write(data);
      if (!ok) {
        await new Promise<void>((resolve) => res.once('drain', resolve));
      }
    } catch (err) {
      logger.error('[SessionBroadcaster] Write error, unsubscribing relay:', err);
      unsub(); // Clean up the relay subscription
      this.relaySubscriptions.delete(res);
      break;
    }
  }
  writing = false;
};
```

## User Experience

No visible changes. Users will experience:

- Messages stream reliably (no more freezes)
- No more need to click Stop and resend
- History loads correctly after page refresh

## Testing Strategy

### Unit Tests

**`session-broadcaster.test.ts`:**

1. `subscribeToRelay flush serialization` — Verify that rapid sequential relay publishes are flushed in order, even when `res.write()` triggers backpressure (returns false, then drains).
2. `subscribeToRelay write error cleanup` — Verify that when `res.write()` throws, the relay subscription is cancelled and the response is cleaned up.
3. `stream_ready event sent after relay subscribe` — Verify `registerClient()` sends `stream_ready` SSE event when relay is enabled and clientId is provided.

**`relay-core.test.ts` / `subscription-registry.test.ts`:** 4. `pending buffer captures messages with no subscriber` — Publish to a subject with no subscriber, verify message is buffered. 5. `pending buffer drains on subscriber registration` — Buffer messages, then register a subscriber, verify subscriber receives buffered messages in order. 6. `pending buffer expires after TTL` — Buffer a message, wait >5s, register subscriber, verify message is NOT delivered. 7. `pending buffer cleanup removes expired entries` — Verify periodic cleanup purges stale buffers.

**`claude-code-adapter.test.ts`:** 8. `done event sent on generator error` — Mock SDK generator to throw mid-stream, verify `done` event is published via relay. 9. `done event sent on publishResponse error` — Mock `relay.publish()` to throw, verify `done` event is still sent in the finally block. 10. `deliveredTo=0 logged as warning` — Verify warning log when publish returns `deliveredTo: 0`.

### Integration Tests

**`use-chat-session` hook test:** 11. `relay path waits for stream_ready before POST` — Mock EventSource to fire `stream_ready` after 100ms delay, verify POST is not sent until after the event. 12. `relay path EventSource stable during streaming` — Verify EventSource is NOT torn down when `isStreaming` changes on the relay path.

### Manual Testing (via `/chat:self-test`)

13. Enable Relay, send 10 messages, verify 0 freezes (was 40-50%).
14. Send rapid-fire messages (3 within 1 second), verify all stream correctly.
15. Refresh page mid-stream, verify history loads and new messages work.

## Performance Considerations

- **Pending buffer memory:** Bounded by 5-second TTL and per-subject scope. Each console subject (`relay.human.console.{clientId}`) has at most one active message flow. Memory overhead is negligible (~1KB per buffered event, <50 events in a 5-second window).
- **Drain microtask:** Uses `queueMicrotask()` to avoid blocking subscriber registration. Buffered messages are delivered asynchronously.
- **Periodic cleanup interval:** 10-second timer for pending buffer cleanup. Lightweight — just iterates a Map and checks timestamps.

## Security Considerations

No new security surface. All changes are within existing authenticated/authorized paths. The pending buffer is scoped to registered endpoints only — no new attack vector.

## Documentation

- Update `contributing/architecture.md` Relay section to document the subscribe-first handshake pattern
- Update `specs/fix-relay-sse-backpressure/04-implementation.md` to reference this spec as the follow-up fix

## Implementation Phases

### Phase 1: Core Delivery Fixes (Critical Path)

1. **Fix EventSource lifecycle** — Remove `isStreaming` dependency on relay path, split into two effects
2. **Add subscribe-first handshake** — `stream_ready` event + client wait logic
3. **Add terminal `done` in CCA finally block** — try/catch/finally wrapper
4. **Clean up dead subscriptions** — Unsubscribe on write error

### Phase 2: Defense-in-Depth

5. **Add pending buffer** — `SubscriptionRegistry` buffer + drain-on-subscribe + TTL cleanup
6. **Add `deliveredTo=0` warning logging** — Observability for future debugging

### Phase 3: Verification

7. **Unit tests** — All 10 unit tests listed above
8. **Manual verification** — `/chat:self-test` with Relay enabled, target 0% freeze rate
9. **Update documentation**

## Open Questions

_None — all decisions resolved during ideation._

## Related ADRs

- **ADR-0026**: Receipt-plus-SSE console protocol — defines the `relay_message` event type and 202 receipt pattern
- **ADR-0029**: Replace message-receiver with ClaudeCodeAdapter — CCA architecture
- **ADR-0013**: Hybrid Maildir-SQLite storage — explains why messages go to Maildir but aren't replayed
- **ADR-0018**: Server-side SSE subject filtering — SessionBroadcaster's relay subscription pattern
- **ADR-0075**: Promise-chain queue for CCA concurrency — CCA's serialization model

## References

- Ideation: `specs/fix-relay-sse-delivery-pipeline/01-ideation.md`
- Research: `research/20260306_sse_relay_delivery_race_conditions.md`
- Previous fix: `specs/fix-relay-sse-backpressure/04-implementation.md` (commit ebea3a7)
- Self-test findings: `plans/2026-03-06-chat-self-test-findings.md`, `plans/2026-03-06-chat-self-test-findings-2.md`
- Mercure dual-buffer design: https://mercure.rocks/spec
- MCP Streamable HTTP: subscribe-first pattern reference
