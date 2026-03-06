---
slug: relay-inbox-lifecycle
number: 92
title: Relay Inbox Lifecycle — Endpoint Types, Dispatch TTL, relay_query Streaming
created: 2026-03-05
status: ideation
---

# Relay Inbox Lifecycle — Endpoint Types, Dispatch TTL, relay_query Streaming

**Slug:** relay-inbox-lifecycle
**Author:** Claude Code
**Date:** 2026-03-05
**Branch:** preflight/relay-inbox-lifecycle

---

## 1) Intent & Assumptions

- **Task brief:** Implement the three items explicitly deferred from spec #91 (relay-async-query):
  (1) endpoint type metadata field in `relay_list_endpoints` output to distinguish dispatch vs persistent inboxes;
  (2) server-side TTL for dispatch inboxes that auto-expires them after 30 min if the caller never calls `relay_unregister_endpoint`;
  (3) relay_query in-process aggregation of streaming progress events so 5–10 min tasks get intermediate visibility while still resolving with a single MCP tool response.
- **Assumptions:**
  - Spec #91 is implemented (relay_dispatch, relay_unregister_endpoint, CCA progress streaming for dispatch inboxes all exist)
  - CCA publishes `{ type: 'agent_result', done: true }` as the final message to all inbox replyTos (per spec #91 design)
  - The relay_query timeout raise to 600 s is also already implemented (spec #91 phase 1)
  - MCP tool handlers must return a single `CallToolResult` (array of content blocks) — they cannot stream individual messages
- **Out of scope:**
  - Changing dispatch inbox persistence to survive server restarts
  - Any new relay transport patterns or new tools beyond type/TTL/streaming enhancements
  - Push-based notification ("interrupt") to a waiting relay_query caller
  - Changing relay_query to use relay_dispatch internally

---

## 2) Pre-reading Log

- `packages/relay/src/relay-core.ts` — Main orchestrator. Exports `RelayCore`. Has `DEFAULT_TTL_MS = 3_600_000` (1 hour) for message envelopes. No endpoint-level TTL. `listEndpoints()` delegates to `EndpointRegistry`. `startTtlSweeper()` / `stopTtlSweeper()` do not yet exist.
- `packages/relay/src/types.ts` — `EndpointInfo` interface: `{ subject, hash, maildirPath, registeredAt }`. No `type` field.
- `packages/relay/src/endpoint-registry.ts` — In-memory `Map<subject, EndpointInfo>`. `registerEndpoint` creates Maildir + adds to map. `unregisterEndpoint` removes from map + deletes Maildir (`rm -r`). Returns `false` gracefully if endpoint not found (critical for TTL sweeper race handling).
- `apps/server/src/services/core/mcp-tools/relay-tools.ts` — `relay_list_endpoints` (line ~86) returns `EndpointInfo[]` as-is. `relay_query` (line ~159) uses EventEmitter subscribe + Promise; resolves on the **first message** via `cleanup(); resolve(...)` inside the subscriber.
- `packages/relay/src/adapters/claude-code-adapter.ts` — `handleAgentMessage()` distinguishes dispatch (`relay.inbox.dispatch.*`) from query (`relay.inbox.query.*`) by subject prefix regex. Dispatch path publishes progress events + final `agent_result`. Query path publishes single aggregated `agent_result` only.
- `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts` — Integration test asserts that `relay.inbox.query.*` replyTo receives **one** message only (backward-compat guard from spec #91).
- `packages/shared/src/relay-schemas.ts` — Defines `RelayProgressPayloadSchema` and `RelayAgentResultPayloadSchema` (added by spec #91).

---

## 3) Codebase Map

**Primary Files:**
- `packages/relay/src/relay-core.ts` — Add TTL sweeper (`startTtlSweeper`, `stopTtlSweeper`), integrate into `start()`/`stop()`
- `packages/relay/src/types.ts` — No change required (type derived from subject, not stored)
- `packages/relay/src/endpoint-registry.ts` — No change required (existing `unregisterEndpoint` handles race correctly)
- `apps/server/src/services/core/mcp-tools/relay-tools.ts` — (1) `relay_list_endpoints` enriched with `type` field; (2) `relay_query` subscribe logic changed from resolve-on-first to resolve-on-done:true with progress accumulation
- `packages/relay/src/adapters/claude-code-adapter.ts` — Extend progress streaming from dispatch-only to all `relay.inbox.*` replyTos (enables relay_query to actually receive progress events)
- `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts` — Update backward-compat test; add new tests for relay_query aggregation
- `packages/shared/src/relay-schemas.ts` — Add `EndpointTypeSchema` for OpenAPI docs (optional, additive)

**Shared Dependencies:**
- `packages/relay/src/types.ts` — EndpointInfo type (read-only for this spec)
- `packages/relay/src/relay-core.ts` — Exported `RelayCore` (primary extension point)
- Subject prefix conventions (`relay.inbox.dispatch.*`, `relay.inbox.query.*`, `relay.inbox.*`, `relay.agent.*`)

**Data Flow:**
- TTL: `RelayCore.startTtlSweeper()` → every 5 min → iterate `EndpointRegistry.listEndpoints()` → infer type from subject → if `dispatch` && age > 30 min → `RelayCore.unregisterEndpoint(subject)`
- Endpoint type: `relay_list_endpoints` → `EndpointRegistry.listEndpoints()` → for each, call `inferEndpointType(subject)` → append `type` to response
- relay_query streaming: `relay_query` handler → subscribe to inbox → per-message: if `type === 'progress' && done === false` → push to `progressEvents[]` → else → `cleanup(); resolve({ payload, progress: progressEvents, from, id })`; CCA: extend progress publishing to all `relay.inbox.*` (not just `relay.inbox.dispatch.*`)

**Potential Blast Radius:**
- Direct: 5 files (relay-core, relay-tools, claude-code-adapter, relay-schemas, relay-cca-roundtrip.test)
- Indirect: relay-tools type declarations, context-builder.ts (RELAY_TOOLS_CONTEXT update for relay_query response shape)
- Tests: relay-cca-roundtrip.test.ts (update 1 existing test, add 2 new), mcp-tool-server.test.ts (no count change), tool-filter.test.ts (no change)

---

## 4) Root Cause Analysis

*Not a bug fix — N/A*

---

## 5) Research

**Feature 1: Endpoint Type Metadata**

The exploration agent confirmed `EndpointInfo` has no `type` field today. CCA already uses subject prefix matching (`startsWith('relay.inbox.dispatch.')`) as the canonical discriminator throughout the codebase. Adding an explicit stored type would require schema migration and registration changes. Deriving from subject prefix is:
- Zero schema change
- Consistent with how CCA already distinguishes inboxes
- Cannot be "wrong" since the naming convention is the source of truth

Type derivation function (shared utility):
```typescript
export type EndpointType = 'dispatch' | 'query' | 'persistent' | 'agent' | 'unknown';

export function inferEndpointType(subject: string): EndpointType {
  if (subject.startsWith('relay.inbox.dispatch.')) return 'dispatch';
  if (subject.startsWith('relay.inbox.query.'))    return 'query';
  if (subject.startsWith('relay.inbox.'))           return 'persistent';
  if (subject.startsWith('relay.agent.'))           return 'agent';
  return 'unknown';
}
```

This utility lives in `packages/relay/src/types.ts` (or a new `packages/relay/src/utils.ts`) and is reused by both relay_list_endpoints and the TTL sweeper.

**Feature 2: Server-Side TTL**

Options compared:
- **Periodic sweeper (setInterval)**: One timer for all endpoints. Runs every 5 min. Imprecision: ±5 min on a 30-min TTL (17% max drift) — acceptable. No accumulation of timer handles. `EndpointRegistry.unregisterEndpoint()` already returns `false` gracefully for already-removed endpoints, so the race with explicit caller cleanup is handled.
- **Timer-per-resource**: Precise expiry but creates one setTimeout handle per dispatch inbox. If an agent creates 50 inboxes rapidly, 50 timers are pending. Harder to cancel on `stopTtlSweeper()`.
- **Lazy cleanup on listEndpoints**: Zero overhead but expired inboxes accumulate on disk between list calls. Unpredictable cleanup timing.

**Recommendation: Periodic sweeper.** Default TTL: 30 min. Sweeper interval: 5 min. Both configurable as `RelayCore` constructor params (with defaults). Implementation:

```typescript
private ttlSweepInterval?: ReturnType<typeof setInterval>;
private readonly dispatchInboxTtlMs: number;
private readonly ttlSweepIntervalMs: number;

startTtlSweeper(): void {
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
  this.ttlSweepInterval.unref(); // Don't prevent process exit
}

stopTtlSweeper(): void {
  if (this.ttlSweepInterval) clearInterval(this.ttlSweepInterval);
}
```

`startTtlSweeper()` is called in `RelayCore.start()`, `stopTtlSweeper()` in `RelayCore.stop()`.

**Feature 3: relay_query In-Process Aggregation**

MCP tool handlers must return a single `CallToolResult` — they cannot stream. Therefore relay_query cannot yield individual events. The right pattern: internally collect events and return a batch.

The two-part change:
1. **relay_query subscribe logic**: change from resolve-on-first to resolve-on-done:true:
   - If `payload.type === 'progress' && payload.done === false` → push to `progressEvents[]`, return without resolving
   - Otherwise (agent_result with `done: true`, or any non-progress message for backward compat) → `cleanup(); resolve({ payload, progress: progressEvents, from, id })`

2. **CCA broadens streaming**: extend `publishDispatchProgress` calls to all `relay.inbox.*` replyTos, not just `relay.inbox.dispatch.*`. This requires changing the condition from `isDispatchInbox` to `isAnyInbox` (i.e., `envelope.replyTo?.startsWith('relay.inbox.')`).

The CCA change makes `relay.inbox.query.*` also receive progress events before the final `agent_result`. The spec #91 backward-compat integration test ("still publishes single agent_result for relay.inbox.query.* replyTo") must be updated: query inboxes will now receive progress events + final agent_result (matching dispatch inbox behavior). The relay_query caller still gets a single MCP tool response, just now with a populated `progress` array.

Updated relay_query response shape:
```typescript
{
  reply: unknown;           // the final agent_result payload
  progress: Array<{         // NEW: empty for non-CCA agents, populated for CCA
    step: number;
    step_type: 'message' | 'tool_result';
    text: string;
    done: false;
  }>;
  from: string;
  replyMessageId: string;
  sentMessageId: string;
}
```

Backward compatibility: existing callers that only destructure `reply`, `from`, and `replyMessageId` are unaffected. `progress` is a new additive field.

---

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | relay_query streaming approach | In-process aggregation | MCP tools cannot stream; internally collecting progress events and returning them as a `progress[]` array on the single response is backward-compatible and delivers the 5-10 min visibility goal. |
| 2 | TTL implementation pattern | Periodic sweeper (setInterval, 5 min interval) | Single timer for all endpoints; no handle accumulation; ±5 min imprecision is acceptable for a 30-min TTL; `EndpointRegistry.unregisterEndpoint()` already handles the race with explicit caller cleanup. |
| 3 | Endpoint type determination | Derive from subject prefix at list time | CCA already uses the same prefix-matching logic. Zero schema change. Subject naming is the canonical discriminator already. |
| 4 | Dispatch inbox TTL default | 30 minutes | Sufficient for typical long-running agent workflows; keeps disk usage bounded; agents that need longer already have the relay_dispatch+polling pattern and will keep the inbox alive via activity. |

---

## 7) Detailed Technical Design

### Phase 1: Endpoint Type in relay_list_endpoints

**Add utility function** to `packages/relay/src/types.ts`:
```typescript
export type EndpointType = 'dispatch' | 'query' | 'persistent' | 'agent' | 'unknown';

export function inferEndpointType(subject: string): EndpointType {
  if (subject.startsWith('relay.inbox.dispatch.')) return 'dispatch';
  if (subject.startsWith('relay.inbox.query.'))    return 'query';
  if (subject.startsWith('relay.inbox.'))           return 'persistent';
  if (subject.startsWith('relay.agent.'))           return 'agent';
  return 'unknown';
}
```

**Update `relay_list_endpoints`** in `relay-tools.ts`:
```typescript
// Before:
return jsonContent({ endpoints, count: endpoints.length });

// After:
const typed = endpoints.map((ep) => ({ ...ep, type: inferEndpointType(ep.subject) }));
return jsonContent({ endpoints: typed, count: typed.length });
```

**Update tool description** to mention the `type` field and its values.

### Phase 2: Server-Side TTL Sweeper

**Add to `RelayCore` constructor** (with defaults):
```typescript
constructor(
  private readonly opts: RelayOptions & {
    dispatchInboxTtlMs?: number;   // default: 30 * 60 * 1000
    ttlSweepIntervalMs?: number;   // default: 5 * 60 * 1000
  }
)
```

**Add sweeper methods** (shown in Research section above).

**Call in lifecycle**:
```typescript
async start(): Promise<void> {
  // ... existing start logic ...
  this.startTtlSweeper();
}

async stop(): Promise<void> {
  this.stopTtlSweeper();
  // ... existing stop logic ...
}
```

**Add TTL field to relay_list_endpoints response** for transparency:
```typescript
const typed = endpoints.map((ep) => ({
  ...ep,
  type: inferEndpointType(ep.subject),
  expiresAt: ep.type === 'dispatch'
    ? new Date(new Date(ep.registeredAt).getTime() + dispatchInboxTtlMs).toISOString()
    : null,
}));
```

### Phase 3: relay_query In-Process Aggregation

**Update subscribe handler** in `relay-tools.ts`:
```typescript
const progressEvents: RelayProgressPayload[] = [];

const unsub = relay.subscribe(inboxSubject, (envelope) => {
  const payload = envelope.payload as Record<string, unknown>;

  // Accumulate progress events (type:progress, done:false)
  if (payload?.type === 'progress' && payload?.done === false) {
    progressEvents.push(payload as RelayProgressPayload);
    return;
  }

  // Resolve on any final message (agent_result with done:true, or plain message for non-CCA compat)
  cleanup();
  resolve({ payload, progress: progressEvents, from: envelope.from, id: envelope.id });
});
```

**Update return shape**:
```typescript
return jsonContent({
  reply: reply.payload,
  progress: reply.progress ?? [],
  from: reply.from,
  replyMessageId: reply.id,
  sentMessageId: result.messageId,
});
```

**Update tool description** to mention `progress` array field.

### Phase 4: CCA Broadens Streaming

In `claude-code-adapter.ts`, extend dispatch progress publishing from `relay.inbox.dispatch.*` to all `relay.inbox.*`. The `isDispatchInbox` flag is renamed to `isInboxReplyTo` (or: the dispatch streaming block is triggered for all inbox subjects):

```typescript
// Before:
const isDispatchInbox = envelope.replyTo?.startsWith('relay.inbox.dispatch.');
const isQueryInbox = envelope.replyTo?.startsWith('relay.inbox.') && !isDispatchInbox;

// After:
const isInboxReplyTo = envelope.replyTo?.startsWith('relay.inbox.');
// All relay.inbox.* subjects get progress streaming + final agent_result
// relay.agent.* and relay.human.* subjects get raw event streaming (unchanged)
```

The query inbox single-message test in `relay-cca-roundtrip.test.ts` is updated: query inboxes now receive progress events + final agent_result (same as dispatch). Add a new test: `relay_query still resolves with correct reply and populated progress array`.

### Phase 5: context-builder.ts Update

Update `RELAY_TOOLS_CONTEXT` to document:
1. `relay_list_endpoints` now returns `type` and `expiresAt` per endpoint
2. `relay_query` now returns a `progress` array in addition to `reply`
3. Dispatch inboxes auto-expire after 30 min (explicit cleanup with `relay_unregister_endpoint` is still recommended when done:true is received)

---

## 8) Testing Strategy

### Unit Tests

**relay-tools.test.ts** (new or extend existing):
- `relay_list_endpoints` returns `type` field for each endpoint
- `relay_query` accumulates progress events and returns them in `progress` array
- `relay_query` resolves on non-progress message (backward compat for non-CCA agents)

### Integration Tests

**relay-cca-roundtrip.test.ts** (update + add):
- Update: "still publishes single agent_result for relay.inbox.query.* replyTo" → update to verify progress events ARE now published to query inboxes, then final agent_result
- Add: "relay_query returns populated progress array when CCA streams progress"
- Add: "TTL sweeper unregisters dispatch inboxes after configured TTL" (timer mock)

### No New Test Files Required

All new tests fit in existing test files.

---

## 9) Implementation Phases

**Phase 1** — Endpoint type metadata (1-2 files): `types.ts` + `relay-tools.ts`
**Verification**: `pnpm vitest run apps/server/src/services/core/__tests__/`

**Phase 2** — TTL sweeper (1 file): `relay-core.ts`
**Verification**: `pnpm vitest run packages/relay/src/__tests__/`

**Phase 3** — relay_query aggregation (1 file): `relay-tools.ts`
**Phase 4** — CCA broadens streaming (1 file): `claude-code-adapter.ts` + test update
**Verification**: `pnpm vitest run packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`

**Phase 5** — context-builder docs (1 file): `context-builder.ts`
**Verification**: `pnpm test -- --run`
