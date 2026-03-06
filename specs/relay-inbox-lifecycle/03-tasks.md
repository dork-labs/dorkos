# relay-inbox-lifecycle — Implementation Task Breakdown

**Spec:** `specs/relay-inbox-lifecycle/02-specification.md`
**Generated:** 2026-03-05
**Mode:** full

---

## Overview

Three deferred enhancements from spec #91 (relay-async-query):

1. **Endpoint type metadata** — `relay_list_endpoints` returns `type` and `expiresAt` per endpoint, derived from subject prefix
2. **Server-side TTL sweeper** — `RelayCore` auto-expires dispatch inboxes after 30 min via `setInterval`
3. **relay_query progress aggregation** — `relay_query` accumulates CCA progress events and returns them in a new `progress[]` field
4. **CCA unified inbox streaming** — Query inboxes receive full progress streaming (same as dispatch inboxes)

---

## Task Summary

| ID | Phase | Title | Size | Priority | Depends On |
|----|-------|-------|------|----------|------------|
| 1.1 | 1 | Add EndpointType and inferEndpointType to packages/relay/src/types.ts | small | high | — |
| 1.2 | 1 | Extend RelayOptions with TTL fields in packages/relay/src/types.ts | small | high | 1.1 |
| 2.1 | 2 | Add TTL sweeper and getDispatchInboxTtlMs to RelayCore | medium | high | 1.1, 1.2 |
| 2.2 | 2 | Write TTL sweeper integration test in relay-cca-roundtrip.test.ts | medium | high | 2.1 |
| 3.1 | 3 | Update createRelayQueryHandler to accumulate progress events | medium | high | 1.1 |
| 3.2 | 3 | Write relay_query progress unit tests in relay-tools.test.ts | medium | high | 3.1 |
| 4.1 | 4 | Update ClaudeCodeAdapter to stream progress for all relay.inbox.* replyTos | medium | high | 1.1, 2.1 |
| 4.2 | 4 | Update existing backward-compat test in relay-cca-roundtrip.test.ts | small | high | 4.1 |
| 5.1 | 5 | Update createRelayListEndpointsHandler to include type and expiresAt fields | small | high | 1.1, 2.1 |
| 6.1 | 6 | Update RELAY_TOOLS_CONTEXT in context-builder.ts | small | medium | 3.1, 4.1, 5.1 |
| 7.1 | 7 | Run full test suite and verify all phases pass | small | high | all |

**Total tasks:** 11

---

## Phase 1 — Foundation: Types

### Task 1.1 — Add EndpointType and inferEndpointType to packages/relay/src/types.ts

**Files:** `packages/relay/src/types.ts`, `packages/relay/src/index.ts`

Add the `EndpointType` union type and `inferEndpointType()` pure function. Append at the end of `types.ts` after `DeliveryResult`. Export from the package barrel.

```typescript
/** Categorization of a Relay endpoint by subject prefix. */
export type EndpointType = 'dispatch' | 'query' | 'persistent' | 'agent' | 'unknown';

/**
 * Derive the logical type of a Relay endpoint from its subject prefix.
 *
 * @param subject - The endpoint's full subject string
 */
export function inferEndpointType(subject: string): EndpointType {
  if (subject.startsWith('relay.inbox.dispatch.')) return 'dispatch';
  if (subject.startsWith('relay.inbox.query.'))    return 'query';
  if (subject.startsWith('relay.inbox.'))           return 'persistent';
  if (subject.startsWith('relay.agent.'))           return 'agent';
  return 'unknown';
}
```

Add to `index.ts`:
```typescript
export { inferEndpointType } from './types.js';
export type { EndpointType } from './types.js';
```

---

### Task 1.2 — Extend RelayOptions with TTL fields

**Files:** `packages/relay/src/types.ts`

Add two optional fields to the `RelayOptions` interface:

```typescript
/** TTL for dispatch inboxes in milliseconds. Default: 30 * 60 * 1000 */
dispatchInboxTtlMs?: number;

/** Interval between TTL sweep runs in milliseconds. Default: 5 * 60 * 1000 */
ttlSweepIntervalMs?: number;
```

---

## Phase 2 — TTL Sweeper

### Task 2.1 — Add TTL sweeper and getDispatchInboxTtlMs to RelayCore

**Files:** `packages/relay/src/relay-core.ts`

Four changes:

1. Import `inferEndpointType` from `./types.js`
2. Add three private fields: `dispatchInboxTtlMs`, `ttlSweepIntervalMs`, `ttlSweepInterval`
3. Initialize in constructor after `startConfigWatcher()`, call `startTtlSweeper()`
4. Add `startTtlSweeper()` private method with `setInterval` + `.unref()`
5. Add `getDispatchInboxTtlMs()` public accessor
6. Update `close()` to `clearInterval` as the first cleanup step

Key implementation of `startTtlSweeper()`:

```typescript
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
  this.ttlSweepInterval.unref();
}
```

Close teardown (first lines of `close()`):
```typescript
if (this.ttlSweepInterval) {
  clearInterval(this.ttlSweepInterval);
  this.ttlSweepInterval = undefined;
}
```

---

### Task 2.2 — Write TTL sweeper integration tests

**Files:** `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`

Add two new tests:

**Test 1: TTL sweeper** — Uses `vi.useFakeTimers()` and a `RelayCore` with `dispatchInboxTtlMs: 100, ttlSweepIntervalMs: 50`. Registers a dispatch endpoint, advances fake time by 200ms, asserts `listEndpoints()` is empty.

**Test 2: relay_query end-to-end progress** — Registers a query inbox, subscribes with progress/final separation logic, publishes 2 progress events + 1 agent_result, asserts `progressEvents.length === 2` and `finalPayload.type === 'agent_result'`.

---

## Phase 3 — relay_query Progress Aggregation

### Task 3.1 — Update createRelayQueryHandler to accumulate progress events

**Files:** `apps/server/src/services/core/mcp-tools/relay-tools.ts`

Three changes:

1. Add import: `import type { RelayProgressPayload } from '@dorkos/shared/relay-schemas';`

2. Replace the Promise block to accumulate progress events before resolving:

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
    reject(new Error(`relay_query timed out after ${timeoutMs}ms (sent ${sentMessageId})`));
  }, timeoutMs);

  const unsub = relay.subscribe(inboxSubject, (envelope) => {
    const payload = envelope.payload as Record<string, unknown>;
    // Accumulate progress events without resolving
    if (payload?.type === 'progress' && payload?.done === false) {
      progressEvents.push(payload as RelayProgressPayload);
      return;
    }
    // Any final message resolves
    cleanup();
    resolve({ payload, progress: progressEvents, from: envelope.from, id: envelope.id });
  });

  cleanup = () => { clearTimeout(timer); unsub(); };
});
```

3. Update return statement to include `progress`:
```typescript
return jsonContent({
  reply: reply.payload,
  progress: reply.progress,
  from: reply.from,
  replyMessageId: reply.id,
  sentMessageId,
});
```

Also update the `relay_query` tool description to document the new `progress[]` field.

---

### Task 3.2 — Write relay_query progress unit tests

**Files:** `apps/server/src/services/core/__tests__/relay-tools.test.ts`

Add four tests across two describe blocks:

**`relay_list_endpoints with type metadata`:**
- Verify `inferEndpointType` is applied (dispatch → `'dispatch'`, query → `'query'`, etc.)
- Verify `expiresAt` is ISO string for dispatch, `null` for others

**`relay_query progress accumulation`:**
- Mock emits 2 progress events then `agent_result` → `progress.length === 2`
- Mock emits plain `{ text: 'hello' }` → `progress` is empty array (backward compat)

---

## Phase 4 — CCA Unified Inbox Streaming

### Task 4.1 — Update ClaudeCodeAdapter to stream progress for all relay.inbox.* replyTos

**Files:** `packages/relay/src/adapters/claude-code-adapter.ts`

Replace `isDispatchInbox`/`isQueryInbox` with unified `isInboxReplyTo`:

```typescript
// Before:
const isDispatchInbox = envelope.replyTo?.startsWith('relay.inbox.dispatch.');
const isQueryInbox = envelope.replyTo?.startsWith('relay.inbox.') && !isDispatchInbox;

// After:
const isInboxReplyTo = envelope.replyTo?.startsWith('relay.inbox.');
```

In the streaming loop, replace the dispatch/query branching with a single `isInboxReplyTo` branch that applies the full progress streaming logic (text accumulation, tool_call_start flush, tool_result progress). Non-inbox subjects continue to use raw event streaming.

In the post-loop block, replace two separate `if (isDispatchInbox ...)` and `if (isQueryInbox ...)` blocks with a single `if (isInboxReplyTo ...)` block that flushes remaining buffer and publishes `agent_result`.

---

### Task 4.2 — Update existing backward-compat test

**Files:** `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts` (line 262)

Rename the test from `'still publishes single agent_result for relay.inbox.query.* replyTo (backward compat)'` to `'publishes progress events followed by agent_result for relay.inbox.query.* replyTo'`.

Update the mock to yield a multi-step stream (text_delta → tool_call_start → tool_result → text_delta → done) and update assertions:

```typescript
// Old assertions (remove):
expect(receivedPayloads).toHaveLength(1);
expect(hasProgress).toBe(false);

// New assertions:
const types = receivedPayloads.map((p) => (p as Record<string, unknown>).type);
expect(types).toContain('progress');
expect(types[types.length - 1]).toBe('agent_result');
```

---

## Phase 5 — Update relay_list_endpoints Handler

### Task 5.1 — Update createRelayListEndpointsHandler to include type and expiresAt

**Files:** `apps/server/src/services/core/mcp-tools/relay-tools.ts`

Import `inferEndpointType` from `@dorkos/relay`. Replace the handler body to map each endpoint with `type` and `expiresAt`:

```typescript
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

Update the tool description to document the new `type` and `expiresAt` fields.

---

## Phase 6 — context-builder Documentation Update

### Task 6.1 — Update RELAY_TOOLS_CONTEXT in context-builder.ts

**Files:** `apps/server/src/services/core/context-builder.ts`

Three targeted string updates to `RELAY_TOOLS_CONTEXT`:

1. **relay_query workflow** — Change `SHORT tasks` to `SHORT/MEDIUM tasks`, update return shape from `{ reply, from, replyMessageId, sentMessageId }` to `{ reply, progress, from, replyMessageId, sentMessageId }` with description of the `progress` array

2. **Subject hierarchy dispatch line** — Add `; server auto-expires after 30 min` to the dispatch inbox description

3. **relay_list_endpoints note** — Add a new block before `</relay_tools>`:
   ```
   relay_list_endpoints → each endpoint includes: subject, type, expiresAt
     type: 'dispatch'|'query'|'persistent'|'agent'|'unknown'
     expiresAt: ISO expiry timestamp for dispatch endpoints; null for others
   ```

---

## Phase 7 — Verification

### Task 7.1 — Run full test suite

**Verification commands:**

```bash
# Phase 1+5 relay-tools unit tests:
pnpm vitest run apps/server/src/services/core/__tests__/

# Phase 2+4 relay package (TTL sweeper + CCA roundtrip):
pnpm vitest run packages/relay/src/__tests__/relay-cca-roundtrip.test.ts

# Full relay package:
pnpm vitest run packages/relay/src/__tests__/

# Full suite:
pnpm test -- --run
```

Common failure points to check:
- `inferEndpointType` not exported from `packages/relay/src/index.ts`
- `getDispatchInboxTtlMs()` missing from `RelayCore` public API
- Fake timers leaking between tests (ensure `vi.useRealTimers()` after TTL test)
- Old `expect(receivedPayloads).toHaveLength(1)` assertion still in test file (task 4.2)

---

## Dependency Graph

```
1.1 ──┬──► 1.2 ──► 2.1 ──┬──► 2.2
      │                   │
      │                   └──► 4.1 ──► 4.2
      │                   │
      └──► 3.1 ──► 3.2    └──► 5.1
      │                             │
      └──────────────────────────────┴──► 6.1 ──► 7.1
```

Tasks 3.1 and 5.1 can run in parallel once 1.1 and 2.1 are complete.
