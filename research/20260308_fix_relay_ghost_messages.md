---
title: 'Relay-Mode Ghost Messages — Subscribe-First Race Condition Root Cause & Fix'
date: 2026-03-08
type: implementation
status: active
tags: [relay, sse, race-condition, ghost-message, stream-ready, correlation-id, subscribe-first]
feature_slug: fix-relay-ghost-messages
searches_performed: 0
sources_count: 8
---

# Relay-Mode Ghost Messages — Subscribe-First Race Condition Root Cause & Fix

## Research Summary

This research synthesizes findings from three prior research files and direct source inspection
to identify the exact root cause of the relay-mode ghost message bug observed in the chat
self-test on 2026-03-08. The bug causes the UI to display a phantom assistant response (replaying
message N's content) when message N+1 is sent in rapid succession. The JSONL is not updated
(message never reaches the SDK). The root cause is a combination of: (1) `streamReadyRef.current`
remaining `true` permanently after the first message, bypassing the subscribe-first handshake
for all subsequent messages; and (2) late-arriving `relay_message` events from message N being
processed with message N+1's `assistantId`. The fix requires resetting `streamReadyRef` before
each new message send, adding per-message correlation IDs, and hardening the `sync_update` guard
against microtask-timing races.

## Prior Research Consulted

- `research/20260306_sse_relay_delivery_race_conditions.md` — subscribe-first architecture,
  pending buffer, correlation ID patterns
- `research/20260307_relay_streaming_bugs_tanstack_query.md` — `isStreamingRef` guard for
  `sync_update`, relay polling storm
- `research/20260307_fix_chat_streaming_history_consistency.md` — tool_result orphan,
  auto-scroll disengagement
- `test-results/chat-self-test/20260308-152646.md` — observed ghost message symptom (Message 5)

## Key Findings

### 1. The Subscribe-First Handshake Is Bypassed After the First Message

**Root cause location:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`, lines 356-360:

```typescript
if (!streamReadyRef.current) {
  await waitForStreamReady(streamReadyRef, 5000);
}
```

The relay EventSource effect (lines 247-292) creates a **persistent** SSE connection and sets
`streamReadyRef.current = true` when `stream_ready` is received. The SSE connection is never
torn down by `isStreaming` changes — this is intentional and confirmed by a test at line 310.

**The bug:** `streamReadyRef.current` is never reset between messages. After message 1 receives
its `stream_ready` event, `streamReadyRef.current === true` for the lifetime of the hook instance.
All subsequent messages skip `waitForStreamReady()` entirely.

This means the subscribe-first handshake, which was designed to prevent race conditions, only
fires for the very first message. For all subsequent messages, the POST fires immediately with no
guarantee that the server-side relay subscription is ready to receive the new message's events.

### 2. Late Relay Events From Previous Message Bleed Into New Message

**Root cause:** The `relay_message` listener at line 259 is a persistent closure that calls
`streamEventHandler(envelope.payload.type, envelope.payload.data, assistantIdRef.current)`.

`assistantIdRef.current` is updated in `handleSubmit` at line 344 (`assistantIdRef.current = crypto.randomUUID()`) before the POST is sent. However, relay events from the previous message
(including the `done` event and any late-arriving chunks from the ClaudeCode adapter) are still
in-flight in the relay pipeline and will be delivered to the SSE connection asynchronously.

**Timing sequence for the ghost:**

```
t=0ms   Message 4's final relay_message events delivered (tool results, done)
t=0ms   UI: status → 'idle', streamReadyRef still true
t=10ms  User types "What is 2+2?" and presses Enter
t=10ms  handleSubmit: assistantIdRef.current = newUUID, currentPartsRef = []
t=10ms  handleSubmit: status → 'streaming' (React state update scheduled)
t=10ms  handleSubmit: waitForStreamReady() → RETURNS IMMEDIATELY (streamReadyRef is true)
t=10ms  handleSubmit: transport.sendMessageRelay() POST fires
t=12ms  statusRef.current is STILL 'idle' (React state update not yet committed)
t=15ms  sync_update from Message 4's JSONL write fires:
          statusRef.current === 'idle' → guard passes → invalidateQueries fires
t=20ms  Message 4's late relay_message events arrive (delayed delivery from relay pipeline):
          relay_message({ type: 'text_delta', data: { text: '...[Message 4 text]...' } })
          → streamEventHandler called with assistantIdRef.current = Message5AssistantId
          → ensureAssistantMessage creates new assistant message with Message 5's ID
          → message 4's text content added to message 5's assistant message
t=25ms  historyQuery refetch completes with message 4's history:
          isStreaming check: status may now be 'streaming' from React state flush
          → if isStreaming is false (race): history seed overwrites with message 4 content
t=30ms  Message 4's 'done' event arrives via relay:
          → streamEventHandler: setStatus('idle')
          → Message 5 never reaches the SDK; its delivery was fire-and-forget at t=10ms
             and may have been dropped by the relay (subscriber not confirmed ready)
```

### 3. The `statusRef` / `isStreaming` Guard Is Vulnerable to Microtask Timing

**Root cause:** The `sync_update` guard at lines 270-274:

```typescript
eventSource.addEventListener('sync_update', () => {
  if (statusRef.current === 'streaming') return;
  queryClient.invalidateQueries(...);
});
```

`statusRef.current` is updated in a `useEffect` (lines 135-137):

```typescript
useEffect(() => {
  statusRef.current = status;
});
```

React `useEffect` runs asynchronously after paint. The `setStatus('streaming')` call in
`handleSubmit` (line 335) schedules a state update, but `statusRef.current` does not reflect
the new value until the next `useEffect` execution, which happens after the browser paints.

A `sync_update` SSE event that fires within ~10-50ms of the `handleSubmit` call (triggered by
the JSONL write from the COMPLETING previous message) will read `statusRef.current === 'idle'`
and pass the guard, triggering an unnecessary `invalidateQueries`. This is the mechanism that
causes history to overwrite the fresh streaming state.

**Note:** `statusRef.current` IS already updated on every render without a deps array, meaning
it runs after every commit. But between `setStatus('streaming')` being called and React
committing the re-render, there is a window (typically 10-30ms) where the ref is stale.

### 4. The Server-Side Relay Subscription May Not Be Ready for Rapid Successive Messages

**Root cause:** The `registerClient()` function in `session-broadcaster.ts` (lines 120-131) calls
`subscribeToRelay(res, clientId)` and then immediately sends `stream_ready`. The relay subscription
itself is synchronous (in-process pub/sub), so `stream_ready` is sent as soon as the subscription
is registered.

However, the persistent SSE connection means the relay subscription for `relay.human.console.{clientId}` is active continuously. The issue is not the subscription registration itself — it is that the `relay_message` events from the previous message are still in the relay pipeline when the new `POST /api/sessions/:id/messages` fires.

The server's `publishViaRelay()` function at lines 182-220 of `sessions.ts` publishes to
`relay.agent.{sessionId}` which triggers the `ClaudeCodeAdapter`. The adapter begins streaming
and publishes response chunks back to `relay.human.console.{clientId}`. These chunks arrive
at the SSE connection and are dispatched to the `relay_message` listener. If the previous
message's response pipeline has not fully drained, the new message's POST may arrive while
the adapter is still processing message N's events.

### 5. The `currentPartsRef` Reset Does Not Protect Against Cross-Message Contamination

In `handleSubmit`, `currentPartsRef.current = []` (line 337) is correctly reset before the new
message. However, if the `relay_message` listener fires with a `text_delta` from the **previous**
message after `currentPartsRef.current` has been reset, the text gets added to the new empty
parts array as if it were part of the new message's response.

The `assistantCreatedRef.current = false` reset (line 345) ensures `ensureAssistantMessage` will
create a new message. But `ensureAssistantMessage` is called with `assistantIdRef.current` —
which has already been updated to the new message's ID. So the late-arriving text from message N
creates a new assistant message with message N+1's ID and populates it with message N's content.

## Detailed Analysis

### Approach 1: Reset `streamReadyRef` Before Each Message Send

**What:** Before calling `waitForStreamReady()`, set `streamReadyRef.current = false`.

```typescript
// In handleSubmit, before the relay block:
if (relayEnabled) {
  streamReadyRef.current = false; // Force re-handshake for each message
  await waitForStreamReady(streamReadyRef, 5000);
  await transport.sendMessageRelay(sessionId, finalContent, { clientId: clientIdRef.current });
}
```

**Why this fixes the primary race:** Forces the client to wait for a new `stream_ready` event
before firing the POST. Since `stream_ready` is sent by the server after `subscribeToRelay()`
completes (synchronously), this ensures the relay subscription is confirmed active before the
POST triggers the adapter pipeline.

**However:** This introduces a new problem. The SSE connection is persistent and the relay
subscription is already active. Setting `streamReadyRef.current = false` means the client
will wait for up to 5 seconds for a `stream_ready` event that **will not arrive** (since the
server only sends `stream_ready` when `registerClient()` is called — once per SSE connection
lifecycle, not once per message).

**Conclusion:** This approach requires either (a) the server to re-send `stream_ready` on demand,
or (b) a different mechanism to signal readiness per message. This alone is insufficient.

### Approach 2: Per-Message Correlation ID

**What:** Add a unique `correlationId` to each message send. Include it in the `relay_message`
envelope. The `relay_message` listener filters events by `correlationId`, discarding events
from previous messages.

**Server changes needed:**

- `POST /api/sessions/:id/messages` accepts a `correlationId` in the request body
- `publishViaRelay()` includes `correlationId` in the relay message headers/payload
- ClaudeCode adapter echoes `correlationId` in all response chunks published to
  `relay.human.console.{clientId}`

**Client changes needed:**

- `handleSubmit` generates `correlationId = crypto.randomUUID()` per message
- `transport.sendMessageRelay()` sends `correlationId` to the POST
- `relay_message` listener checks `envelope.correlationId === currentCorrelationIdRef.current`
  before processing

**Pros:**

- Eliminates message bleeding entirely — each message only processes events with its own ID
- No dependency on timing or SSE connection lifecycle
- Works correctly for rapid successive messages, retries, and reconnects

**Cons:**

- Requires server-side changes in the relay pipeline (adapter must echo the ID)
- Increased message payload size
- Requires ClaudeCode adapter changes

**Complexity:** Medium (3-4 files, requires shared ID threading through relay pipeline)

### Approach 3: Sequence Number Guard on `relay_message` Events

**What:** Maintain a monotonically-increasing `messageSequenceRef` on the client. Before each
`handleSubmit`, increment the sequence number. The `relay_message` listener captures the
current sequence at effect creation time (closure) or compares via ref.

This is a lighter alternative to correlation IDs that requires no server changes.

```typescript
const messageSequenceRef = useRef(0);

// In handleSubmit:
messageSequenceRef.current += 1;
const mySequence = messageSequenceRef.current;

// In the relay_message listener (needs to see current sequence):
// Capture via ref in the handler:
eventSource.addEventListener('relay_message', (event: MessageEvent) => {
  const capturedSequence = messageSequenceRef.current;
  // ... parse envelope ...
  if (envelope.type === 'text_delta' || ...) {
    // Check if this event belongs to the current message
    // Problem: relay_message events don't carry a sequence number
    // We can't know which message produced this event
  }
});
```

**Problem:** Without server-side sequence echoing, the client cannot determine whether an
incoming `relay_message` event is from the current message or a previous one. The relay
payload does not carry a message sequence.

**Conclusion:** This approach degenerates to the same problem as approach 2 — you need the
server to echo some identifier to disambiguate message responses.

### Approach 4: Message Queue with Per-Message SSE Subscriber

**What:** Instead of a persistent SSE connection, open a new SSE subscription per message send.
The subscription is opened, `stream_ready` is awaited, the POST fires, and the subscription
is closed on `done`.

This is the pattern used by the legacy (non-relay) path: SSE is embedded in the POST connection.
The relay path uses a persistent SSE for efficiency, but this could be changed.

**Pros:**

- Clean per-message isolation — no cross-message event leaking
- Natural cleanup on `done` or error
- `stream_ready` handshake works correctly per message

**Cons:**

- HTTP overhead: new TCP connection or HTTP/2 stream per message
- EventSource reconnect behavior adds complexity
- Breaks the staleness detector pattern (which relies on the persistent SSE)
- Increases server-side connection management complexity
- Goes against the design decision to use persistent relay SSE

**Complexity:** High — significant refactor of the relay path

### Approach 5: Per-Message `streamReadyRef` + Server-Side Per-Message Subscription Signal

**What:** The server sends a new `stream_ready` event at the START of each message response
pipeline, not just at connection registration time. The client resets `streamReadyRef.current = false`
before each `handleSubmit` and waits for the next `stream_ready`.

**How the server sends per-message stream_ready:**

- In the ClaudeCode adapter, when it begins processing a new message from the relay, it
  publishes a `stream_ready` signal to `relay.human.console.{clientId}` BEFORE any content chunks
- OR: The `POST /api/sessions/:id/messages` handler sends a `stream_ready` via the SSE connection
  before returning the 202 receipt (requires knowing the SSE connection in the POST handler)

**Problem:** The POST handler doesn't have a reference to the SSE connection. The SSE connection
is managed independently by the `GET /stream` handler. Bridging the two would require the relay
core or session broadcaster to expose a targeted "send to client" API.

**Alternative approach:** Send `stream_ready` from the ClaudeCode adapter when it starts
processing. This delays the signal until the adapter actually begins work, which is safer but
adds adapter-to-client latency.

**Complexity:** Medium-High

## Recommended Fix: Three-Part Solution

The most reliable fix combines three complementary changes, each addressing a distinct
failure mode:

### Part 1: Per-Message Correlation ID (Eliminates Message Bleeding)

This is the primary fix for the ghost message content.

**Client changes (`use-chat-session.ts`):**

```typescript
// Add near other refs:
const correlationIdRef = useRef<string>('');

// In handleSubmit, before the relay block:
const correlationId = crypto.randomUUID();
correlationIdRef.current = correlationId;

// In relay_message listener:
eventSource.addEventListener('relay_message', (event: MessageEvent) => {
  try {
    const envelope = JSON.parse(event.data) as {
      payload: { type: string; data: unknown };
      correlationId?: string;
    };
    // Discard relay events that don't match the current message's correlationId.
    // This prevents late-arriving events from a previous message from bleeding
    // into the new message's assistant bubble.
    if (envelope.correlationId && envelope.correlationId !== correlationIdRef.current) {
      return;
    }
    resetStalenessTimer();
    streamEventHandler(envelope.payload.type, envelope.payload.data, assistantIdRef.current);
  } catch {
    // Ignore parse errors
  }
});
```

**Server changes (`publishViaRelay()` in `sessions.ts`):**

Accept `correlationId` from the POST body and include it in the relay envelope:

```typescript
async function publishViaRelay(
  relayCore: RelayCore,
  sessionId: string,
  clientId: string,
  content: string,
  correlationId: string,   // new parameter
  cwd?: string,
): Promise<{ messageId: string; traceId: string }> {
  // ...
  const publishResult = await relayCore.publish(
    `relay.agent.${sessionId}`,
    { content, cwd, correlationId },  // include in payload
    {
      from: consoleEndpoint,
      replyTo: consoleEndpoint,
      correlationId,          // include in envelope headers
      budget: { ... },
    },
  );
}
```

**Adapter changes (`ClaudeCodeAdapter`):**

Echo `correlationId` from the incoming message payload in all response chunks published to
`relay.human.console.{clientId}`:

```typescript
// In the adapter's response publishing:
await relay.publish(
  `relay.human.console.${clientId}`,
  { ...eventChunk, correlationId }, // echo correlationId from request
  { correlationId }
);
```

### Part 2: Advance `statusRef` Synchronously Before POST (Fixes the Guard Race)

The `statusRef` guard race is caused by `statusRef.current` being updated via `useEffect`,
which runs asynchronously. To fix this, update `statusRef.current` synchronously in
`handleSubmit` at the same point where `setStatus('streaming')` is called:

```typescript
// In handleSubmit, after setStatus('streaming'):
setStatus('streaming');
statusRef.current = 'streaming'; // Synchronous pre-update prevents sync_update race
```

This is safe because the `statusRef` is only read by the `sync_update` listener (a closure
that fires asynchronously) — it does not cause double-update issues. The `useEffect` that
updates `statusRef.current` will also fire, but since it will set the same value, it is a no-op.

This is a well-established React pattern: when a ref mirrors state for use in async callbacks,
update the ref synchronously alongside the state dispatch.

### Part 3: Reset `streamReadyRef` Before Each Message + Server Echo

To restore the subscribe-first guarantee for every message (not just the first), the server
must send a per-message `stream_ready` signal. The cleanest approach:

**Option A (lower latency): `stream_ready` from POST handler before 202 response**

Modify the `GET /stream` route to support a "ping" mechanism: the POST handler, after
successfully registering the message with the relay, triggers the session broadcaster to
send a `stream_ready` event to the specific `clientId`'s SSE connection:

```typescript
// In POST /messages (relay path):
const receipt = await publishViaRelay(relayCore, sessionId, clientId, content, correlationId, cwd);
// Notify the SSE client that the relay subscription is active for this message
broadcaster.signalReady(clientId);
return res.status(202).json(receipt);
```

```typescript
// In SessionBroadcaster:
signalReady(clientId: string): void {
  const res = this.clientsByClientId.get(clientId);
  if (res) {
    res.write(`event: stream_ready\ndata: ${JSON.stringify({ clientId })}\n\n`);
  }
}
```

**Client side:**

```typescript
// In handleSubmit, before the relay block:
streamReadyRef.current = false; // Force re-confirmation for this message

await waitForStreamReady(streamReadyRef, 5000);
await transport.sendMessageRelay(sessionId, finalContent, { clientId, correlationId });
```

**Wait — ordering problem:** The current design sends `stream_ready` FROM the GET handler when
the connection is registered. Sending it again FROM the POST handler creates a chicken-and-egg
problem: the POST fires, then `stream_ready` is sent, then the client receives it — but by then
the POST has already been sent. This approach does not restore subscribe-first ordering.

**Option B (correct ordering): Use the POST response itself as the "ready" signal**

The relay path already returns a 202 receipt. The client can treat the receipt itself as a
"POST was accepted" signal and use the correlation ID to filter events. The `stream_ready`
mechanism for first-message ordering is sufficient. What was needed was only to prevent
cross-message contamination — which Part 1 addresses.

**Conclusion:** Part 3 is not strictly necessary if Part 1 (correlation ID) is implemented.
The correlation ID approach means the client safely ignores late events from message N even
when the POST for message N+1 fires before those events drain. The subscribe-first handshake
remains useful for the very first message on connection establishment.

However, `streamReadyRef.current = false` should still be reset between messages as a
defensive measure, paired with the server broadcasting a new `stream_ready` via the existing
mechanism. The simplest way to achieve this:

**The ClaudeCode adapter publishes a synthetic `stream_ready` payload as the FIRST event**
in each new response stream, before any `text_delta`. The client's `relay_message` handler
can detect this and set `streamReadyRef.current = true`:

```typescript
// Client relay_message listener:
if (envelope.payload.type === 'stream_ready_ack') {
  streamReadyRef.current = true;
  return;
}
```

```typescript
// ClaudeCode adapter, before iterating SDK generator:
await relay.publish(`relay.human.console.${clientId}`, {
  type: 'stream_ready_ack',
  correlationId,
});
// Then iterate and publish SDK events...
```

This is zero-overhead (one extra tiny publish per message) and restores per-message
subscribe-first semantics on the relay path.

## Comparison Table

| Approach                        | Fixes Ghost Content      | Fixes History Race | Server Changes | Complexity | Recommended?        |
| ------------------------------- | ------------------------ | ------------------ | -------------- | ---------- | ------------------- |
| Reset streamReadyRef alone      | No (server won't resend) | No                 | None           | Low        | No — incomplete     |
| Per-message correlation ID      | Yes                      | Partial            | Medium         | Medium     | Yes — primary fix   |
| Advance statusRef synchronously | No                       | Yes                | None           | Trivial    | Yes — secondary fix |
| Per-message SSE connection      | Yes                      | Yes                | Medium         | High       | No — too invasive   |
| stream_ready_ack from adapter   | Yes (partial)            | No                 | Low            | Low        | Yes — complement    |

## Implementation Priority

### Fix 1 (P0): Advance `statusRef.current` Synchronously in `handleSubmit`

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

**Change:** After `setStatus('streaming')` on line 335, add `statusRef.current = 'streaming';`

**Impact:** Closes the 10-50ms window where a `sync_update` from the previous message can
pass the streaming guard and trigger a spurious `invalidateQueries`.

**Estimated effort:** 1 line, 5 minutes.

### Fix 2 (P0): Per-Message Correlation ID on Client Side (Defensive Filter)

**File:** `apps/client/src/layers/features/chat/model/use-chat-session.ts`

**Change:** Add `correlationIdRef`. In `handleSubmit`, generate a new correlationId before
each relay send. In the `relay_message` listener, skip events whose `correlationId` does not
match `correlationIdRef.current`. Since server doesn't yet echo the ID, the filter only
activates when the server includes it — backward compatible.

**Without server changes:** The filter is inactive (no `correlationId` in existing envelopes)
but provides the infrastructure for Fix 3.

**Estimated effort:** 15 lines, 30 minutes.

### Fix 3 (P0): Server-Side Correlation ID Echoing

**Files:**

- `apps/server/src/routes/sessions.ts` — `publishViaRelay()` accepts and threads correlationId
- ClaudeCode adapter (`apps/server/src/services/relay/adapters/claude-code-adapter.ts` or similar)
  — echoes correlationId in all published response chunks

**Impact:** Activates the client-side filter from Fix 2, completing the message isolation.

**Estimated effort:** 2-3 hours depending on adapter architecture.

### Fix 4 (P1): stream_ready_ack from ClaudeCode Adapter

**Files:**

- ClaudeCode adapter — publishes synthetic `stream_ready_ack` as first event per message
- `use-chat-session.ts` — resets `streamReadyRef.current = false` in `handleSubmit`, handles
  `stream_ready_ack` in the relay_message listener to set it back to `true`

**Impact:** Restores subscribe-first semantics for every message on the relay path. Ensures
the client confirms relay delivery pipeline is active before interpreting events.

**Estimated effort:** 1-2 hours.

## Minimum Viable Fix (Without Server Changes)

If server changes are not immediately feasible, the following client-only changes reduce
the race window significantly:

1. **Advance `statusRef.current` synchronously** — eliminates the guard timing race (1 line)
2. **Reset `streamReadyRef.current = false` before each relay send** — forces a 5-second
   timeout before firing the POST on messages 2+. This is a degraded experience (5s wait on
   every message) but prevents ghost messages

This is not a production-quality fix — the 5-second wait is unacceptable UX. But it confirms
the root cause and buys time for the full server-side fix.

A better client-only mitigation:

- Track `assistantIdRef.current` at the time the `relay_message` event is **registered** as
  a closure variable, and only call `streamEventHandler` if the current `assistantIdRef.current`
  still matches the captured value. This prevents late events from previous messages from
  writing into the new message's assistant bubble:

```typescript
eventSource.addEventListener('relay_message', (event: MessageEvent) => {
  try {
    const envelope = JSON.parse(event.data) as { payload: { type: string; data: unknown } };
    // The listener is re-created when sessionId changes (effect deps), but it is NOT
    // re-created between messages within a session. So we check the current assistantId
    // against what was set when this event was actually for this message.
    // Problem: we cannot know at listener call time whether the event was produced
    // for assistantIdRef.current or a previous assistant.
    // The correlation ID is the correct solution.
    resetStalenessTimer();
    streamEventHandler(envelope.payload.type, envelope.payload.data, assistantIdRef.current);
  } catch {
    // Ignore parse errors
  }
});
```

The fundamental limitation of client-only fixes is that the client cannot determine which
message produced a given `relay_message` event. Only the server can provide this information
(via correlation ID). **The correlation ID approach is the correct and complete fix.**

## Sources & Evidence

- Self-test report confirming ghost message symptom: `test-results/chat-self-test/20260308-152646.md`
- Subscribe-first architecture research: `research/20260306_sse_relay_delivery_race_conditions.md`
- `isStreamingRef` guard research: `research/20260307_relay_streaming_bugs_tanstack_query.md`
- Direct source inspection: `apps/client/src/layers/features/chat/model/use-chat-session.ts`
- Direct source inspection: `apps/server/src/routes/sessions.ts`, `publishViaRelay()` function
- Direct source inspection: `apps/server/src/services/runtimes/claude-code/session-broadcaster.ts`
- React concurrent rendering behavior: `statusRef` updated via `useEffect` is asynchronous w.r.t.
  React state dispatches — synchronous pre-update is the correct pattern for async callbacks
- ADR-0083: `decisions/0083-subscribe-first-sse-handshake.md` — subscribe-first pattern decision

## Research Gaps & Limitations

- The ClaudeCode adapter implementation was not directly inspected. The exact location where
  response chunks are published to `relay.human.console.{clientId}` needs to be confirmed to
  implement Fix 3. Look for `relay.publish(relay.human.console.${clientId}, ...)` in
  `apps/server/src/services/relay/adapters/` or similar.
- The exact relay envelope schema (`relay-schemas.ts`) was not checked to confirm whether a
  `correlationId` field already exists in the envelope or needs to be added.
- The `waitForStreamReady` polling interval of 50ms means the maximum additional delay from
  resetting `streamReadyRef` before each message (if the per-message stream_ready_ack approach
  is used) is 50ms — acceptable UX.

## Search Methodology

- No web searches performed — all findings from direct source inspection and prior research
- Files inspected: `use-chat-session.ts`, `stream-event-handler.ts`, `session-broadcaster.ts`,
  `sessions.ts`, `use-chat-session-relay.test.ts`, and three prior research files
- Searches performed: 0 (internal source analysis only)
- Most relevant prior research: `20260306_sse_relay_delivery_race_conditions.md` (provides
  theoretical framework) + `20260307_relay_streaming_bugs_tanstack_query.md` (provides
  concrete fix patterns already applied in the codebase)
