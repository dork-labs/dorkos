# relay-async-query — Implementation Task Breakdown

Spec: `specs/relay-async-query/02-specification.md`
Generated: 2026-03-05

---

## Summary

6 tasks across 3 phases. All phases must complete in order; within Phase 1, tasks 1.1 and 1.2 are independent and can be done in parallel.

| ID  | Phase | Subject                                          | Size   | Priority |
|-----|-------|--------------------------------------------------|--------|----------|
| 1.1 | 1     | Add progress payload schemas to relay-schemas.ts | small  | high     |
| 1.2 | 1     | Add relay_dispatch and relay_unregister_endpoint | medium | high     |
| 1.3 | 1     | Export handlers and update RELAY_TOOLS constant  | small  | high     |
| 1.4 | 1     | Update mcp-tool-server and tool-filter tests     | medium | high     |
| 2.1 | 2     | Refactor CCA handleAgentMessage for streaming    | large  | high     |
| 2.2 | 2     | Add CCA dispatch streaming integration tests     | medium | high     |
| 3.1 | 3     | Update RELAY_TOOLS_CONTEXT in context-builder.ts | small  | medium   |

---

## Phase 1 — Foundation

### Task 1.1 — Add RelayProgressPayload and RelayAgentResultPayload schemas

**File:** `packages/shared/src/relay-schemas.ts`
**Depends on:** nothing
**Parallel with:** 1.2

Add two new Zod schemas for the dispatch progress protocol. These define the wire format for CCA-to-dispatch-inbox messages.

```typescript
/** Published by CCA to relay.inbox.dispatch.* on each progress event. */
export const RelayProgressPayloadSchema = z
  .object({
    type: z.literal('progress'),
    step: z.number().int().min(1).describe('Monotonically increasing step counter'),
    step_type: z.enum(['message', 'tool_result']).describe(
      'message = assistant text block completed; tool_result = tool execution completed'
    ),
    text: z.string().describe('Text content of this progress step'),
    done: z.literal(false),
  })
  .openapi('RelayProgressPayload');

export type RelayProgressPayload = z.infer<typeof RelayProgressPayloadSchema>;

/**
 * Published by CCA to relay.inbox.dispatch.* as the final event.
 * Also published to relay.inbox.query.* (existing behavior, done field added).
 */
export const RelayAgentResultPayloadSchema = z
  .object({
    type: z.literal('agent_result'),
    text: z.string().describe('Full collected response text from the agent session'),
    done: z.literal(true),
  })
  .openapi('RelayAgentResultPayload');

export type RelayAgentResultPayload = z.infer<typeof RelayAgentResultPayloadSchema>;
```

Backward compatibility note: The `done: true` field added to `RelayAgentResultPayloadSchema` is additive. Existing consumers checking `payload.type === 'agent_result'` continue to work. The `done` field will be `undefined` on messages published before this change.

---

### Task 1.2 — Add relay_dispatch and relay_unregister_endpoint tools

**File:** `apps/server/src/services/core/mcp-tools/relay-tools.ts`
**Depends on:** nothing (no dependency on 1.1 at this stage)
**Parallel with:** 1.1

**1. Add `createRelayDispatchHandler` export:**

```typescript
export function createRelayDispatchHandler(deps: McpToolDeps) {
  return async (args: {
    to_subject: string;
    payload: unknown;
    from: string;
    budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
  }) => {
    const err = requireRelay(deps);
    if (err) return err;

    const relay = deps.relayCore!;
    const inboxSubject = `relay.inbox.dispatch.${randomUUID()}`;

    try {
      await relay.registerEndpoint(inboxSubject);
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Registration failed';
      return jsonContent({ error: message, code: 'REGISTRATION_FAILED' }, true);
    }

    try {
      const result = await relay.publish(args.to_subject, args.payload, {
        from: args.from,
        replyTo: inboxSubject,
        budget: args.budget,
      });

      if (result.deliveredTo === 0 && result.rejected && result.rejected.length > 0) {
        const reason = result.rejected[0]?.reason ?? 'unknown';
        await relay.unregisterEndpoint(inboxSubject).catch(() => undefined);
        return jsonContent(
          { error: `Message rejected: ${reason}`, code: 'REJECTED', rejected: result.rejected },
          true
        );
      }

      return jsonContent({
        messageId: result.messageId,
        inboxSubject,
        note: `Poll relay_inbox("${inboxSubject}") for progress. Call relay_unregister_endpoint("${inboxSubject}") when done:true is received.`,
      });
    } catch (e) {
      await relay.unregisterEndpoint(inboxSubject).catch(() => undefined);
      const message = e instanceof Error ? e.message : 'Dispatch failed';
      const code = message.includes('Access denied')
        ? 'ACCESS_DENIED'
        : message.includes('Invalid subject')
          ? 'INVALID_SUBJECT'
          : 'DISPATCH_FAILED';
      return jsonContent({ error: message, code }, true);
    }
  };
}
```

**2. Add `createRelayUnregisterEndpointHandler` export:**

```typescript
/** Unregister a named Relay endpoint. */
export function createRelayUnregisterEndpointHandler(deps: McpToolDeps) {
  return async (args: { subject: string }) => {
    const err = requireRelay(deps);
    if (err) return err;
    try {
      const removed = await deps.relayCore!.unregisterEndpoint(args.subject);
      if (!removed) {
        return jsonContent({ error: `Endpoint not found: ${args.subject}`, code: 'ENDPOINT_NOT_FOUND' }, true);
      }
      return jsonContent({ success: true, subject: args.subject });
    } catch (e) {
      const message = e instanceof Error ? e.message : 'Unregistration failed';
      return jsonContent({ error: message, code: 'UNREGISTER_FAILED' }, true);
    }
  };
}
```

**3. Register both tools in `getRelayTools()`** — add after the `relay_query` entry:

```typescript
tool(
  'relay_dispatch',
  'Dispatch a message to an agent and return IMMEDIATELY with a dispatch inbox subject. ' +
  'Unlike relay_query (which blocks), relay_dispatch returns { messageId, inboxSubject } at once. ' +
  'Agent B runs asynchronously; CCA publishes incremental progress events and a final agent_result ' +
  'to the inbox. Poll relay_inbox(endpoint_subject=inboxSubject) for updates. ' +
  'When you receive a message with done:true, call relay_unregister_endpoint(inboxSubject) to clean up.',
  {
    to_subject: z.string().describe('Target subject (e.g., "relay.agent.{agentId}")'),
    payload: z.unknown().describe('Message payload'),
    from: z.string().describe('Sender subject identifier'),
    budget: z.object({
      maxHops: z.number().int().min(1).optional(),
      ttl: z.number().int().optional(),
      callBudgetRemaining: z.number().int().min(0).optional(),
    }).optional(),
  },
  createRelayDispatchHandler(deps)
),
tool(
  'relay_unregister_endpoint',
  'Unregister a Relay endpoint. Use to clean up dispatch inboxes after relay_dispatch completes (when done:true received).',
  {
    subject: z.string().describe('Subject of the endpoint to unregister'),
  },
  createRelayUnregisterEndpointHandler(deps)
),
```

**4. Raise relay_query timeout cap** in the `relay_query` tool schema:
- Change `.max(120000)` to `.max(600000)`
- Update description: `'Max milliseconds to wait for a reply (default: 60000, max: 600000). For tasks longer than 10 min, use relay_dispatch instead.'`

---

### Task 1.3 — Export handlers and update RELAY_TOOLS

**Files:**
- `apps/server/src/services/core/mcp-tools/index.ts`
- `apps/server/src/services/core/tool-filter.ts`

**Depends on:** 1.2

**index.ts:** Add the two new handlers to the relay-tools export line:
```typescript
export { createRelaySendHandler, createRelayInboxHandler, createRelayListEndpointsHandler, createRelayRegisterEndpointHandler, createRelayDispatchHandler, createRelayUnregisterEndpointHandler } from './relay-tools.js';
```

**tool-filter.ts:** Add two entries to `RELAY_TOOLS`:
```typescript
const RELAY_TOOLS = [
  'mcp__dorkos__relay_send',
  'mcp__dorkos__relay_inbox',
  'mcp__dorkos__relay_list_endpoints',
  'mcp__dorkos__relay_register_endpoint',
  'mcp__dorkos__relay_query',
  'mcp__dorkos__relay_dispatch',           // NEW
  'mcp__dorkos__relay_unregister_endpoint', // NEW
] as const;
```

No changes needed in `buildAllowedTools()` — it already pushes `...RELAY_TOOLS` when `config.relay` is true.

---

### Task 1.4 — Update mcp-tool-server and tool-filter tests

**Files:**
- `apps/server/src/services/core/__tests__/mcp-tool-server.test.ts`
- `apps/server/src/services/core/__tests__/tool-filter.test.ts`

**Depends on:** 1.2, 1.3

**mcp-tool-server.test.ts changes:**
1. Update tool count: `toHaveLength(14)` → `toHaveLength(16)`, comment `(4 core + 5 pulse + 5 relay)` → `(4 core + 5 pulse + 7 relay)`
2. Add to "registers tools with correct names": `expect(toolNames).toContain('relay_dispatch')` and `expect(toolNames).toContain('relay_unregister_endpoint')`
3. Import the two new handlers from `'../mcp-tools/index.js'`
4. Add `makeRelayCoreMock()` helper and full handler test suites for `createRelayDispatchHandler` and `createRelayUnregisterEndpointHandler` (RELAY_DISABLED, success path, auto-unregister on rejection, ENDPOINT_NOT_FOUND)

**tool-filter.test.ts changes:**
1. Add test: `relay_dispatch` and `relay_unregister_endpoint` included when `relay=true`
2. Add test: both excluded when `relay=false`
3. Update existing relay exclusion test to assert the new tools are also absent

Verification: `pnpm vitest run apps/server/src/services/core/__tests__/mcp-tool-server.test.ts apps/server/src/services/core/__tests__/tool-filter.test.ts`

---

## Phase 2 — CCA Streaming Progress

### Task 2.1 — Refactor ClaudeCodeAdapter.handleAgentMessage for dispatch streaming

**File:** `packages/relay/src/adapters/claude-code-adapter.ts`
**Depends on:** 1.1

This is the core behavioral change. Three parts: split the inbox type check, rewrite the event loop body, add the `publishDispatchProgress()` helper.

**Split the inbox check (replace the existing `isInboxReplyTo` line):**
```typescript
const isDispatchInbox = envelope.replyTo?.startsWith('relay.inbox.dispatch.');
// Non-dispatch inbox replyTo (relay.inbox.query.* etc.) → existing aggregated behavior
const isQueryInbox = envelope.replyTo?.startsWith('relay.inbox.') && !isDispatchInbox;
```

**Add buffer vars before the `for await` loop:**
```typescript
let stepCounter = 0;
let messageBuffer = '';
```

**New event loop body:**
```typescript
for await (const event of eventStream) {
  if (controller.signal.aborted) break;
  eventCount++;

  if (envelope.replyTo && this.relay) {
    if (isDispatchInbox) {
      if (event.type === 'text_delta') {
        const data = event.data as { text: string };
        messageBuffer += data.text;
        collectedText += data.text;
      }
      if (event.type === 'tool_call_start' && messageBuffer) {
        stepCounter++;
        await this.publishDispatchProgress(envelope, stepCounter, 'message', messageBuffer, ccaSessionKey);
        messageBuffer = '';
      }
      if (event.type === 'tool_result') {
        stepCounter++;
        const data = event.data as { content?: string; tool_use_id?: string };
        const text = typeof data.content === 'string' ? data.content : JSON.stringify(data);
        await this.publishDispatchProgress(envelope, stepCounter, 'tool_result', text, ccaSessionKey);
      }
    } else if (isQueryInbox) {
      if (event.type === 'text_delta') {
        const data = event.data as { text: string };
        collectedText += data.text;
      }
    } else {
      await this.publishResponse(envelope, event, ccaSessionKey);
    }
  }
}
```

**New post-loop publish logic (replaces existing `if (isInboxReplyTo ...)` block):**
```typescript
if (isDispatchInbox && envelope.replyTo && this.relay) {
  if (messageBuffer) {
    stepCounter++;
    await this.publishDispatchProgress(envelope, stepCounter, 'message', messageBuffer, ccaSessionKey);
  }
  await this.publishAgentResult(envelope, collectedText, ccaSessionKey);
}

if (isQueryInbox && envelope.replyTo && this.relay && collectedText) {
  await this.publishAgentResult(envelope, collectedText, ccaSessionKey);
}
```

**New private helper after `publishAgentResult()`:**
```typescript
private async publishDispatchProgress(
  originalEnvelope: RelayEnvelope,
  step: number,
  step_type: 'message' | 'tool_result',
  text: string,
  fromId: string,
): Promise<void> {
  if (!this.relay || !originalEnvelope.replyTo) return;
  const opts: PublishOptions = {
    from: `agent:${fromId}`,
    budget: { hopCount: originalEnvelope.budget.hopCount + 1 },
  };
  await this.relay.publish(
    originalEnvelope.replyTo,
    { type: 'progress', step, step_type, text, done: false },
    opts,
  );
}
```

**Update `publishAgentResult()` payload** — add `done: true`:
```typescript
await this.relay.publish(originalEnvelope.replyTo, { type: 'agent_result', text, done: true }, opts);
```

---

### Task 2.2 — Add CCA dispatch streaming integration tests

**File:** `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`
**Depends on:** 2.1

Add three new tests inside the existing `describe('relay → CCA round-trip', ...)` suite:

**Test 1 — Dispatch inbox receives progress + final agent_result:**
Publishes to a `relay.agent.*` subject with `replyTo: 'relay.inbox.dispatch.test-uuid'`. Mocks `agentManager.sendMessage` to yield text_delta → tool_call_start → tool_result → text_delta → done. Asserts: received payloads include `type: 'progress'` events with `done: false`, last payload is `type: 'agent_result'` with `done: true`.

**Test 2 — Query inbox backward compatibility:**
Publishes with `replyTo: 'relay.inbox.query.existing-test'`. Mocks sendMessage to yield text_delta → done. Asserts: exactly 1 message received, it is `type: 'agent_result'`, no `type: 'progress'` messages.

**Test 3 — step_type discriminator:**
Publishes with dispatch inbox replyTo. Mocks sendMessage to yield text_delta → tool_call_start → tool_result → done. Asserts: progress events with `step_type === 'message'` exist and progress events with `step_type === 'tool_result'` exist.

Verification: `pnpm vitest run packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`

---

## Phase 3 — Documentation

### Task 3.1 — Update RELAY_TOOLS_CONTEXT in context-builder.ts

**File:** `apps/server/src/services/core/context-builder.ts`
**Depends on:** 2.2 (run after all code changes are verified to avoid doc/code drift)

Replace the `RELAY_TOOLS_CONTEXT` constant's string value entirely. Key changes:

- Subject hierarchy: add `relay.inbox.query.{UUID}` and `relay.inbox.dispatch.{UUID}` entries
- Rename "Query another agent" workflow to "SHORT tasks (≤10 min, PREFERRED)" and update `timeout_ms` to 600000
- Add "Dispatch to another agent — LONG tasks (>10 min)" workflow with fire-and-poll steps
- Add `CONSTRAINT — Subagent MCP tools` warning section documenting the SDK architectural limitation (Anthropic #13898, #14496, #5465) with WRONG vs RIGHT orchestrator pattern examples
- Update error codes list to include `REJECTED`, `DISPATCH_FAILED`, `UNREGISTER_FAILED`
- Update IMPORTANT note to include `relay_dispatch` in the list of tools for initiating new messages

New RELAY_TOOLS_CONTEXT:
```
<relay_tools>
DorkOS Relay is a pub/sub message bus for inter-agent communication.

Subject hierarchy:
  relay.agent.{agentId}                — activate a specific agent session
  relay.inbox.query.{UUID}             — ephemeral inbox for relay_query (auto-managed)
  relay.inbox.dispatch.{UUID}          — ephemeral inbox for relay_dispatch (caller-managed)
  relay.inbox.{agentId}                — persistent agent reply inbox
  relay.human.console.{clientId}       — reach a human in the DorkOS UI
  relay.system.console                 — system broadcast channel
  relay.system.pulse.{scheduleId}      — Pulse scheduler events

Workflow: Query another agent — SHORT tasks (≤10 min, PREFERRED)
1. mesh_list() to find available agents and their agent IDs
2. relay_query(to_subject="relay.agent.{theirAgentId}", payload={task}, from={myAgentId}, timeout_ms=600000)
   → Blocks until reply (max 10 min / 600 000 ms)
   → Returns: { reply, from, replyMessageId, sentMessageId }

Workflow: Dispatch to another agent — LONG tasks (>10 min)
1. relay_dispatch(to_subject="relay.agent.{theirAgentId}", payload={task}, from={myAgentId})
   → Returns IMMEDIATELY: { messageId, inboxSubject: "relay.inbox.dispatch.{UUID}" }
2. Poll: relay_inbox(endpoint_subject=inboxSubject, status="unread")
   → Returns progress events: { type: "progress", step, step_type: "message"|"tool_result", text, done: false }
   → Returns final result: { type: "agent_result", text, done: true }
3. When done:true received: relay_unregister_endpoint(subject=inboxSubject)

Workflow: Fire-and-forget (no reply needed)
1. relay_send(subject="relay.agent.{theirAgentId}", payload={task}, from={myAgentId})

Workflow: Manual poll (fallback)
1. relay_register_endpoint(subject="relay.inbox.{myAgentId}")
2. relay_send(subject="relay.agent.{theirAgentId}", payload={task}, from={myAgentId}, replyTo="relay.inbox.{myAgentId}")
3. relay_inbox(endpoint_subject="relay.inbox.{myAgentId}")

CONSTRAINT — Subagent MCP tools: DorkOS MCP tools (relay_*, mesh_*, pulse_*) are NOT available
inside Claude Code Task() subagents. This is an SDK architectural limitation (subprocesses do not
inherit the parent MCP server). The orchestrator pattern workaround:
  WRONG:  Task("use relay_send to message agent B")   ← tools unavailable, silent failure
  RIGHT:  1. Call relay_dispatch() in this (parent) session
          2. Pass the inboxSubject into the Task() prompt if needed
          3. Poll relay_inbox() in this session after Task() returns

IMPORTANT: When YOU receive a relay message, respond naturally — do NOT call relay_send.
Your response is automatically forwarded by the relay system.
Only call relay_send/relay_query/relay_dispatch to INITIATE a new message.

Error codes: RELAY_DISABLED, ACCESS_DENIED, INVALID_SUBJECT, ENDPOINT_NOT_FOUND,
             TIMEOUT, QUERY_FAILED, REJECTED, DISPATCH_FAILED, UNREGISTER_FAILED
</relay_tools>
```

Verification: `pnpm test -- --run`

---

## Dependency Graph

```
1.1 ──────────────────────────────────────────── 2.1
1.2 ──► 1.3 ──► 1.4                              │
                                                  ▼
                                            2.2 ──► 3.1
```

- 1.1 and 1.2 can proceed in parallel
- 1.3 depends on 1.2 (needs the exported handlers)
- 1.4 depends on 1.2 and 1.3 (imports from barrel)
- 2.1 depends on 1.1 (uses the schema types; Phase 1 tools should be done first)
- 2.2 depends on 2.1 (tests the CCA changes)
- 3.1 depends on 2.2 (documentation after code is verified)

## Key Invariants

- `relay_query` behavior is unchanged — query inboxes (`relay.inbox.query.*`) still receive exactly one `agent_result` message
- `publishAgentResult()` now always sends `done: true` — additive, not breaking
- Both new tools are feature-gated behind `DORKOS_RELAY_ENABLED` (via `requireRelay()` guard)
- Dispatch inbox subjects use `randomUUID()` — cryptographically secure, cannot be guessed
- Auto-unregister on early rejection prevents inbox leaks
- Tool count moves from 14 to 16 (4 core + 5 pulse + 7 relay)
