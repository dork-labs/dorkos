---
number: 92
slug: relay-inbox-lifecycle
title: Relay Inbox Lifecycle — Endpoint Types, Dispatch TTL, relay_send_and_wait Streaming
status: draft
created: 2026-03-05
spec: relay-inbox-lifecycle
---

# Relay Inbox Lifecycle — Endpoint Types, Dispatch TTL, relay_send_and_wait Streaming

## Status

Draft

## Authors

- Claude Code — 2026-03-05

## Overview

Implements three items deferred from spec #91 (relay-async-query):

1. **Endpoint type metadata** — `relay_list_endpoints` returns a `type` field (`'dispatch' | 'query' | 'persistent' | 'agent' | 'unknown'`) and `expiresAt` field for every endpoint, derived from subject prefix at list time.
2. **Server-side TTL sweeper** — `RelayCore` auto-expires dispatch inboxes after 30 min via a periodic `setInterval` sweeper started in the constructor and stopped in `close()`.
3. **relay_send_and_wait progress aggregation** — `relay_send_and_wait` accumulates CCA progress events internally and returns them in a new `progress[]` field on the single MCP response.

---

## Background / Problem Statement

Spec #91 introduced `relay_send_async` (fire-and-poll for long-running tasks) and raised `relay_send_and_wait` timeout to 600 seconds. Three gaps remained:

**Endpoint type opacity.** `relay_list_endpoints` returns raw `EndpointInfo` objects with no indication of role. Agents understanding the relay topology must pattern-match subjects themselves. Adding an explicit `type` field (derived from subject prefix—the existing canonical discriminator already used throughout CCA) makes topology self-describing at zero schema-migration cost.

**Dispatch inbox leaks.** Dispatch inboxes (`relay.inbox.dispatch.*`) are caller-managed. If the calling agent crashes, is interrupted, or omits the `relay_unregister_endpoint` cleanup call, the inbox persists on disk indefinitely—holding open a chokidar file watcher and consuming disk space in the Maildir directory. A server-side TTL sweeper provides a background safety net.

**relay_send_and_wait opacity.** For 5–10 minute tasks, `relay_send_and_wait` returns a single response with no indication of what happened during processing. CCA already publishes progress events to dispatch inboxes, but query inboxes received none (spec #91 explicitly preserved the single-message contract for query inboxes to keep `relay_send_and_wait` simple). Now that relay_send_and_wait has the 600 s timeout, agents using it on medium-duration tasks need intermediate visibility. Accumulating progress events into an additive `progress[]` field delivers that visibility without breaking the single-tool-result MCP contract.

---

## Goals

- `relay_list_endpoints` response includes `type` and `expiresAt` for every endpoint
- Dispatch inboxes auto-expire ≤ 35 min after creation (30-min TTL + 5-min sweep jitter) even if `relay_unregister_endpoint` is never called
- `relay_send_and_wait` returns a `progress[]` array populated with CCA progress events for medium-duration tasks
- `relay_send_and_wait` still returns a single MCP `CallToolResult` — no streaming
- Existing callers destructuring only `reply`, `from`, `replyMessageId` from `relay_send_and_wait` are unaffected (`progress` is additive)
- All tests pass: `pnpm test -- --run`

---

## Non-Goals

- Changing dispatch inbox persistence to survive server restarts
- New relay transport patterns or new MCP tools beyond the three enhancements
- Push-based notification ("interrupt") to a waiting `relay_send_and_wait` caller
- Changing `relay_send_and_wait` to use `relay_send_async` internally
- Per-endpoint TTL configuration (single server-wide default only)
- Persisting `EndpointType` in storage (derived-only, zero schema migration)
- TTL for non-dispatch inbox types (query inboxes are auto-cleaned by `relay_send_and_wait`'s `finally` block)

---

## Technical Dependencies

| Dependency                              | Location                               | Role                                                       |
| --------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| `@dorkos/relay`                         | `packages/relay/`                      | Primary modification target                                |
| `@dorkos/shared/relay-schemas`          | `packages/shared/src/relay-schemas.ts` | `RelayProgressPayload` type (already exists from spec #91) |
| Node.js `setInterval` / `clearInterval` | Built-in                               | TTL sweeper — no new packages                              |
| `@anthropic-ai/claude-agent-sdk`        | Server                                 | No changes required                                        |

---

## Detailed Design

### Architecture Overview

```
relay_list_endpoints
  └─► inferEndpointType(ep.subject)
  └─► expiresAt = type==='dispatch' ? registeredAt + dispatchInboxTtlMs : null
  └─► return { ...ep, type, expiresAt }

RelayCore constructor
  └─► startTtlSweeper()           ← new, called after startConfigWatcher()
        setInterval(5 min)
          listEndpoints()
          → dispatch + age > 30 min → unregisterEndpoint()
  close()
  └─► clearInterval(ttlSweepInterval)  ← new, first cleanup in close()

relay_send_and_wait subscribe handler
  Before: resolve on FIRST message received
  After:  accumulate if type==='progress' && done===false
          resolve on any other (final) message → { payload, progress[], from, id }

CCA handleAgentMessage
  Before: isDispatchInbox → progress streaming; isQueryInbox → aggregate-only
  After:  isInboxReplyTo (any relay.inbox.*) → progress streaming + agent_result
```

### Phase 1: Endpoint Type Metadata

#### 1a. Add `inferEndpointType` utility to `packages/relay/src/types.ts`

Append at end of file (after `DeliveryResult` interface):

```typescript
/** Categorization of a Relay endpoint by subject prefix. */
export type EndpointType = 'dispatch' | 'query' | 'persistent' | 'agent' | 'unknown';

/**
 * Derive the logical type of a Relay endpoint from its subject prefix.
 *
 * Mirrors the prefix-matching convention used in ClaudeCodeAdapter and
 * throughout the subject hierarchy. Zero schema change — type is never stored.
 *
 * @param subject - The endpoint's full subject string
 */
export function inferEndpointType(subject: string): EndpointType {
  if (subject.startsWith('relay.inbox.dispatch.')) return 'dispatch';
  if (subject.startsWith('relay.inbox.query.')) return 'query';
  if (subject.startsWith('relay.inbox.')) return 'persistent';
  if (subject.startsWith('relay.agent.')) return 'agent';
  return 'unknown';
}
```

#### 1b. Add `getDispatchInboxTtlMs()` to `RelayCore`

`relay_list_endpoints` must compute `expiresAt` using the same TTL value as the sweeper. Add a public accessor (implemented in Phase 2 along with the TTL fields):

```typescript
/** Returns the configured dispatch inbox TTL in milliseconds. */
getDispatchInboxTtlMs(): number {
  return this.dispatchInboxTtlMs;
}
```

#### 1c. Update `createRelayListEndpointsHandler` in `relay-tools.ts`

```typescript
import { inferEndpointType } from '../../../../../path/to/relay/types.js'; // resolved via @dorkos/relay exports

export function createRelayListEndpointsHandler(deps: McpToolDeps) {
  return async () => {
    const err = requireRelay(deps);
    if (err) return err;
    const relay = deps.relayCore!;
    const endpoints = relay.listEndpoints();
    const dispatchTtlMs = relay.getDispatchInboxTtlMs();
    const typed = endpoints.map((ep) => {
      const type = inferEndpointType(ep.subject);
      const expiresAt =
        type === 'dispatch'
          ? new Date(new Date(ep.registeredAt).getTime() + dispatchTtlMs).toISOString()
          : null;
      return { ...ep, type, expiresAt };
    });
    return jsonContent({ endpoints: typed, count: typed.length });
  };
}
```

**Note on import path:** `inferEndpointType` lives in `packages/relay/src/types.ts`. The server imports relay types via `@dorkos/relay`. Confirm the relay package exports this function from its `index.ts` barrel (add if missing).

#### 1d. Update tool description for `relay_list_endpoints`

```
List all registered Relay endpoints. Each endpoint includes subject, hash, maildirPath,
registeredAt, type ('dispatch'|'query'|'persistent'|'agent'|'unknown'), and expiresAt
(ISO timestamp for dispatch endpoints indicating 30-min TTL expiry; null for others).
```

---

### Phase 2: Server-Side TTL Sweeper

#### 2a. Extend `RelayOptions` in `packages/relay/src/types.ts`

```typescript
export interface RelayOptions {
  // ... existing fields unchanged ...

  /**
   * TTL for dispatch inboxes in milliseconds.
   * Dispatch inboxes older than this are swept automatically.
   * Default: 30 * 60 * 1000 (30 minutes)
   */
  dispatchInboxTtlMs?: number;

  /**
   * Interval between TTL sweep runs in milliseconds.
   * Default: 5 * 60 * 1000 (5 minutes)
   */
  ttlSweepIntervalMs?: number;
}
```

#### 2b. Add TTL sweeper to `packages/relay/src/relay-core.ts`

**New private fields** (add after `configWatcher`):

```typescript
private readonly dispatchInboxTtlMs: number;
private readonly ttlSweepIntervalMs: number;
private ttlSweepInterval?: ReturnType<typeof setInterval>;
```

**In constructor** — initialize fields and start sweeper after `startConfigWatcher()`:

```typescript
this.dispatchInboxTtlMs = options?.dispatchInboxTtlMs ?? 30 * 60 * 1000;
this.ttlSweepIntervalMs = options?.ttlSweepIntervalMs ?? 5 * 60 * 1000;
this.startTtlSweeper();
```

**New private method** `startTtlSweeper()`:

```typescript
/**
 * Start the periodic TTL sweeper for dispatch inboxes.
 *
 * Runs every `ttlSweepIntervalMs`. Checks all registered endpoints;
 * unregisters dispatch inboxes older than `dispatchInboxTtlMs`.
 * Uses `.unref()` so the timer does not prevent process exit.
 *
 * Race safety: `unregisterEndpoint()` returns `false` gracefully for
 * already-removed endpoints (e.g., caller cleaned up between sweeps).
 */
private startTtlSweeper(): void {
  this.ttlSweepInterval = setInterval(async () => {
    const now = Date.now();
    for (const endpoint of this.endpointRegistry.listEndpoints()) {
      if (inferEndpointType(endpoint.subject) === 'dispatch') {
        const age = now - new Date(endpoint.registeredAt).getTime();
        if (age > this.dispatchInboxTtlMs) {
          await this.unregisterEndpoint(endpoint.subject).catch(() => undefined);
        }
      }
    }
  }, this.ttlSweepIntervalMs);
  // Don't prevent process exit if close() is not called
  this.ttlSweepInterval.unref();
}
```

**In `close()`** — add as first line of the method body:

```typescript
if (this.ttlSweepInterval) {
  clearInterval(this.ttlSweepInterval);
  this.ttlSweepInterval = undefined;
}
```

**Import** `inferEndpointType` at top of `relay-core.ts`:

```typescript
import { inferEndpointType } from './types.js';
```

**Public accessor** (in the Query Facade section):

```typescript
/** Returns the configured dispatch inbox TTL in milliseconds. */
getDispatchInboxTtlMs(): number {
  return this.dispatchInboxTtlMs;
}
```

---

### Phase 3: relay_send_and_wait In-Process Progress Aggregation

**`apps/server/src/services/core/mcp-tools/relay-tools.ts`** — update `createRelayQueryHandler`:

**Add import** at top:

```typescript
import type { RelayProgressPayload } from '@dorkos/shared/relay-schemas';
```

**Replace the Promise block** (currently lines ~159–180) with progress-accumulating version:

```typescript
const progressEvents: RelayProgressPayload[] = [];

const reply = await new Promise<{
  payload: unknown;
  progress: RelayProgressPayload[];
  from: string;
  id: string;
}>((resolve, reject) => {
  let cleanup: () => void = () => {};

  const timer = setTimeout(() => {
    cleanup();
    reject(new Error(`relay_send_and_wait timed out after ${timeoutMs}ms (sent ${sentMessageId})`));
  }, timeoutMs);

  const unsub = relay.subscribe(inboxSubject, (envelope) => {
    const payload = envelope.payload as Record<string, unknown>;

    // Accumulate progress events (type:progress, done:false) without resolving
    if (payload?.type === 'progress' && payload?.done === false) {
      progressEvents.push(payload as RelayProgressPayload);
      return;
    }

    // Any final message (agent_result with done:true, or plain payload for non-CCA compat)
    cleanup();
    resolve({ payload, progress: progressEvents, from: envelope.from, id: envelope.id });
  });

  cleanup = () => {
    clearTimeout(timer);
    unsub();
  };
});
```

**Update return statement:**

```typescript
return jsonContent({
  reply: reply.payload,
  progress: reply.progress,
  from: reply.from,
  replyMessageId: reply.id,
  sentMessageId,
});
```

**Update tool description** for `relay_send_and_wait`:

```
Send a message to an agent and WAIT for the reply in a single call. Preferred over
relay_send + relay_inbox polling for request/reply patterns. Internally registers an
ephemeral inbox, sends the message with replyTo set, and blocks until the target agent
replies or the timeout elapses.

Response: { reply, progress, from, replyMessageId, sentMessageId }
  reply: the agent's final response payload
  progress: array of intermediate steps (populated for CCA agents on multi-step tasks;
            empty for non-CCA or instant responses)
            Each step: { type: "progress", step, step_type: "message"|"tool_result", text, done: false }
```

---

### Phase 4: CCA Broadens Streaming to All Inbox ReplyTos

**`packages/relay/src/adapters/claude-code-adapter.ts`** — update `handleAgentMessage()`:

**Replace lines 427–429:**

```typescript
// Before:
const isDispatchInbox = envelope.replyTo?.startsWith('relay.inbox.dispatch.');
const isQueryInbox = envelope.replyTo?.startsWith('relay.inbox.') && !isDispatchInbox;

// After:
// All relay.inbox.* replyTos now receive full streaming (progress events + final agent_result).
// relay_send_and_wait accumulates progress internally and returns a single MCP response.
const isInboxReplyTo = envelope.replyTo?.startsWith('relay.inbox.');
```

**In the streaming loop** — replace all `isDispatchInbox`/`isQueryInbox` references:

```typescript
// Before (lines ~444–490):
if (isDispatchInbox) {
  // ... text accumulation and progress publishing ...
} else if (isQueryInbox) {
  // ... text delta collection only ...
} else {
  // ... raw event streaming ...
}

// After:
if (isInboxReplyTo) {
  // All relay.inbox.* — same progress streaming as dispatch (formerly dispatch-only)
  if (event.type === 'text_delta') {
    const data = event.data as { text: string };
    messageBuffer += data.text;
    collectedText += data.text;
  }
  if (event.type === 'tool_call_start' && messageBuffer) {
    stepCounter++;
    await this.publishDispatchProgress(
      envelope,
      stepCounter,
      'message',
      messageBuffer,
      ccaSessionKey
    );
    messageBuffer = '';
  }
  if (event.type === 'tool_result') {
    stepCounter++;
    const data = event.data as { content?: string; tool_use_id?: string };
    const text = typeof data.content === 'string' ? data.content : JSON.stringify(data);
    await this.publishDispatchProgress(envelope, stepCounter, 'tool_result', text, ccaSessionKey);
  }
} else {
  // relay.agent.*, relay.human.* — existing raw event streaming (unchanged)
  await this.publishResponse(envelope, event, ccaSessionKey);
}
```

**Post-loop block** — replace `isDispatchInbox`/`isQueryInbox` conditions:

```typescript
// After loop — flush and publish final result for all relay.inbox.* replyTos
if (isInboxReplyTo && envelope.replyTo && this.relay) {
  if (messageBuffer) {
    stepCounter++;
    await this.publishDispatchProgress(
      envelope,
      stepCounter,
      'message',
      messageBuffer,
      ccaSessionKey
    );
  }
  await this.publishAgentResult(envelope, collectedText, ccaSessionKey);
}
```

The `publishDispatchProgress` method name remains unchanged — it already handles any `relay.inbox.*` subject correctly (uses `envelope.replyTo` as the publish target, not the method name's "dispatch" label).

---

### Phase 5: context-builder.ts Documentation Update

**`apps/server/src/services/core/context-builder.ts`** — update `RELAY_TOOLS_CONTEXT`:

1. **relay_send_and_wait workflow** — update response shape and add progress note:

   ```
   Workflow: Query another agent — SHORT/MEDIUM tasks (≤10 min, PREFERRED)
   2. relay_send_and_wait(..., timeout_ms=600000)
      → Blocks until reply (max 10 min / 600 000 ms)
      → Returns: { reply, progress, from, replyMessageId, sentMessageId }
        reply: agent's final response
        progress: intermediate steps (empty for quick replies; populated for multi-step CCA tasks)
                  Each: { type: "progress", step, step_type: "message"|"tool_result", text, done: false }
   ```

2. **Subject hierarchy** — add TTL note for dispatch inboxes:

   ```
   relay.inbox.dispatch.{UUID}  — ephemeral inbox for relay_send_async (caller-managed; server auto-expires after 30 min)
   ```

3. **relay_list_endpoints** — add note about new fields:
   ```
   relay_list_endpoints → each endpoint includes: subject, type, expiresAt
     type: 'dispatch'|'query'|'persistent'|'agent'|'unknown'
     expiresAt: ISO expiry timestamp for dispatch endpoints; null for others
   ```

---

## Data Flow

### Endpoint type at list time

```
relay_list_endpoints()
  → relay.listEndpoints()       [in-memory Map iteration, O(n)]
  → for each ep:
      type = inferEndpointType(ep.subject)   [pure string comparison]
      expiresAt = type==='dispatch'
                    ? new Date(ep.registeredAt).getTime() + dispatchInboxTtlMs → ISO
                    : null
  → return { endpoints: typed[], count }
```

### TTL sweeper lifecycle

```
RelayCore constructor
  → startTtlSweeper()
      setInterval(ttlSweepIntervalMs=5min)
        → listEndpoints() [in-memory]
        → filter: inferEndpointType === 'dispatch' && age > dispatchInboxTtlMs
        → unregisterEndpoint(subject) for each expired
             → watcherManager.stopWatcher(hash)
             → endpointRegistry.unregisterEndpoint(subject)
                  → returns false if already removed (race-safe)
RelayCore.close()
  → clearInterval(ttlSweepInterval)     [first]
  → ... existing cleanup ...
```

### relay_send_and_wait with progress

```
Caller → relay_send_and_wait(to_subject, payload, timeout_ms=600000)
  → registerEndpoint(relay.inbox.query.{UUID})
  → relay.publish(to_subject, payload, { replyTo: relay.inbox.query.{UUID} })
  → subscribe(relay.inbox.query.{UUID}, handler):
       message arrives:
         if type==='progress' && done===false → push to progressEvents[]
         else → resolve({ payload, progress: progressEvents, from, id })
  → finally: unregisterEndpoint(relay.inbox.query.{UUID})
  ← return { reply, progress[], from, replyMessageId, sentMessageId }

CCA (Phase 4) — query inbox now behaves identically to dispatch:
  for each StreamEvent:
    text_delta → accumulate in messageBuffer
    tool_call_start → publishDispatchProgress(step_type='message')
    tool_result → publishDispatchProgress(step_type='tool_result')
  post-loop:
    publishDispatchProgress(remaining messageBuffer)
    publishAgentResult(collectedText, done:true)
```

---

## User Experience

### Agent using relay_send_and_wait (medium-duration task)

**Before:** Calls `relay_send_and_wait(timeout_ms=600000)` and waits up to 10 minutes. Response arrives: `{ reply: "Done.", from: ..., replyMessageId: ..., sentMessageId: ... }`. No insight into what happened during those minutes.

**After:** Same call. Response: `{ reply: "Done.", progress: [{ step: 1, step_type: 'message', text: 'Analyzing...', done: false }, { step: 2, step_type: 'tool_result', text: 'file contents', done: false }, ...], from: ..., ... }`. Agent can inspect `progress` to understand the agent's reasoning path.

### Agent inspecting topology

**Before:** `relay_list_endpoints()` returns `[{ subject: 'relay.inbox.dispatch.abc123', hash: '...', ... }]`. Agent must pattern-match the subject string to understand this is a dispatch inbox.

**After:** `[{ subject: 'relay.inbox.dispatch.abc123', type: 'dispatch', expiresAt: '2026-03-05T14:30:00.000Z', ... }]`. Self-describing.

### Operator

No configuration required. Defaults are sensible (30-min TTL, 5-min sweep). If needed, configure via `RelayOptions` constructor params. The sweeper runs silently and does not affect normal Relay operation.

---

## Testing Strategy

All new tests fit in existing test files. No new test files required.

### Unit Tests

**`apps/server/src/services/core/__tests__/relay-tools.test.ts`** (extend or create alongside existing):

```typescript
describe('relay_list_endpoints with type metadata', () => {
  it('returns correct type for dispatch, query, persistent, and agent endpoints', async () => {
    // Purpose: verify inferEndpointType is applied to each endpoint in response.
    // Arrange: mock relayCore.listEndpoints() returning one of each subject type.
    // Assert: response.endpoints[i].type matches expected value for each.
  });

  it('returns expiresAt ISO string for dispatch endpoints and null for others', async () => {
    // Purpose: verify TTL transparency field computation.
    // Arrange: mock relayCore.getDispatchInboxTtlMs() returning 30 * 60 * 1000.
    // Assert: dispatch endpoint expiresAt ≈ registeredAt + 30min; others are null.
  });
});

describe('relay_send_and_wait progress accumulation', () => {
  it('accumulates progress events and returns them in progress array', async () => {
    // Purpose: verify progress[] is populated when progress events precede agent_result.
    // Arrange: mock subscribe handler that emits 2 progress events then agent_result.
    // Assert: reply.progress.length === 2; reply.reply === agent_result payload.
  });

  it('returns empty progress array when first message is non-progress (non-CCA compat)', async () => {
    // Purpose: backward compat — agents that reply with a plain payload still resolve correctly.
    // Arrange: mock subscribe handler that emits a plain { text: 'hello' } payload.
    // Assert: reply.progress is empty; reply.reply === the plain payload.
  });
});
```

### Integration Tests

**`packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`** — two changes:

#### Update existing test (line 262)

The test `'still publishes single agent_result for relay.inbox.query.* replyTo (backward compat)'` currently asserts no progress events and exactly 1 message for query inboxes. After Phase 4, query inboxes receive progress + agent_result. **Rename and update:**

```typescript
it('publishes progress events followed by agent_result for relay.inbox.query.* replyTo', async () => {
  // Purpose: verify Phase 4 behavior — query inboxes now receive full streaming.
  // This replaces the old "backward compat" guard which was for spec #91 only.
  await relay.registerEndpoint('relay.inbox.query.test-uuid');

  const receivedPayloads: unknown[] = [];
  relay.subscribe('relay.inbox.query.test-uuid', (envelope) => {
    receivedPayloads.push(envelope.payload);
  });

  vi.mocked(agentManager.sendMessage).mockReturnValue(
    (async function* () {
      yield { type: 'text_delta', data: { text: 'Thinking...' } } as StreamEvent;
      yield { type: 'tool_call_start', data: { tool_use_id: 'tu1', name: 'Read' } } as StreamEvent;
      yield { type: 'tool_result', data: { tool_use_id: 'tu1', content: 'file' } } as StreamEvent;
      yield { type: 'text_delta', data: { text: 'Done.' } } as StreamEvent;
      yield { type: 'done', data: {} } as StreamEvent;
    })()
  );

  await relay.publish(
    'relay.agent.lifeOS-session',
    { text: 'question' },
    { from: 'relay.agent.sender', replyTo: 'relay.inbox.query.test-uuid' }
  );

  await new Promise((resolve) => setTimeout(resolve, 50));

  const types = receivedPayloads.map((p) => (p as Record<string, unknown>).type);
  expect(types).toContain('progress');
  expect(types[types.length - 1]).toBe('agent_result');
});
```

#### Add new test 1: TTL sweeper

```typescript
it('TTL sweeper unregisters dispatch inboxes after configured TTL', async () => {
  // Purpose: guard against TTL sweeper regression — dispatch inboxes must auto-expire.
  // Uses vi.useFakeTimers() to avoid real delays.
  vi.useFakeTimers();

  const shortRelay = new RelayCore({
    dataDir: path.join(tmpDir, 'ttl-test'),
    dispatchInboxTtlMs: 100, // 100ms TTL
    ttlSweepIntervalMs: 50, // 50ms sweep
    adapterRegistry: new SingleAdapterRegistry(cca),
  });

  await shortRelay.registerEndpoint('relay.inbox.dispatch.ttl-test-uuid');
  expect(shortRelay.listEndpoints()).toHaveLength(1);

  // Advance time past TTL + sweep interval
  await vi.advanceTimersByTimeAsync(200);

  expect(shortRelay.listEndpoints()).toHaveLength(0);

  await shortRelay.close();
  vi.useRealTimers();
});
```

#### Add new test 2: relay_send_and_wait end-to-end with progress

```typescript
it('relay_send_and_wait resolves with populated progress array for CCA progress streaming', async () => {
  // Purpose: end-to-end guard for relay_send_and_wait Phase 3 enhancement.
  // relay_send_and_wait must accumulate progress events from query inbox and return them
  // in the response, not prematurely resolve on the first progress event.

  // This test validates the subscribe-level behavior by using RelayCore directly.
  // Register a query inbox and simulate the message flow that relay_send_and_wait uses.
  const inboxSubject = 'relay.inbox.query.e2e-test';
  await relay.registerEndpoint(inboxSubject);

  const progressEvents: unknown[] = [];
  let finalPayload: unknown;

  relay.subscribe(inboxSubject, (envelope) => {
    const payload = envelope.payload as Record<string, unknown>;
    if (payload?.type === 'progress' && payload?.done === false) {
      progressEvents.push(payload);
    } else {
      finalPayload = payload;
    }
  });

  // Simulate CCA publishing: 2 progress events + final agent_result
  await relay.publish(
    inboxSubject,
    { type: 'progress', step: 1, step_type: 'message', text: 'step1', done: false },
    { from: 'relay.agent.cca' }
  );
  await relay.publish(
    inboxSubject,
    { type: 'progress', step: 2, step_type: 'tool_result', text: 'tool output', done: false },
    { from: 'relay.agent.cca' }
  );
  await relay.publish(
    inboxSubject,
    { type: 'agent_result', text: 'Final answer', done: true },
    { from: 'relay.agent.cca' }
  );

  await new Promise((resolve) => setTimeout(resolve, 30));

  expect(progressEvents).toHaveLength(2);
  expect(finalPayload).toMatchObject({ type: 'agent_result', done: true });

  await relay.unregisterEndpoint(inboxSubject);
});
```

### Mocking Strategy

- `vi.useFakeTimers()` / `vi.advanceTimersByTimeAsync()` for TTL sweeper test — avoids real 5-min delays
- Existing `SingleAdapterRegistry` + `createMockAgentManager()` pattern for CCA roundtrip tests
- Mock `relayCore.listEndpoints()` and `relayCore.getDispatchInboxTtlMs()` for relay-tools unit tests

### Verification Commands

```bash
# Phase 1+3 (relay-tools):
pnpm vitest run apps/server/src/services/core/__tests__/

# Phase 2 (TTL sweeper):
pnpm vitest run packages/relay/src/__tests__/

# Phase 4 (CCA roundtrip):
pnpm vitest run packages/relay/src/__tests__/relay-cca-roundtrip.test.ts

# Full suite:
pnpm test -- --run
```

---

## Performance Considerations

- **TTL sweeper overhead**: `listEndpoints()` is an in-memory `Map` iteration, O(n) where n = registered endpoints. At 5-min intervals with at most hundreds of endpoints, cost is negligible.
- **`.unref()` on sweeper timer**: The interval handle does not prevent process exit in test environments or during graceful shutdown, avoiding test hangs.
- **relay_send_and_wait memory**: `progressEvents[]` accumulates in-memory until the promise resolves. For a 10-min task at one progress event per 10 seconds, this is ~60 events × ~300 bytes = ~18 KB per active `relay_send_and_wait` call. Acceptable.
- **No new I/O paths**: The sweeper reuses existing `unregisterEndpoint()` + chokidar watcher cleanup code. No new file system operations are introduced.

---

## Security Considerations

- **Disk resource bound**: The TTL sweeper prevents unbounded Maildir growth from leaked dispatch inboxes, bounding disk usage even if callers crash or omit cleanup.
- **`inferEndpointType` is pure**: Operates on already-validated subject strings; no external input exposure.
- **`expiresAt` is server-computed**: Not caller-controlled. No spoofing vector.
- **Progress accumulation source**: Progress events originate from CCA (the server process itself) publishing to the inbox. Not from untrusted external sources. No injection risk.

---

## Documentation

| Document                                           | Change                                                                                                                                |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `contributing/architecture.md`                     | Add Relay section note: endpoint `type` field and 30-min dispatch TTL sweeper                                                         |
| `contributing/api-reference.md`                    | Update `relay_list_endpoints` (new `type`/`expiresAt` fields) and `relay_send_and_wait` (new `progress[]` field) response shapes      |
| `apps/server/src/services/core/context-builder.ts` | Update `RELAY_TOOLS_CONTEXT` (Phase 5) — relay_send_and_wait response shape, dispatch inbox TTL note, relay_list_endpoints field note |

---

## Implementation Phases

### Phase 1 — Endpoint Type Metadata

**Files:** `packages/relay/src/types.ts` (add `EndpointType` + `inferEndpointType`), `apps/server/src/services/core/mcp-tools/relay-tools.ts` (update handler + tool description)
**Verification:** `pnpm vitest run apps/server/src/services/core/__tests__/`

### Phase 2 — TTL Sweeper

**Files:** `packages/relay/src/types.ts` (extend `RelayOptions`), `packages/relay/src/relay-core.ts` (add fields, `startTtlSweeper()`, `getDispatchInboxTtlMs()`, update `close()`)
**Verification:** `pnpm vitest run packages/relay/src/__tests__/`

### Phase 3 — relay_send_and_wait Progress Aggregation

**Files:** `apps/server/src/services/core/mcp-tools/relay-tools.ts` (update subscribe handler + return shape + tool description)
**Verification:** `pnpm vitest run apps/server/src/services/core/__tests__/`

### Phase 4 — CCA Broadens Streaming

**Files:** `packages/relay/src/adapters/claude-code-adapter.ts` (rename `isDispatchInbox`/`isQueryInbox` → `isInboxReplyTo`), `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts` (update 1 existing test, add 2 new)
**Verification:** `pnpm vitest run packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`

### Phase 5 — context-builder Docs

**Files:** `apps/server/src/services/core/context-builder.ts` (update `RELAY_TOOLS_CONTEXT`)
**Verification:** `pnpm test -- --run`

---

## Open Questions

None. All decisions were resolved during ideation (see `specs/relay-inbox-lifecycle/01-ideation.md` Section 6).

---

## Related ADRs

Candidates for extraction via `/adr:from-spec relay-inbox-lifecycle`:

- Derive endpoint type from subject prefix (zero schema change, canonical source of truth)
- Periodic sweeper pattern over timer-per-resource for TTL management
- In-process aggregation for relay_send_and_wait progress (MCP single-response constraint)

---

## References

- **Spec #91** — `specs/relay-async-query/02-specification.md` — prerequisite implementing `relay_send_async`, `relay_unregister_endpoint`, CCA progress streaming to dispatch inboxes, 600 s `relay_send_and_wait` timeout
- **Ideation** — `specs/relay-inbox-lifecycle/01-ideation.md` — research, pre-reading notes, and full decision rationale
- **CCA streaming logic** — `packages/relay/src/adapters/claude-code-adapter.ts` lines 422–490 — existing `isDispatchInbox`/`isQueryInbox` branching to be replaced
- **Backward compat test** — `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts` line 262 — the test to be updated in Phase 4
- **relay-tools current implementation** — `apps/server/src/services/core/mcp-tools/relay-tools.ts` lines 82–198 — `relay_list_endpoints` and `relay_send_and_wait` handlers
- **RelayOptions** — `packages/relay/src/types.ts` lines 148–172 — interface to extend with TTL params
- **RelayCore constructor** — `packages/relay/src/relay-core.ts` lines 159–248 — TTL sweeper initialization point
- **RelayCore.close()** — `packages/relay/src/relay-core.ts` lines 671–703 — TTL sweeper teardown point
- **RelayProgressPayloadSchema** — `packages/shared/src/relay-schemas.ts` lines 621–633 — existing progress payload type
