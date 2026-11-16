# Fix Relay-Mode Ghost Messages

**Status:** Draft
**Authors:** Claude Code, 2026-03-08
**Spec:** #103
**Ideation:** [specs/fix-relay-ghost-messages/01-ideation.md](./01-ideation.md)

---

## Overview

Fix three compounding race conditions in the relay-mode SSE message pipeline that cause ghost messages when users send messages in rapid succession. The fix combines synchronous state resets (root causes 1 & 3) with per-message correlation IDs (root cause 2) to ensure reliable message delivery.

## Background / Problem Statement

When relay mode is enabled (`DORKOS_RELAY_ENABLED=true`) and a user sends a message shortly after the previous one completes (within ~500ms), the UI displays a phantom response — a replay of the previous message's content under the new message's ID. The JSONL transcript is never updated and no tokens are consumed, confirming the message never reached the SDK.

**Evidence:** Self-test report `test-results/chat-self-test/20260308-152646.md` — Message 5 section shows ghost message, JSONL unchanged at 32 lines, cost unchanged at $0.03.

Three compounding root causes:

1. **`streamReadyRef` never resets between messages.** Set to `true` on first `stream_ready` event (line 256 of `use-chat-session.ts`), only reset on `onerror` (auto-reconnect) or effect cleanup (session change). Graceful server close (`res.end()`) does NOT fire `onerror`. After Message 1, `waitForStreamReady()` passes immediately for all subsequent messages, skipping the subscribe-first handshake.

2. **Late relay events from Message N bleed into Message N+1.** The persistent `relay_message` listener (line 259) calls `streamEventHandler(..., assistantIdRef.current)`. When Message N's late-arriving chunks fire after `assistantIdRef.current` has been updated for Message N+1, those chunks create a phantom assistant bubble under Message N+1's ID filled with Message N's content.

3. **`statusRef.current` guard has a timing window.** `statusRef.current` is updated via `useEffect` (line 135-137, async after paint). Immediately after `setStatus('streaming')`, there's a 10-50ms window where `statusRef` still reads `'idle'`, letting a `sync_update` event from the previous message's JSONL write trigger `invalidateQueries` and overwrite local state with stale history.

## Goals

- Eliminate ghost/phantom messages when sending messages in rapid succession
- Enforce the subscribe-first handshake (`waitForStreamReady`) on every message, not just the first
- Prevent late-arriving events from Message N from contaminating Message N+1
- Close the `statusRef` timing window that allows stale history overwrites
- Maintain backward compatibility with the non-relay message path

## Non-Goals

- `stream_ready_ack` adapter protocol (Solution 3 from ideation — hardening, deferred)
- Model name display inconsistency (P3 from self-test)
- Scroll position on history load (P3 from self-test)
- Changes to the non-relay (legacy SSE) message path
- Changes to relay features unrelated to message delivery (trace, metrics, dead letters)

## Technical Dependencies

- No new external libraries required
- All changes use existing dependencies: `crypto.randomUUID()` (browser API), Zod (schema validation)

## Detailed Design

### Fix 1: Synchronous State Resets (Root Causes 1 & 3)

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

**1a. Reset `streamReadyRef` before each relay send.**

In `handleSubmit()`, immediately before the `waitForStreamReady()` call, reset the ref:

```typescript
if (relayEnabled) {
  // Force per-message handshake — reset so waitForStreamReady polls
  streamReadyRef.current = false;
  await waitForStreamReady(streamReadyRef, 5000);
  // ...
}
```

This replaces the current guard `if (!streamReadyRef.current)` which only waits on the first message. The persistent EventSource will emit a fresh `stream_ready` when it reconnects or when the server sends one, so the poll will resolve naturally.

**1b. Set `statusRef.current` synchronously alongside `setStatus('streaming')`.**

Add a synchronous ref update right after `setStatus('streaming')` in `handleSubmit()`:

```typescript
setStatus('streaming');
statusRef.current = 'streaming'; // Sync ref immediately — no useEffect delay
```

This closes the 10-50ms timing window where `statusRef` reads `'idle'` while React's `useEffect` hasn't fired yet. The `sync_update` listener's guard (`if (statusRef.current === 'streaming') return`) will see the correct value immediately.

**Note:** The `useEffect` at line 135-137 that syncs `statusRef` from `status` state should be kept for correctness when status changes via other paths (error handling, stop button), but `handleSubmit()` now provides the critical synchronous update.

### Fix 2: Per-Message Correlation ID (Root Cause 2)

Thread a correlation ID through the relay pipeline so the client can filter out events from previous messages.

#### 2a. Schema Change — `SendMessageRequest`

**File:** `packages/shared/src/schemas.ts`

Add optional `correlationId` to `SendMessageRequestSchema`:

```typescript
export const SendMessageRequestSchema = z
  .object({
    content: z.string().min(1, 'content is required'),
    cwd: z.string().optional(),
    correlationId: z.string().uuid().optional(),
  })
  .openapi('SendMessageRequest');
```

Optional to maintain backward compatibility — CLI and non-relay paths don't use it.

#### 2b. Client — Generate and Send Correlation ID

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

Add a `correlationIdRef` to track the current message's correlation ID:

```typescript
const correlationIdRef = useRef<string>('');
```

In `handleSubmit()`, generate and store the correlation ID before sending:

```typescript
if (relayEnabled) {
  const correlationId = crypto.randomUUID();
  correlationIdRef.current = correlationId;
  streamReadyRef.current = false;
  await waitForStreamReady(streamReadyRef, 5000);
  await transport.sendMessageRelay(sessionId, finalContent, {
    clientId: clientIdRef.current,
    correlationId,
  });
  // ...
}
```

In the `relay_message` EventSource listener, filter by correlation ID:

```typescript
eventSource.addEventListener('relay_message', (event: MessageEvent) => {
  try {
    const envelope = JSON.parse(event.data) as {
      payload: { type: string; data: unknown };
      correlationId?: string;
    };
    // Discard events from previous messages
    if (
      correlationIdRef.current &&
      envelope.correlationId &&
      envelope.correlationId !== correlationIdRef.current
    ) {
      return;
    }
    resetStalenessTimer();
    streamEventHandler(envelope.payload.type, envelope.payload.data, assistantIdRef.current);
  } catch {
    // Ignore parse errors
  }
});
```

The filter is permissive: if either side lacks a correlation ID (backward compat), events pass through.

#### 2c. Transport Interface — Thread Correlation ID

**File:** `packages/shared/src/transport.ts`

Update the `sendMessageRelay` options type:

```typescript
sendMessageRelay(
  sessionId: string,
  content: string,
  options?: { clientId?: string; correlationId?: string }
): Promise<{ messageId: string; traceId: string }>;
```

**File:** `apps/client/src/layers/shared/lib/transports/http-transport.ts`

Pass `correlationId` in the POST body:

```typescript
async sendMessageRelay(sessionId, content, options) {
  const res = await fetch(`/api/sessions/${sessionId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.clientId ? { 'X-Client-Id': options.clientId } : {}),
    },
    body: JSON.stringify({
      content,
      ...(options?.correlationId ? { correlationId: options.correlationId } : {}),
    }),
  });
  // ...
}
```

#### 2d. Server Route — Thread Into Relay Envelope Payload

**File:** `apps/server/src/routes/sessions.ts`

In the POST handler, extract `correlationId` from the validated body and pass it to `publishViaRelay()`:

```typescript
const { content, cwd, correlationId } = parsed.data;
// ...
const receipt = await publishViaRelay(relayCore, sessionId, clientId, content, cwd, correlationId);
```

Update `publishViaRelay()` to include `correlationId` in the payload:

```typescript
async function publishViaRelay(
  relayCore: RelayCore,
  sessionId: string,
  clientId: string,
  content: string,
  cwd?: string,
  correlationId?: string,
): Promise<{ messageId: string; traceId: string }> {
  // ...
  const publishResult = await relayCore.publish(
    `relay.agent.${sessionId}`,
    { content, cwd, correlationId },
    { from: consoleEndpoint, replyTo: consoleEndpoint, budget: { ... } },
  );
  // ...
}
```

#### 2e. Adapter — Echo Correlation ID in Response Chunks

**File:** `packages/relay/src/adapters/claude-code-adapter.ts`

In `handleAgentMessage()`, extract the correlation ID from the incoming payload and pass it through to `publishResponse()`:

```typescript
const correlationId = payloadObj?.correlationId as string | undefined;
// ...
// Pass correlationId to publishResponse for all raw-stream events
await this.publishResponse(envelope, event, ccaSessionKey, correlationId);
```

Update `publishResponse()` to include the correlation ID in the published payload:

```typescript
private async publishResponse(
  originalEnvelope: RelayEnvelope,
  event: StreamEvent,
  fromId: string,
  correlationId?: string,
): Promise<void> {
  if (!this.relay || !originalEnvelope.replyTo) return;
  const opts: PublishOptions = {
    from: `agent:${fromId}`,
    budget: { hopCount: originalEnvelope.budget.hopCount + 1 },
  };
  // Wrap event with correlationId so client can filter stale events
  const payload = correlationId ? { ...event, correlationId } : event;
  const result = await this.relay.publish(originalEnvelope.replyTo, payload, opts);
  // ...
}
```

#### 2f. Session Broadcaster — Pass Correlation ID Through SSE

**File:** `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`

In `subscribeToRelay()`, include `correlationId` from the relay payload in the SSE event data:

```typescript
unsubFn = this.relay!.subscribe(subject, (envelope) => {
  const payload = envelope.payload as Record<string, unknown> | null | undefined;
  const correlationId =
    typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['correlationId']
      : undefined;
  // ...
  const eventData = `event: relay_message\ndata: ${JSON.stringify({
    messageId: envelope.id,
    payload: envelope.payload,
    subject: envelope.subject,
    ...(correlationId ? { correlationId } : {}),
  })}\n\n`;
  queue.push(eventData);
  void flush();
});
```

### Data Flow Summary

```
Client: handleSubmit()
  1. correlationId = crypto.randomUUID()
  2. correlationIdRef.current = correlationId
  3. streamReadyRef.current = false        ← Fix 1a
  4. statusRef.current = 'streaming'       ← Fix 1b
  5. await waitForStreamReady(...)         ← Now polls every time
  6. POST /api/sessions/:id/messages { content, correlationId }

Server: POST handler
  7. Extract correlationId from body
  8. publishViaRelay(..., correlationId)
  9. relay.publish('relay.agent.{sessionId}', { content, correlationId })

Adapter: handleAgentMessage()
  10. Extract correlationId from payload
  11. SDK query() → event stream
  12. publishResponse(envelope, event, sessionKey, correlationId)
      → relay.publish(replyTo, { ...event, correlationId })

Session Broadcaster: subscribeToRelay()
  13. Extract correlationId from relay payload
  14. SSE: event: relay_message\ndata: { payload, correlationId }

Client: EventSource relay_message listener
  15. Parse envelope, check correlationId
  16. If envelope.correlationId !== correlationIdRef.current → DISCARD
  17. Otherwise → streamEventHandler() → React state updates
```

## User Experience

No visible UI changes. Users will experience:

- Messages sent in rapid succession are delivered reliably
- No more phantom/ghost responses
- No increase in perceived latency (correlation ID is generated client-side, no extra round-trips)

## Testing Strategy

### Unit Tests

**File:** `apps/client/src/layers/features/chat/__tests__/use-chat-session-relay.test.ts` (new)

Tests for the relay-specific fixes:

1. **`streamReadyRef` resets per message** — Verify that `waitForStreamReady` is called (polls) on every relay message send, not just the first. Mock EventSource, verify the ref is `false` before each send.

2. **Correlation ID filtering** — Simulate two rapid messages: emit `relay_message` events with correlationId matching Message 1 after Message 2 has started. Verify Message 1's late events are discarded and don't appear in the UI.

3. **Backward compatibility — missing correlationId** — Emit `relay_message` events without a `correlationId` field. Verify they pass through (not filtered) for backward compatibility with older server versions.

4. **`statusRef` sync guard** — Verify that immediately after `handleSubmit()` starts, `statusRef.current` is `'streaming'` (not relying on useEffect).

**File:** `packages/relay/src/adapters/__tests__/claude-code-adapter-correlation.test.ts` (new)

1. **Correlation ID echo** — Publish a message with `correlationId` in the payload. Verify each response chunk published to `replyTo` includes the same `correlationId`.

2. **No correlation ID** — Publish a message without `correlationId`. Verify response chunks are published without a `correlationId` field (no `undefined` values).

### Integration Tests

**File:** `apps/server/src/routes/__tests__/sessions-relay-correlation.test.ts` (new)

1. **Correlation ID round-trip** — POST a message with `correlationId` in the body. Verify the relay envelope payload contains `correlationId`. Mock the relay to capture published envelopes.

### E2E / Manual Verification

Use the existing `/chat:self-test` skill to verify the fix:

1. Enable relay mode
2. Send 5 rapid successive messages
3. Verify all messages appear in JSONL
4. Verify no phantom responses
5. Verify cost increases with each message

### Mocking Strategies

- **EventSource:** Use a mock class that allows programmatic event emission (already used in existing tests)
- **Transport:** Use `createMockTransport()` from `@dorkos/test-utils` with extended relay methods
- **RelayCore:** Mock `publish()` to capture envelopes and verify `correlationId` threading

## Performance Considerations

- **Correlation ID generation:** `crypto.randomUUID()` is ~1μs — negligible
- **Correlation ID filtering:** Single string comparison per event — negligible
- **`streamReadyRef` reset:** Adds 0-5s poll wait per message (same as first message today). In practice, the EventSource reconnects and emits `stream_ready` within ~100ms. The 5s timeout is a safety net only.
- **Payload size increase:** ~40 bytes per relay event (UUID string) — negligible vs. typical event size

## Security Considerations

- Correlation IDs are UUIDs with no sensitive information
- Client-generated IDs cannot be used for injection — they're validated by Zod as UUIDs and only used for filtering
- No authentication or authorization changes

## Documentation

- Update `contributing/architecture.md` — add note about correlation ID in Relay message flow
- No user-facing documentation changes needed (internal fix)

## Implementation Phases

### Phase 1: Synchronous State Resets (Fix 1)

Minimal code changes, fixes root causes 1 and 3:

1. Add `streamReadyRef.current = false` before `waitForStreamReady()` in `handleSubmit()`
2. Remove the `if (!streamReadyRef.current)` guard — always wait
3. Add `statusRef.current = 'streaming'` synchronously in `handleSubmit()`
4. Write unit tests for both fixes

**Files modified:** `use-chat-session.ts` only (3-4 line changes)

### Phase 2: Per-Message Correlation ID (Fix 2)

Thread correlation ID through the full pipeline:

1. Add `correlationId` to `SendMessageRequestSchema`
2. Add `correlationIdRef` and generation in `handleSubmit()`
3. Update `Transport.sendMessageRelay()` signature and `HttpTransport` implementation
4. Update `publishViaRelay()` in sessions route
5. Update `handleAgentMessage()` and `publishResponse()` in CCA
6. Update `subscribeToRelay()` in session broadcaster
7. Add correlation ID filter in `relay_message` listener
8. Write unit and integration tests

**Files modified:** 6 files across client, shared, server, and relay packages

### Phase 3: Verification

1. Run full test suite
2. Run `/chat:self-test` with relay mode enabled
3. Verify no regressions in non-relay path

## Open Questions

No open questions — all three root causes are well-understood and the fix approach is validated by prior research.

## Related ADRs

- **ADR-0075:** Promise-chain queue for CCA concurrency — prevents concurrent SDK calls per agent, related to relay message ordering
- **ADR-0046:** Central BindingRouter for adapter-agent routing — defines the relay message routing architecture this fix operates within

## References

- **Ideation:** `specs/fix-relay-ghost-messages/01-ideation.md`
- **Research:** `research/20260306_sse_relay_delivery_race_conditions.md` — identifies 4 root causes and 5 fix priorities
- **Research:** `research/20260307_relay_streaming_bugs_tanstack_query.md` — TanStack Query invalidation timing
- **Self-test evidence:** `test-results/chat-self-test/20260308-152646.md` — ghost message reproduction
- **Prior fix spec:** `specs/fix-chat-streaming-history-consistency/` — related streaming/history consistency work
