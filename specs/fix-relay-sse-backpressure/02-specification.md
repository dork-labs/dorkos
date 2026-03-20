# Fix Relay SSE Backpressure in Session Broadcaster

**Status:** Draft
**Authors:** Claude (chat:self-test), 2026-03-06
**Slug:** `fix-relay-sse-backpressure`

---

## Overview

Apply the same SSE backpressure fix from `stream-adapter.ts` (commit `1352e31`) to `session-broadcaster.ts`. The broadcaster's relay subscription and sync_update writes both use synchronous `res.write()` without drain handling, causing SSE stream freezes when Relay is enabled.

---

## Background / Problem Statement

Commit `1352e31` fixed SSE backpressure in `stream-adapter.ts:sendSSEEvent()` by making `res.write()` async with drain handling. However, `session-broadcaster.ts` has **two additional write sites** that were not fixed:

1. **Line 186** — Relay subscription callback writes `relay_message` events
2. **Line 324** — `broadcastUpdate()` writes `sync_update` events

A `/chat:self-test` run on 2026-03-06 confirmed the SSE freeze persists: 3 of 5 messages froze for 60-80+ seconds. Content completed in ~15s but the stop button stayed visible. Response text was also truncated in the UI (JSONL had full content). Both symptoms trace to the non-async `res.write()` in `session-broadcaster.ts`.

The broadcaster's writes bypass `sendSSEEvent()` entirely — they format SSE strings inline and call `res.write()` directly. This is why the `stream-adapter.ts` fix didn't help.

**Evidence:** `plans/2026-03-06-chat-self-test-findings.md`
**Prior spec:** `specs/chat-streaming-session-reliability/02-specification.md` (Fix 1 noted "Any other call sites... must also be updated" but the commit didn't cover session-broadcaster)

---

## Goals

- Relay `relay_message` events stream to completion without SSE freeze
- `sync_update` broadcasts don't stall under backpressure
- Stop button disappears naturally when response completes
- Full response text renders during streaming (no truncation)

## Non-Goals

- Refactoring session-broadcaster architecture
- Changing the relay subscription model
- Addressing non-relay SSE paths (already fixed)

---

## Technical Dependencies

| Dependency                            | Notes                                               |
| ------------------------------------- | --------------------------------------------------- |
| Node.js `http.ServerResponse.write()` | Returns `boolean`; `drain` event on socket          |
| `session-broadcaster.ts`              | Current synchronous `res.write()` calls             |
| `stream-adapter.ts`                   | Reference implementation of the async drain pattern |

No new libraries. No schema changes.

---

## Detailed Design

### Fix 1: Relay Subscription Writes (line 186)

**Current code** (`session-broadcaster.ts:176-193`):

```typescript
private subscribeToRelay(res: Response, clientId: string): void {
  const subject = `relay.human.console.${clientId}`;
  const unsub = this.relay!.subscribe(subject, (envelope) => {
    const eventData = `event: relay_message\ndata: ${JSON.stringify({
      messageId: envelope.id,
      payload: envelope.payload,
      subject: envelope.subject,
    })}\n\n`;

    try {
      res.write(eventData);  // ← synchronous, ignores backpressure
    } catch (err) {
      logger.error(`[SessionBroadcaster] Failed to write relay event to client:`, err);
    }
  });

  this.relaySubscriptions.set(res, unsub);
}
```

**Problem:** The relay `subscribe()` callback is synchronous. When `res.write()` returns `false` (buffer full), the callback ignores it. Subsequent writes may stall or be buffered out of order. The `done` event gets delayed, leaving the client in `streaming` status indefinitely.

**Fix:** Queue writes and process them sequentially with drain handling. Since the subscribe callback is synchronous, we need a write queue:

```typescript
private subscribeToRelay(res: Response, clientId: string): void {
  const subject = `relay.human.console.${clientId}`;
  let writing = false;
  const queue: string[] = [];

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
        logger.error(`[SessionBroadcaster] Failed to write relay event to client:`, err);
        break;
      }
    }
    writing = false;
  };

  const unsub = this.relay!.subscribe(subject, (envelope) => {
    const eventData = `event: relay_message\ndata: ${JSON.stringify({
      messageId: envelope.id,
      payload: envelope.payload,
      subject: envelope.subject,
    })}\n\n`;
    queue.push(eventData);
    void flush();
  });

  this.relaySubscriptions.set(res, unsub);
}
```

### Fix 2: Sync Update Broadcasts (line 324)

**Current code** (`session-broadcaster.ts:320-332`):

```typescript
const eventData = `event: sync_update\ndata: ${JSON.stringify(event)}\n\n`;

for (const client of Array.from(clientSet)) {
  try {
    client.write(eventData);  // ← synchronous, ignores backpressure
  } catch (err) {
    logger.error(...);
  }
}
```

**Fix:** Apply async drain handling:

```typescript
const eventData = `event: sync_update\ndata: ${JSON.stringify(event)}\n\n`;

for (const client of Array.from(clientSet)) {
  try {
    const ok = client.write(eventData);
    if (!ok) {
      await new Promise<void>((resolve) => client.once('drain', resolve));
    }
  } catch (err) {
    logger.error(...);
  }
}
```

The `broadcastUpdate` method must become `async`. This is safe since callers don't depend on its return value (it's called from chokidar file watcher callbacks).

---

## Testing Strategy

### Unit Tests (`apps/server/src/services/session/__tests__/session-broadcaster.test.ts`)

```typescript
describe('relay subscription backpressure', () => {
  it('waits for drain when write returns false', async () => {
    // Purpose: verify relay_message events don't stall under backpressure
    const mockRes = createMockResponse();
    mockRes.write.mockReturnValueOnce(false).mockReturnValue(true);

    // Simulate relay message delivery
    broadcaster.subscribeToRelay(mockRes, 'test-client');
    relayMock.triggerMessage({ id: '1', payload: { type: 'done', data: {} }, subject: 'test' });

    await vi.waitFor(() => {
      expect(mockRes.once).toHaveBeenCalledWith('drain', expect.any(Function));
    });
  });

  it('preserves event order under backpressure', async () => {
    // Purpose: verify events arrive in correct sequence even when buffered
    const mockRes = createMockResponse();
    const writes: string[] = [];
    mockRes.write.mockImplementation((data: string) => {
      writes.push(data);
      return writes.length !== 2; // backpressure on second write
    });

    broadcaster.subscribeToRelay(mockRes, 'test-client');
    relayMock.triggerMessage({ id: '1', payload: { type: 'text_delta', data: { text: 'a' } } });
    relayMock.triggerMessage({ id: '2', payload: { type: 'text_delta', data: { text: 'b' } } });
    relayMock.triggerMessage({ id: '3', payload: { type: 'done', data: {} } });

    // Simulate drain
    mockRes.once.mock.calls[0][1]();

    await vi.waitFor(() => {
      expect(writes).toHaveLength(3);
      expect(writes[0]).toContain('text_delta');
      expect(writes[2]).toContain('done');
    });
  });
});
```

---

## Performance Considerations

- Drain await is typically sub-millisecond (Node processes buffered data immediately)
- Write queue adds negligible memory overhead (events are small JSON strings)
- No overhead when backpressure is not triggered (`write()` returns `true`)

## Security Considerations

- No new attack surface. Drain handling is internal to HTTP response lifecycle.
- Write queue is scoped to a single SSE connection — no cross-client data leakage.

---

## Implementation Phases

### Phase 1 — Core Fix

1. Add async write queue to `subscribeToRelay()` in `session-broadcaster.ts`
2. Make `broadcastUpdate()` async with drain handling
3. Add unit tests

### Phase 2 — Verification

4. Run `/chat:self-test` to confirm SSE freeze is resolved
5. Verify full response text renders during streaming

---

## Open Questions

- **Should the relay subscription use `sendSSEEvent()` from `stream-adapter.ts`?** This would centralize the backpressure pattern, but the relay events have a different format (`relay_message` event type with envelope wrapping) vs the standard `StreamEvent` interface. A helper like `writeSSE(res, eventType, data)` could abstract the common pattern.

---

## Related ADRs

- **ADR-0026** (`decisions/0026-receipt-plus-sse-console-protocol.md`) — SSE streaming protocol
- **ADR-0003** (`decisions/0003-sdk-jsonl-as-single-source-of-truth.md`) — JSONL source of truth

## References

- Prior spec: `specs/chat-streaming-session-reliability/02-specification.md`
- Prior fix commit: `1352e31` (fixed `stream-adapter.ts` but not `session-broadcaster.ts`)
- Findings: `plans/2026-03-06-chat-self-test-findings.md`
- Node.js backpressure: https://nodejs.org/en/docs/guides/backpressuring-in-streams/
- `apps/server/src/services/session/session-broadcaster.ts:186,324` — unfixed write sites
- `apps/server/src/services/core/stream-adapter.ts:19-26` — reference drain pattern
