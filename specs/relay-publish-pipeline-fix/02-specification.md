---
slug: relay-publish-pipeline-fix
number: 70
created: 2026-02-27
status: in-progress
---

# Specification: Relay Publish Pipeline Fix & Adapter System Improvements

**Status:** In Progress
**Authors:** Claude Code, 2026-02-27
**Source Ideation:** `specs/relay-publish-pipeline-fix/01-ideation.md` (Spec #70)
**Related:** Spec 50 (Relay Core), Spec 53 (External Adapters), Spec 57 (Runtime Adapters), ADR-0029

---

## 1. Overview

Fix the critical bug in `relay-core.ts:publish()` where an early return at lines 308–315 skips adapter delivery when no Maildir endpoints match the target subject. This completely blocks all Relay-based chat dispatch and Pulse scheduled runs. Additionally, address 9 companion issues across the adapter delivery path to bring the publish pipeline to production quality.

## 2. Background / Problem Statement

The Relay publish pipeline was designed in Spec 50 with only Maildir endpoints as delivery targets. When Spec 53 introduced adapters, adapter delivery code was appended **after** the early return for zero-endpoint subjects — making it unreachable for adapter-only subjects like `relay.agent.*` and `relay.system.pulse.*`.

**The bug:** `publish()` at `relay-core.ts:308-315` dead-letters the message and returns `{ deliveredTo: 0 }` when `findMatchingEndpoints()` returns an empty array. The adapter delivery code at lines 337–348 is never executed. Since `ClaudeCodeAdapter` handles `relay.agent.>` and `relay.system.pulse.>` subjects without registering Maildir endpoints, **every** chat message and Pulse dispatch sent via Relay is silently dead-lettered.

**Current buggy pipeline:**

```
validate → access control → rate limit → build envelope
  → findMatchingEndpoints()
  → IF empty: DLQ + early return ← BUG: adapter delivery at line 337 is UNREACHABLE
  → IF non-empty: deliver to Maildir endpoints → deliver to adapters → return
```

**Impact:**

- All Relay-routed chat messages (POST `/sessions/:id/messages` with `DORKOS_RELAY_ENABLED=true`) are dead-lettered
- All Pulse scheduled dispatches via Relay (`relay.system.pulse.*`) are dead-lettered
- The existing test suite validates this buggy behavior as correct (`deliveredTo: 0` for unmatched subjects)

## 3. Goals

- Fix the critical early-return bug so adapters receive messages for adapter-only subjects
- Treat adapters as first-class delivery targets alongside Maildir endpoints (unified fan-out)
- Propagate rich `DeliveryResult` from adapters through the publish pipeline
- Add timeout protection for adapter delivery (30s)
- Dead-letter messages when adapter is the sole target and delivery fails
- Index adapter-delivered messages in SQLite for audit trail completeness
- Create trace spans in `relay-core` for adapter delivery (not just inside individual adapters)
- Propagate real trace IDs from `publishViaRelay()` to the client
- Improve console endpoint registration error handling
- Bring test coverage from zero adapter integration tests to comprehensive coverage

## 4. Non-Goals

- New adapter types (Telegram, webhook improvements beyond what's needed for the fix)
- Full Relay Convergence migration (Spec 55)
- Mesh changes
- Adapter hot-reload improvements beyond the fix
- Force-directed layout or drag-to-rearrange in topology
- Subscription dispatch changes (subscription delivery at lines 328–333 is correct and unaffected)

## 5. Technical Dependencies

| Dependency       | Version   | Purpose                                   |
| ---------------- | --------- | ----------------------------------------- |
| `@dorkos/relay`  | workspace | Publish pipeline, adapter registry, types |
| `@dorkos/shared` | workspace | Relay schemas                             |
| `@dorkos/db`     | workspace | SQLite via Drizzle                        |
| `better-sqlite3` | ^11.x     | SQLite engine                             |
| `ulidx`          | ^2.x      | ULID generation                           |
| `vitest`         | ^3.x      | Testing                                   |

No new external dependencies required.

## 6. Detailed Design

### 6.1 Issue 1 (Critical): Unified Fan-Out in `publish()` — `relay-core.ts`

Replace the early-return pattern with a unified fan-out model. Both Maildir endpoints and adapters are attempted before any dead-letter decision is made.

**Current code (lines 304–355):**

```typescript
// 5. Find matching endpoints
const matchingEndpoints = this.findMatchingEndpoints(subject);

// 6. Deliver to each matching endpoint
if (matchingEndpoints.length === 0) {
  // Dead-letter and return — ADAPTER DELIVERY IS SKIPPED
  const { hashSubject } = await import('./endpoint-registry.js');
  const subjectHash = hashSubject(subject);
  await this.maildirStore.ensureMaildir(subjectHash);
  await this.deadLetterQueue.reject(subjectHash, envelope, 'no matching endpoints');
  return { messageId, deliveredTo: 0 };
}

let deliveredTo = 0;
// ... Maildir delivery loop ...

// 7. Deliver to matching external adapter (after Maildir endpoints)
if (this.adapterRegistry) {
  try {
    const context = this.adapterContextBuilder?.(subject);
    const adapterDelivered = await this.adapterRegistry.deliver(subject, envelope, context);
    if (adapterDelivered) {
      deliveredTo++;
    }
  } catch (err) {
    console.warn('RelayCore: adapter delivery failed:', err instanceof Error ? err.message : err);
  }
}
```

**New code:**

```typescript
// 5. Find matching Maildir endpoints
const matchingEndpoints = this.findMatchingEndpoints(subject);

// 6. Deliver to Maildir endpoints (may be empty — that's OK)
let deliveredTo = 0;
const rejected: PublishResult['rejected'] = [];
const mailboxPressure: Record<string, number> = {};

for (const endpoint of matchingEndpoints) {
  const result = await this.deliverToEndpoint(endpoint, envelope);
  if (result.delivered) deliveredTo++;
  if (result.rejected) rejected.push(result.rejected);
  if (result.pressure !== undefined) mailboxPressure[endpoint.hash] = result.pressure;
}

// 7. Deliver to matching adapter (unified fan-out — always attempted)
let adapterResult: DeliveryResult | null = null;
if (this.adapterRegistry) {
  adapterResult = await this.deliverToAdapter(subject, envelope);
  if (adapterResult?.success) deliveredTo++;
}

// 8. Dead-letter only when NOTHING delivered
if (deliveredTo === 0) {
  const { hashSubject } = await import('./endpoint-registry.js');
  const subjectHash = hashSubject(subject);
  await this.maildirStore.ensureMaildir(subjectHash);

  const reason = adapterResult?.error
    ? `adapter delivery failed: ${adapterResult.error}`
    : 'no matching endpoints or adapters';
  await this.deadLetterQueue.reject(subjectHash, envelope, reason);
}

return {
  messageId,
  deliveredTo,
  ...(rejected.length > 0 && { rejected }),
  ...(Object.keys(mailboxPressure).length > 0 && { mailboxPressure }),
  ...(adapterResult && { adapterResult }),
};
```

**Key change:** The early return is removed. Maildir delivery and adapter delivery are both attempted unconditionally. Dead-lettering happens only when `deliveredTo === 0` after all delivery targets have been tried.

### 6.2 New Private Method: `deliverToAdapter()` — `relay-core.ts`

Extract adapter delivery into a private method with timeout protection, SQLite indexing, and trace span creation. This addresses Issues 1, 3, 4, 8, and 9 in a single cohesive method.

```typescript
/** Adapter delivery timeout in milliseconds. */
private static readonly ADAPTER_TIMEOUT_MS = 30_000;

/**
 * Deliver a message to a matching adapter with timeout protection,
 * SQLite indexing, and trace span creation.
 *
 * @param subject - The target subject
 * @param envelope - The relay envelope to deliver
 * @returns DeliveryResult or null if no adapter matched
 */
private async deliverToAdapter(
  subject: string,
  envelope: RelayEnvelope,
): Promise<DeliveryResult | null> {
  if (!this.adapterRegistry) return null;

  const context = this.adapterContextBuilder?.(subject);

  try {
    const deliveryPromise = this.adapterRegistry.deliver(subject, envelope, context);

    const result = await Promise.race([
      deliveryPromise,
      new Promise<DeliveryResult>((_, reject) =>
        setTimeout(() => reject(new Error('adapter delivery timeout (30s)')), RelayCore.ADAPTER_TIMEOUT_MS),
      ),
    ]);

    // Index adapter-delivered messages in SQLite for audit trail
    if (result && result.success) {
      const { hashSubject } = await import('./endpoint-registry.js');
      const subjectHash = hashSubject(subject);
      this.sqliteIndex.insertMessage({
        id: envelope.id,
        subject,
        endpointHash: `adapter:${subjectHash}`,
        status: 'delivered',
        createdAt: envelope.createdAt,
        expiresAt: null,
      });
    }

    return result;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.warn('RelayCore: adapter delivery failed:', errorMessage);
    return {
      success: false,
      error: errorMessage,
      deadLettered: false, // caller decides DLQ based on deliveredTo
      durationMs: undefined,
    };
  }
}
```

### 6.3 Issue 2: Propagate `DeliveryResult` — `adapter-registry.ts` + `types.ts`

**`types.ts` — Update `AdapterRegistryLike.deliver()` return type:**

```typescript
// Before:
export interface AdapterRegistryLike {
  deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<boolean>;
}

// After:
export interface AdapterRegistryLike {
  deliver(
    subject: string,
    envelope: RelayEnvelope,
    context?: AdapterContext
  ): Promise<DeliveryResult | null>;
}
```

**`adapter-registry.ts` — Update `deliver()` to return `DeliveryResult | null`:**

```typescript
// Before:
async deliver(subject: string, envelope: RelayEnvelope, context?: AdapterContext): Promise<boolean> {
  const adapter = this.getBySubject(subject);
  if (!adapter) return false;
  await adapter.deliver(subject, envelope, context);
  return true;
}

// After:
async deliver(
  subject: string,
  envelope: RelayEnvelope,
  context?: AdapterContext,
): Promise<DeliveryResult | null> {
  const adapter = this.getBySubject(subject);
  if (!adapter) return null;
  return adapter.deliver(subject, envelope, context);
}
```

This propagates the full `DeliveryResult` (success, error, deadLettered, responseMessageId, durationMs) through the pipeline instead of discarding it.

### 6.4 Issue 3: Timeout Protection — `relay-core.ts`

Handled by `deliverToAdapter()` (Section 6.2). Uses `Promise.race` with a 30-second timeout. The timeout value is a static class property for easy adjustment.

**Why 30 seconds:** `ClaudeCodeAdapter.deliver()` returns quickly (spawns the agent session asynchronously). The timeout protects against future slow adapters (Telegram webhook retries, etc.) without affecting current behavior.

### 6.5 Issue 4: DLQ for Adapter Failures — `relay-core.ts`

Handled by the unified fan-out in Section 6.1. When `deliveredTo === 0` after all attempts, the message is dead-lettered with a descriptive reason:

- If adapter was attempted and returned an error: `'adapter delivery failed: <error>'`
- If no adapter matched either: `'no matching endpoints or adapters'`

**Partial delivery (Maildir succeeded but adapter failed):** The message is NOT dead-lettered because it was delivered to at least one target. The adapter error is logged and available in the returned `adapterResult`.

### 6.6 Issue 5: Real Trace IDs — `sessions.ts`

**Before:**

```typescript
return {
  messageId: publishResult.messageId,
  traceId: 'no-trace',
};
```

**After:**

```typescript
return {
  messageId: publishResult.messageId,
  traceId: publishResult.messageId, // Use message ID as trace correlation ID
};
```

The envelope's ULID message ID is a natural trace correlation ID — it's unique per publish and can be used to look up trace spans, SQLite index entries, and dead letters. No separate trace ID generation is needed.

### 6.7 Issue 6: Race Condition Documentation — No Code Change

The race between POST message and SSE subscription establishment is a known limitation. The subscription dispatch at lines 328–333 of `relay-core.ts` happens before the early return path (which this spec removes), so subscription-based delivery mitigates this for most cases. Document in `contributing/architecture.md` as a known edge case.

### 6.8 Issue 7: Console Endpoint Registration — `sessions.ts`

The current `publishViaRelay()` swallows all errors from `registerEndpoint()`:

```typescript
try {
  await relayCore.registerEndpoint(consoleEndpoint);
} catch {
  // Endpoint already registered — ignore
}
```

This is correct for "already registered" errors but masks real failures (disk errors, permission issues). Improve to only ignore the expected case:

```typescript
try {
  await relayCore.registerEndpoint(consoleEndpoint);
} catch (err) {
  // Only ignore "already registered" — rethrow real failures
  const message = err instanceof Error ? err.message : String(err);
  if (!message.includes('already registered')) {
    console.error('publishViaRelay: failed to register console endpoint:', message);
  }
}
```

Additionally, with Issue 1 fixed, response publishing to `relay.human.console.*` will succeed via adapter delivery even if the console endpoint registration fails, because the subscription dispatch at lines 328–333 handles delivery to subscribers.

### 6.9 Issue 8: SQLite Indexing for Adapter Deliveries — `relay-core.ts`

Handled by `deliverToAdapter()` (Section 6.2). On successful adapter delivery, an index entry is inserted with:

```typescript
this.sqliteIndex.insertMessage({
  id: envelope.id,
  subject,
  endpointHash: `adapter:${subjectHash}`, // Prefixed to distinguish from Maildir endpoints
  status: 'delivered',
  createdAt: envelope.createdAt,
  expiresAt: null,
});
```

The `adapter:` prefix on `endpointHash` distinguishes adapter-delivered messages from Maildir-delivered messages in queries and metrics.

### 6.10 Issue 9: Trace Span in RelayCore — Not in Scope (Documented)

Trace span creation currently lives inside `ClaudeCodeAdapter` (which has `TraceStore` dependency). Moving it to `relay-core` would require:

1. Adding `TraceStore` as a dependency of `RelayCore` (currently only server-side)
2. The `@dorkos/relay` package would gain a dependency on `TraceStore`

This is better addressed in a future spec that consolidates tracing. For now, the `adapterContextBuilder` already passes `trace` context to adapters, and `ClaudeCodeAdapter` creates trace spans internally. The `deliverToAdapter()` method in Section 6.2 returns timing data (`durationMs` in `DeliveryResult`) for observability.

**Decision:** Document as a known gap. Trace spans remain inside individual adapters for now.

### 6.11 Issue 10: Adapter Context Builder Returns Undefined — No Code Change

The optional chaining `this.adapterContextBuilder?.(subject)` is correct behavior. When no context builder is set (or it returns undefined), the adapter receives `undefined` context and handles it gracefully. `ClaudeCodeAdapter` checks for `context?.agent?.directory` and falls back to its own resolution logic.

**Decision:** Document as expected behavior. No code change needed.

### 6.12 `PublishResult` Type Extension — `relay-core.ts`

Extend `PublishResult` to include adapter delivery result:

```typescript
export interface PublishResult {
  messageId: string;
  deliveredTo: number;
  rejected?: Array<{
    endpointHash: string;
    reason: 'backpressure' | 'circuit_open' | 'rate_limited' | 'budget_exceeded';
  }>;
  mailboxPressure?: Record<string, number>;
  /** Result from adapter delivery, if attempted. */
  adapterResult?: DeliveryResult;
}
```

And update `PublishResultLike` in `types.ts` to mirror:

```typescript
export interface PublishResultLike {
  messageId: string;
  deliveredTo: number;
  rejected?: Array<{
    endpointHash: string;
    reason: 'backpressure' | 'circuit_open' | 'rate_limited' | 'budget_exceeded';
  }>;
  mailboxPressure?: Record<string, number>;
  adapterResult?: DeliveryResult;
}
```

## 7. User Experience

From the user's perspective, this fix is invisible — it removes a broken state rather than adding new UI. After the fix:

- **Chat via Relay:** Messages sent from the chat UI reach the Claude Code agent and responses stream back. No change to the chat interface.
- **Pulse via Relay:** Scheduled runs dispatch correctly. No change to the Pulse UI.
- **Dead letters:** Fewer spurious dead letters in the Relay panel. Dead letters now only appear for genuine delivery failures.
- **Relay panel metrics:** Adapter delivery counts appear in the `deliveredTo` metric. No Relay panel UI changes required.

## 8. Testing Strategy

### 8.1 Unit Tests: `relay-core.test.ts` (Updates)

**Fix existing buggy test:**

```typescript
// BEFORE (validates buggy behavior):
it('returns deliveredTo=0 when no endpoints match', async () => {
  const result = await relay.publish('relay.nobody.here', { content: 'hello' }, publishOpts);
  expect(result.deliveredTo).toBe(0);
});

// AFTER (validates correct behavior — dead-letter when nothing matches):
it('dead-letters when no endpoints or adapters match', async () => {
  const result = await relay.publish('relay.nobody.here', { content: 'hello' }, publishOpts);
  expect(result.deliveredTo).toBe(0);
  // Verify DLQ was called
  const deadLetters = await relay.listDeadLetters({ limit: 10 });
  expect(deadLetters.some((d) => d.envelope.subject === 'relay.nobody.here')).toBe(true);
});
```

**New test: adapter-only delivery succeeds:**

```typescript
it('delivers to adapter when no Maildir endpoints match', async () => {
  const mockAdapter: AdapterRegistryLike = {
    setRelay: vi.fn(),
    deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 5 }),
    shutdown: vi.fn(),
  };
  const relayWithAdapter = await RelayCore.create({
    ...baseOpts,
    adapterRegistry: mockAdapter,
  });

  const result = await relayWithAdapter.publish(
    'relay.agent.test-session',
    { content: 'hello' },
    publishOpts
  );

  expect(result.deliveredTo).toBe(1);
  expect(result.adapterResult).toEqual({ success: true, durationMs: 5 });
  expect(mockAdapter.deliver).toHaveBeenCalledWith(
    'relay.agent.test-session',
    expect.objectContaining({ subject: 'relay.agent.test-session' }),
    undefined
  );
});
```

**New test: mixed delivery (Maildir + adapter):**

```typescript
it('delivers to both Maildir endpoints and adapter', async () => {
  await relay.registerEndpoint('relay.agent.test-session');
  const mockAdapter: AdapterRegistryLike = {
    setRelay: vi.fn(),
    deliver: vi.fn().mockResolvedValue({ success: true, durationMs: 3 }),
    shutdown: vi.fn(),
  };
  const relayMixed = await RelayCore.create({
    ...baseOpts,
    adapterRegistry: mockAdapter,
  });
  await relayMixed.registerEndpoint('relay.agent.test-session');

  const result = await relayMixed.publish(
    'relay.agent.test-session',
    { content: 'hello' },
    publishOpts
  );

  expect(result.deliveredTo).toBe(2); // Maildir + adapter
});
```

**New test: adapter failure with DLQ:**

```typescript
it('dead-letters when adapter is sole target and fails', async () => {
  const failingAdapter: AdapterRegistryLike = {
    setRelay: vi.fn(),
    deliver: vi.fn().mockResolvedValue({
      success: false,
      error: 'connection refused',
    }),
    shutdown: vi.fn(),
  };
  const relayFailing = await RelayCore.create({
    ...baseOpts,
    adapterRegistry: failingAdapter,
  });

  const result = await relayFailing.publish(
    'relay.agent.fail-session',
    { content: 'hello' },
    publishOpts
  );

  expect(result.deliveredTo).toBe(0);
  const dead = await relayFailing.listDeadLetters({ limit: 10 });
  expect(dead.some((d) => d.reason.includes('adapter delivery failed'))).toBe(true);
});
```

**New test: adapter timeout:**

```typescript
it('handles adapter delivery timeout gracefully', async () => {
  const slowAdapter: AdapterRegistryLike = {
    setRelay: vi.fn(),
    deliver: vi
      .fn()
      .mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ success: true }), 60_000))
      ),
    shutdown: vi.fn(),
  };
  const relaySlow = await RelayCore.create({
    ...baseOpts,
    adapterRegistry: slowAdapter,
  });

  // Use fake timers to avoid 30s real wait
  vi.useFakeTimers();
  const publishPromise = relaySlow.publish(
    'relay.agent.slow-session',
    { content: 'hello' },
    publishOpts
  );
  vi.advanceTimersByTime(31_000);
  const result = await publishPromise;
  vi.useRealTimers();

  expect(result.deliveredTo).toBe(0);
  expect(result.adapterResult?.error).toContain('timeout');
});
```

**New test: partial delivery (Maildir succeeds, adapter fails):**

```typescript
it('does NOT dead-letter when Maildir delivered but adapter failed', async () => {
  const failingAdapter: AdapterRegistryLike = {
    setRelay: vi.fn(),
    deliver: vi.fn().mockResolvedValue({ success: false, error: 'down' }),
    shutdown: vi.fn(),
  };
  const relayPartial = await RelayCore.create({
    ...baseOpts,
    adapterRegistry: failingAdapter,
  });
  await relayPartial.registerEndpoint('relay.agent.partial');

  const result = await relayPartial.publish(
    'relay.agent.partial',
    { content: 'hello' },
    publishOpts
  );

  expect(result.deliveredTo).toBe(1); // Maildir succeeded
  const dead = await relayPartial.listDeadLetters({ limit: 10 });
  expect(dead.filter((d) => d.envelope.subject === 'relay.agent.partial')).toHaveLength(0);
});
```

**New test: adapter context builder passed through:**

```typescript
it('passes adapter context through to adapter delivery', async () => {
  const mockAdapter: AdapterRegistryLike = {
    setRelay: vi.fn(),
    deliver: vi.fn().mockResolvedValue({ success: true }),
    shutdown: vi.fn(),
  };
  const mockContext: AdapterContext = {
    agent: { directory: '/tmp/test', runtime: 'claude-code' },
  };
  const relayWithContext = await RelayCore.create({
    ...baseOpts,
    adapterRegistry: mockAdapter,
    adapterContextBuilder: () => mockContext,
  });

  await relayWithContext.publish('relay.agent.ctx', { content: 'hi' }, publishOpts);

  expect(mockAdapter.deliver).toHaveBeenCalledWith(
    'relay.agent.ctx',
    expect.any(Object),
    mockContext
  );
});
```

### 8.2 Unit Tests: `adapter-registry.test.ts` (New File)

```typescript
// Purpose: Dedicated tests for AdapterRegistry lifecycle and delivery routing
describe('AdapterRegistry', () => {
  it('returns DeliveryResult from matched adapter', async () => {
    // Verifies that deliver() propagates the full DeliveryResult instead of boolean
  });

  it('returns null when no adapter matches subject', async () => {
    // Verifies null return for unmatched subjects
  });

  it('matches adapter by subject prefix', async () => {
    // Verifies getBySubject() prefix matching
  });

  it('matches adapter with array of subject prefixes', async () => {
    // Verifies array prefix matching (e.g., ClaudeCodeAdapter's two prefixes)
  });

  it('hot-reload swaps adapter without message loss', async () => {
    // Verifies hot-reload: new adapter starts, old stops, delivery continues
  });
});
```

### 8.3 Unit Tests: `sessions-relay.test.ts` (Updates)

**New test: real trace ID propagation:**

```typescript
it('returns message ID as trace ID instead of no-trace', async () => {
  // POST /sessions/:id/messages with Relay enabled
  // Verify response.traceId === response.messageId (not 'no-trace')
});
```

**New test: console endpoint registration error handling:**

```typescript
it('logs error when endpoint registration fails for non-duplicate reason', async () => {
  // Mock relayCore.registerEndpoint to throw non-duplicate error
  // Verify console.error is called
  // Verify publish still proceeds
});
```

### 8.4 Integration Tests

An integration test that exercises the full pipeline: publish → adapter → response → subscription dispatch. This requires a real `RelayCore` instance with an in-memory adapter (not the full `ClaudeCodeAdapter`).

```typescript
describe('relay-core adapter integration', () => {
  it('end-to-end: adapter-only publish → deliver → response', async () => {
    // 1. Create RelayCore with a test adapter that publishes a response
    // 2. Subscribe to the response subject
    // 3. Publish to the adapter's subject
    // 4. Verify adapter received the message
    // 5. Verify response arrived via subscription
    // 6. Verify SQLite index entry exists with 'adapter:' prefix
  });
});
```

### 8.5 Mocking Strategy

| Component             | Mock Strategy                                         |
| --------------------- | ----------------------------------------------------- |
| `AdapterRegistryLike` | `vi.fn()` mock object implementing the interface      |
| `DeliveryResult`      | Return literal objects `{ success: true/false, ... }` |
| `SqliteIndex`         | Real instance with temp directory (existing pattern)  |
| `MaildirStore`        | Real instance with temp directory (existing pattern)  |
| `DeadLetterQueue`     | Real instance (depends on MaildirStore + SqliteIndex) |
| Timeouts              | `vi.useFakeTimers()` for the 30s timeout test         |

## 9. Performance Considerations

**Adapter delivery is synchronous in the publish pipeline.** This is acceptable because:

1. `ClaudeCodeAdapter.deliver()` returns quickly — it spawns the agent session asynchronously and returns a `DeliveryResult` immediately
2. The 30s timeout protects against slow adapters
3. One adapter is checked per publish (the first prefix match)

**SQLite indexing for adapter messages** adds one write per adapter delivery. This matches the existing pattern for Maildir deliveries and is negligible overhead.

**No new dependencies or I/O paths.** The fix restructures existing code without adding new external calls.

## 10. Security Considerations

**No new attack surfaces.** The fix restructures internal control flow without exposing new endpoints or accepting new input.

**DLQ reason strings** now include adapter error messages. These are internal error strings (not user-supplied), so injection risk is negligible. Existing DLQ display code in the Relay panel already escapes output.

**Timeout protection** prevents a malicious or broken adapter from blocking the publish pipeline indefinitely.

## 11. Documentation

| Document                                          | Update Needed                                                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `contributing/architecture.md`                    | Add note about Relay adapter delivery as unified fan-out; document POST/SSE race condition as known edge case |
| `CHANGELOG.md`                                    | Add entry under [Unreleased] > Fixed                                                                          |
| `specs/relay-publish-pipeline-fix/01-ideation.md` | Status update to "specified"                                                                                  |

No new documentation files are needed.

## 12. Implementation Phases

### Phase 1: Core Fix (Critical Path)

1. **Update `AdapterRegistryLike` interface** in `types.ts` — change `deliver()` return type from `Promise<boolean>` to `Promise<DeliveryResult | null>`
2. **Update `AdapterRegistry.deliver()`** in `adapter-registry.ts` — return `DeliveryResult | null` instead of `boolean`
3. **Add `deliverToAdapter()` private method** to `RelayCore` in `relay-core.ts` — timeout, indexing, error handling
4. **Restructure `publish()`** in `relay-core.ts` — remove early return, implement unified fan-out
5. **Extend `PublishResult`** in `relay-core.ts` — add optional `adapterResult` field
6. **Extend `PublishResultLike`** in `types.ts` — mirror `adapterResult` field
7. **Update `publishViaRelay()`** in `sessions.ts` — real trace ID, improved error handling

### Phase 2: Test Coverage

8. **Fix existing buggy test** in `relay-core.test.ts` — update `deliveredTo=0` test
9. **Add adapter integration tests** to `relay-core.test.ts` — adapter-only, mixed, failure, timeout, partial delivery, context builder
10. **Create `adapter-registry.test.ts`** — dedicated registry tests
11. **Update `sessions-relay.test.ts`** — trace ID propagation, error handling

### Phase 3: Documentation & Cleanup

12. **Update `contributing/architecture.md`** — unified fan-out documentation, race condition note
13. **Update spec status** in `specs/manifest.json`

## 13. Files Modified

| File                                                      | Change Type | Description                                                                                                        |
| --------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/relay/src/types.ts`                             | Modify      | `AdapterRegistryLike.deliver()` return type → `DeliveryResult \| null`; add `adapterResult` to `PublishResultLike` |
| `packages/relay/src/adapter-registry.ts`                  | Modify      | `deliver()` returns `DeliveryResult \| null` instead of `boolean`                                                  |
| `packages/relay/src/relay-core.ts`                        | Modify      | Remove early return, add `deliverToAdapter()`, restructure `publish()`, extend `PublishResult`                     |
| `apps/server/src/routes/sessions.ts`                      | Modify      | Real trace ID, improved endpoint registration error handling                                                       |
| `packages/relay/src/__tests__/relay-core.test.ts`         | Modify      | Fix buggy test, add 7+ adapter integration tests                                                                   |
| `packages/relay/src/__tests__/adapter-registry.test.ts`   | Create      | Dedicated AdapterRegistry tests                                                                                    |
| `apps/server/src/routes/__tests__/sessions-relay.test.ts` | Modify      | Trace ID and error handling tests                                                                                  |

**Files confirmed NO changes needed:**

- `packages/relay/src/endpoint-registry.ts` — read-only usage
- `packages/relay/src/subscription-registry.ts` — subscription dispatch is correct
- `packages/relay/src/subject-matcher.ts` — pattern matching is correct
- `packages/relay/src/maildir-store.ts` — Maildir delivery is correct
- `packages/relay/src/dead-letter-queue.ts` — DLQ API is correct, just called differently
- `packages/relay/src/adapters/claude-code-adapter.ts` — adapter interface unchanged
- `packages/relay/src/adapters/webhook-adapter.ts` — adapter interface unchanged
- `packages/relay/src/adapters/telegram-adapter.ts` — adapter interface unchanged
- `apps/server/src/services/relay/adapter-manager.ts` — lifecycle management unchanged
- `apps/server/src/services/session/session-broadcaster.ts` — SSE fan-in unchanged
- `apps/client/src/layers/features/chat/model/use-chat-session.ts` — client unchanged
- `apps/client/src/layers/shared/lib/http-transport.ts` — transport unchanged

## 14. Open Questions

1. ~~**Adapter delivery timeout value**~~ (RESOLVED)
   **Answer:** 30 seconds, implemented as a static class property for easy adjustment.

2. ~~**DLQ for partial delivery failures**~~ (RESOLVED)
   **Answer:** No DLQ when Maildir succeeded but adapter failed. DLQ only when `deliveredTo === 0`.

3. ~~**Trace span creation location**~~ (RESOLVED)
   **Answer:** Remains inside individual adapters. Moving to relay-core deferred to a future tracing consolidation spec.

## 15. Related ADRs

| ADR      | Title                                          | Relevance                                                                                           |
| -------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| ADR-0029 | Replace MessageReceiver with ClaudeCodeAdapter | Established ClaudeCodeAdapter as unified dispatch; this fix enables it to actually receive messages |

## 16. References

- **Spec 50:** `specs/relay-core-library/02-specification.md` — Original publish pipeline (pre-adapter)
- **Spec 53:** `specs/relay-external-adapters/02-specification.md` — Adapter system introduction (bug origin)
- **Spec 57:** `specs/relay-runtime-adapters/02-specification.md` — ClaudeCodeAdapter design
- **Spec 55:** `specs/relay-convergence/01-ideation.md` — Convergence plan (depends on this fix)
- **Research:** `research/20260227_relay_publish_pipeline_fix.md` — NATS/RabbitMQ/Kafka pattern analysis
- **Ideation:** `specs/relay-publish-pipeline-fix/01-ideation.md` — Full root cause analysis and 10-issue registry
