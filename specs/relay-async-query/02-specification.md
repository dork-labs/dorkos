---
slug: relay-async-query
number: 90
title: Relay Async Dispatch + CCA Streaming Progress
status: Draft
created: 2026-03-05
authors:
  - Claude Code
---

# Relay Async Dispatch + CCA Streaming Progress

## Status

Draft

## Authors

Claude Code — 2026-03-05

---

## Overview

Add `relay_dispatch` (fire-and-poll async dispatch) and `relay_unregister_endpoint` (explicit inbox cleanup) as two new relay MCP tools. Simultaneously raise the `relay_query` timeout cap from 120 s to 600 s, stream incremental progress updates from ClaudeCodeAdapter to dispatch inboxes during agent sessions, and update `context-builder.ts` documentation with the new workflows and the subagent MCP constraint warning.

---

## Background / Problem Statement

The relay system today offers two agent-to-agent patterns:

1. **relay_send** — fire-and-forget, no reply
2. **relay_query** — synchronous request/reply with a hard 120 s timeout

Neither works for tasks where Agent B requires 20+ minutes: `relay_query` silently times out, and `relay_send` gives Agent A no visibility into the outcome. Three gaps compound:

1. No non-blocking dispatch mechanism that returns a job token immediately
2. No progress visibility while Agent B runs
3. Even raising `relay_query`'s timeout still makes Agent A block synchronously for many minutes — a poor agent pattern

Additionally, there is no `relay_unregister_endpoint` tool, meaning any dispatch inbox created by agents can never be explicitly cleaned up from within a session.

A secondary documentation gap: agents that attempt to call relay or mesh tools inside a Claude Code `Task()` subagent silently fail because the MCP tool server is not inherited by SDK subprocesses. This is an SDK-level architectural limitation (Anthropic issues #13898, #14496, #5465) that must be documented to prevent wasted debug time.

---

## Goals

- Add `relay_dispatch` tool that returns `{ messageId, inboxSubject }` immediately without blocking on Agent B's response
- Add `relay_unregister_endpoint` tool that allows callers to explicitly clean up named endpoints
- Raise `relay_query` timeout from 120 s to 600 s (10 min) for medium-duration tasks
- Stream incremental progress from CCA to `relay.inbox.dispatch.*` subjects (per AssistantMessage text completion and per tool_result event)
- Publish a final `agent_result` with `done: true` after Agent B's session ends
- Update `RELAY_TOOLS_CONTEXT` in `context-builder.ts` to document relay_dispatch workflow, updated relay_query timeout, and subagent MCP constraint with orchestrator workaround
- Maintain full backward compatibility with existing relay_query, relay_send, and relay_inbox behavior
- Update tool count test (14 → 16) and tool-filter tests for the two new tools

---

## Non-Goals

- Making DorkOS MCP tools available inside SDK subagents (SDK architectural limitation — Anthropic #13898, #14496, #5465; tracked upstream, not DorkOS-fixable)
- Push-based notification to Agent A's session ("interrupt" mechanism doesn't exist in the current relay model)
- Persisting in-flight dispatch jobs across server restarts
- Streaming individual text deltas to dispatch inboxes (too granular; progress per text-completion or tool_result is sufficient)
- Server-side TTL for dispatch inboxes (deferred to a future pass — caller-initiated cleanup only)
- Adding a `type` metadata field to endpoint entries in `relay_list_endpoints` (deferred to a future pass)
- Changing relay_query to deliver streaming progress to its ephemeral query inbox (relay_query inbox uses single-message aggregation; its EventEmitter subscribe pattern resolves on the first message)

---

## Technical Dependencies

- **`@anthropic-ai/claude-agent-sdk`** — `tool()` factory for MCP tool registration
- **`zod`** — schema validation for tool arguments
- **`packages/relay/src/relay-core.ts`** — `RelayCore.unregisterEndpoint(subject)` already exists (line 499); used by relay_query's finally block; no new RelayCore API required
- **`packages/relay/src/relay-core.ts`** — `RelayCore.registerEndpoint()` and `RelayCore.publish()` already exist; relay_dispatch uses both
- **`packages/relay/src/types.ts`** — `RelayPublisher` interface

No new external library dependencies.

---

## Detailed Design

### 1. New Shared Types (`packages/shared/src/relay-schemas.ts`)

Add two new payload schemas for the dispatch progress protocol:

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

> **Note:** The existing `publishAgentResult()` already publishes `{ type: 'agent_result', text }` without a `done` field. Adding `done: true` to the schema is additive and does not break existing consumers — the `done` field is new and will be `undefined` on messages published before this spec. Callers must check `payload.done === true` or `payload.type === 'agent_result'` for backward compatibility.

### 2. New MCP Tool: `relay_dispatch` (`apps/server/src/services/core/mcp-tools/relay-tools.ts`)

```typescript
/**
 * Dispatch a message to an agent asynchronously.
 *
 * Unlike relay_query, relay_dispatch returns immediately with a dispatch inbox
 * subject. Agent A can then poll relay_inbox() for progress events and the
 * final agent_result. Call relay_unregister_endpoint() to clean up when done.
 *
 * Early rejection (deliveredTo=0 && rejected.length>0): auto-unregisters inbox,
 * returns { error, code: 'REJECTED', rejected }.
 */
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

      // Early rejection: auto-unregister the inbox to prevent leaks
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
      // Clean up inbox on publish error
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

**Tool registration in `getRelayTools(deps)`:**

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
)
```

### 3. New MCP Tool: `relay_unregister_endpoint` (`apps/server/src/services/core/mcp-tools/relay-tools.ts`)

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

**Tool registration:**

```typescript
tool(
  'relay_unregister_endpoint',
  'Unregister a Relay endpoint. Use to clean up dispatch inboxes after relay_dispatch completes (when done:true received).',
  {
    subject: z.string().describe('Subject of the endpoint to unregister'),
  },
  createRelayUnregisterEndpointHandler(deps)
)
```

### 4. relay_query Timeout Raise (`relay-tools.ts`, line ~265)

Change:
```typescript
.max(120000)
```
To:
```typescript
.max(600000)
```

Also update the tool description to reflect the new maximum and mention relay_dispatch for tasks longer than 10 minutes.

### 5. tool-filter.ts: Add New Tools to RELAY_TOOLS

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

### 6. mcp-tools/index.ts: Export New Handlers

Add to the export line for relay-tools handlers:
```typescript
export { ..., createRelayDispatchHandler, createRelayUnregisterEndpointHandler } from './relay-tools.js';
```

### 7. CCA Progress Streaming (`packages/relay/src/adapters/claude-code-adapter.ts`)

The key change is in `handleAgentMessage()`. The current dispatch logic:

```typescript
const isInboxReplyTo = envelope.replyTo?.startsWith('relay.inbox.');
```

Must be split to distinguish dispatch inboxes from query inboxes:

```typescript
const isDispatchInbox = envelope.replyTo?.startsWith('relay.inbox.dispatch.');
// Non-dispatch inbox replyTo (relay.inbox.query.* etc.) → existing aggregated behavior
const isQueryInbox = envelope.replyTo?.startsWith('relay.inbox.') && !isDispatchInbox;
```

**Event loop for dispatch inbox:**

```typescript
let stepCounter = 0;
let messageBuffer = '';

for await (const event of eventStream) {
  if (controller.signal.aborted) break;
  eventCount++;

  if (envelope.replyTo && this.relay) {
    if (isDispatchInbox) {
      // Accumulate text deltas
      if (event.type === 'text_delta') {
        const data = event.data as { text: string };
        messageBuffer += data.text;
      }
      // Tool call starts signal end of prior text block — flush buffer as progress
      if (event.type === 'tool_call_start' && messageBuffer) {
        stepCounter++;
        await this.publishDispatchProgress(envelope, stepCounter, 'message', messageBuffer, ccaSessionKey);
        messageBuffer = '';
      }
      // tool_result events publish a progress step
      if (event.type === 'tool_result') {
        stepCounter++;
        const data = event.data as { content?: string; tool_use_id?: string };
        const text = typeof data.content === 'string' ? data.content : JSON.stringify(data);
        await this.publishDispatchProgress(envelope, stepCounter, 'tool_result', text, ccaSessionKey);
      }
    } else if (isQueryInbox) {
      // Existing aggregated behavior: collect text_delta only
      if (event.type === 'text_delta') {
        const data = event.data as { text: string };
        collectedText += data.text;
      }
    } else {
      // Existing behavior: stream raw events (relay.agent.*, relay.human.*)
      await this.publishResponse(envelope, event, ccaSessionKey);
    }
  }
}
```

**Post-loop for dispatch inbox:**

```typescript
if (isDispatchInbox && envelope.replyTo && this.relay) {
  // Flush any remaining text buffer as a final message step
  if (messageBuffer) {
    stepCounter++;
    await this.publishDispatchProgress(envelope, stepCounter, 'message', messageBuffer, ccaSessionKey);
  }
  // Publish final agent_result with done: true and full collected text
  await this.publishAgentResult(envelope, collectedText, ccaSessionKey);
}
```

**New private helper `publishDispatchProgress()`:**

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

**Update `publishAgentResult()` to include `done: true`:**

```typescript
await this.relay.publish(originalEnvelope.replyTo, { type: 'agent_result', text, done: true }, opts);
```

> This is additive — the `done: true` field is new. Existing `relay_query` consumers that check `payload.type === 'agent_result'` continue to work unchanged.

### 8. context-builder.ts: Updated RELAY_TOOLS_CONTEXT

Replace the current `RELAY_TOOLS_CONTEXT` constant with an updated version that:

1. **Documents `relay_dispatch` workflow** with the full polling loop pattern
2. **Updates relay_query guidance** — max timeout is now 10 min (600 s), still recommended for ≤10 min tasks
3. **Adds subagent MCP constraint warning** with the orchestrator pattern workaround

The updated context block:

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

---

## Data Flow

### Current (all-at-once)

```
Agent A: relay_query(to_subject="relay.agent.{B}", timeout=120s)
  → relay.registerEndpoint("relay.inbox.query.{UUID}")
  → relay.publish("relay.agent.{B}", replyTo="relay.inbox.query.{UUID}")
  → relay.subscribe("relay.inbox.query.{UUID}", resolve)
  → await Promise (120s max)
  ← CCA: publishAgentResult → relay.publish(inbox, { type:'agent_result', text })
  ← Promise resolves → return { reply, from, ... }
```

### New (async dispatch + streaming)

```
Agent A: relay_dispatch(to_subject="relay.agent.{B}")
  → relay.registerEndpoint("relay.inbox.dispatch.{UUID}")
  → relay.publish("relay.agent.{B}", replyTo="relay.inbox.dispatch.{UUID}")
  → if rejected: auto-unregister inbox, return { error, rejected }
  ← return IMMEDIATELY: { messageId, inboxSubject: "relay.inbox.dispatch.{UUID}" }

[Agent B's session runs — CCA streams to dispatch inbox:]
  → tool_call_start (or done): flush text buffer
    → relay.publish(inbox, { type:'progress', step:N, step_type:'message', text:'...', done:false })
  → tool_result event:
    → relay.publish(inbox, { type:'progress', step:N, step_type:'tool_result', text:'...', done:false })
  → session end:
    → relay.publish(inbox, { type:'agent_result', text:'...full...', done:true })

Agent A (polling): relay_inbox(endpoint_subject="relay.inbox.dispatch.{UUID}", status="unread")
  ← receives progress messages + final result
  → when done:true received: relay_unregister_endpoint(subject="relay.inbox.dispatch.{UUID}")
```

---

## User Experience (Agent Perspective)

Agents interact exclusively through MCP tools. The new experience:

**For long-running tasks (relay_dispatch):**
```
# Fire and poll pattern
result = relay_dispatch(
  to_subject="relay.agent.{analysisAgentId}",
  payload={"task": "Analyze entire codebase and write report"},
  from="relay.agent.{myAgentId}"
)
inbox = result.inboxSubject

# Poll at natural breakpoints
while True:
    messages = relay_inbox(endpoint_subject=inbox, status="unread", limit=10)
    for msg in messages.messages:
        if msg.payload.done == True:
            # Final result received
            relay_unregister_endpoint(subject=inbox)
            break
        # Process intermediate progress
        print(f"Step {msg.payload.step}: {msg.payload.text[:100]}")
```

**For medium-duration tasks (relay_query, now up to 10 min):**
```
# Blocking call, up to 10 minutes
result = relay_query(
  to_subject="relay.agent.{codeReviewAgentId}",
  payload={"task": "Review the PR"},
  from="relay.agent.{myAgentId}",
  timeout_ms=300000  # 5 min
)
```

---

## Testing Strategy

### Unit Tests

**`apps/server/src/services/core/__tests__/mcp-tool-server.test.ts`**

- Update the tool count test: `toHaveLength(14)` → `toHaveLength(16)`
- Update the comment: `(4 core + 5 pulse + 5 relay)` → `(4 core + 5 pulse + 7 relay)`
- Add `relay_dispatch` and `relay_unregister_endpoint` to the "registers tools with correct names" assertions

```typescript
it('registers 16 tools (4 core + 5 pulse + 7 relay)', () => {
  // Purpose: regression guard against accidental tool omissions or additions.
  // This count changes intentionally when new MCP tools are added.
  const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
  expect(server.tools).toHaveLength(16);
});

it('registers relay_dispatch and relay_unregister_endpoint', () => {
  const server = createDorkOsToolServer(makeMockDeps()) as unknown as MockServer;
  const toolNames = server.tools.map((t) => t.name);
  expect(toolNames).toContain('relay_dispatch');
  expect(toolNames).toContain('relay_unregister_endpoint');
});
```

**`apps/server/src/services/core/__tests__/tool-filter.test.ts`**

- Add `relay_dispatch` and `relay_unregister_endpoint` to the relay tools inclusion test
- Verify both tools are excluded when relay is disabled

```typescript
it('includes relay_dispatch and relay_unregister_endpoint when relay enabled', () => {
  // Purpose: ensures new relay tools follow the relay toggle exactly.
  const config = resolveToolConfig(undefined, allEnabledDeps);
  const allowed = buildAllowedTools({ ...config, pulse: false, mesh: false, adapter: false });
  expect(allowed).toContain('mcp__dorkos__relay_dispatch');
  expect(allowed).toContain('mcp__dorkos__relay_unregister_endpoint');
});

it('excludes relay_dispatch and relay_unregister_endpoint when relay disabled', () => {
  // Purpose: verifies relay feature gate applies to new tools.
  const config = resolveToolConfig(undefined, allDisabledDeps);
  const allowed = buildAllowedTools(config);
  expect(allowed).not.toContain('mcp__dorkos__relay_dispatch');
  expect(allowed).not.toContain('mcp__dorkos__relay_unregister_endpoint');
});
```

**New tests for `relay_dispatch` handler** (add to mcp-tool-server.test.ts or a new relay-tools.test.ts):

```typescript
describe('createRelayDispatchHandler', () => {
  it('returns error when relay disabled', async () => {
    // Purpose: verifies requireRelay guard applies to relay_dispatch.
    const handler = createRelayDispatchHandler(makeMockDeps());
    const result = await handler({ to_subject: 'relay.agent.x', payload: {}, from: 'me' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('RELAY_DISABLED');
  });

  it('returns messageId and inboxSubject on success', async () => {
    // Purpose: verifies the non-blocking return contract.
    const relayCore = makeRelayCoreMock({ deliveredTo: 1, messageId: 'msg-1' });
    const handler = createRelayDispatchHandler({ ...makeMockDeps(), relayCore });
    const result = await handler({ to_subject: 'relay.agent.x', payload: {}, from: 'me' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.messageId).toBe('msg-1');
    expect(parsed.inboxSubject).toMatch(/^relay\.inbox\.dispatch\./);
    expect(result.isError).toBeUndefined();
  });

  it('auto-unregisters inbox on early rejection', async () => {
    // Purpose: prevents inbox leaks when message is immediately rejected.
    const relayCore = makeRelayCoreMock({
      deliveredTo: 0,
      rejected: [{ subject: 'relay.agent.x', reason: 'rate limit' }],
    });
    const handler = createRelayDispatchHandler({ ...makeMockDeps(), relayCore });
    const result = await handler({ to_subject: 'relay.agent.x', payload: {}, from: 'me' });
    expect(result.isError).toBe(true);
    expect(relayCore.unregisterEndpoint).toHaveBeenCalledOnce();
    expect(JSON.parse(result.content[0].text).code).toBe('REJECTED');
  });
});

describe('createRelayUnregisterEndpointHandler', () => {
  it('returns success when endpoint exists', async () => {
    // Purpose: basic happy path for cleanup tool.
    const relayCore = makeRelayCoreMock({ unregisterResult: true });
    const handler = createRelayUnregisterEndpointHandler({ ...makeMockDeps(), relayCore });
    const result = await handler({ subject: 'relay.inbox.dispatch.abc' });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.success).toBe(true);
    expect(result.isError).toBeUndefined();
  });

  it('returns ENDPOINT_NOT_FOUND when endpoint does not exist', async () => {
    // Purpose: caller can detect cleanup of non-existent inbox (idempotent cleanup).
    const relayCore = makeRelayCoreMock({ unregisterResult: false });
    const handler = createRelayUnregisterEndpointHandler({ ...makeMockDeps(), relayCore });
    const result = await handler({ subject: 'relay.inbox.dispatch.gone' });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).code).toBe('ENDPOINT_NOT_FOUND');
  });
});
```

### Integration Tests

**`packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`**

Add three new tests:

```typescript
it('publishes multiple progress events followed by agent_result for relay.inbox.dispatch.* replyTo', async () => {
  // Purpose: end-to-end verification that CCA streams progress to dispatch inboxes.
  // Validates the core contract: Agent A receives intermediate steps + done:true.
  await relay.registerEndpoint('relay.inbox.dispatch.test-uuid');

  const receivedPayloads: unknown[] = [];
  relay.subscribe('relay.inbox.dispatch.test-uuid', (envelope) => {
    receivedPayloads.push(envelope.payload);
  });

  vi.mocked(agentManager.sendMessage).mockReturnValue(
    (async function* () {
      yield { type: 'text_delta', data: { text: 'Thinking...' } } as StreamEvent;
      yield { type: 'tool_call_start', data: { tool_use_id: 'tu1', name: 'Read' } } as StreamEvent;
      yield { type: 'tool_result', data: { tool_use_id: 'tu1', content: 'file contents' } } as StreamEvent;
      yield { type: 'text_delta', data: { text: 'Analysis complete.' } } as StreamEvent;
      yield { type: 'done', data: {} } as StreamEvent;
    })(),
  );

  await relay.publish(
    'relay.agent.dispatch-target',
    { text: 'Analyze this' },
    { from: 'relay.agent.sender', replyTo: 'relay.inbox.dispatch.test-uuid' },
  );

  const types = receivedPayloads.map((p) => (p as Record<string, unknown>).type);
  // Progress events arrive before the final result
  expect(types).toContain('progress');
  expect(types[types.length - 1]).toBe('agent_result');

  // Final result has done: true
  const finalResult = receivedPayloads[receivedPayloads.length - 1] as Record<string, unknown>;
  expect(finalResult.done).toBe(true);

  // Progress events have done: false
  const progressEvents = receivedPayloads.filter(
    (p) => (p as Record<string, unknown>).type === 'progress'
  );
  expect(progressEvents.length).toBeGreaterThan(0);
  progressEvents.forEach((p) => {
    expect((p as Record<string, unknown>).done).toBe(false);
  });
});

it('still publishes single agent_result for relay.inbox.query.* replyTo (backward compat)', async () => {
  // Purpose: regression guard — relay_query inbox behavior must not change.
  // relay_query subscribes via EventEmitter and resolves on the FIRST message;
  // streaming would break it.
  await relay.registerEndpoint('relay.inbox.query.existing-test');

  const receivedPayloads: unknown[] = [];
  relay.subscribe('relay.inbox.query.existing-test', (envelope) => {
    receivedPayloads.push(envelope.payload);
  });

  await relay.publish(
    'relay.agent.lifeOS-session',
    { text: 'question' },
    { from: 'relay.agent.sender', replyTo: 'relay.inbox.query.existing-test' },
  );

  // Still exactly one message, still agent_result, still no progress events
  expect(receivedPayloads).toHaveLength(1);
  expect(receivedPayloads[0]).toMatchObject({ type: 'agent_result' });
  const hasProgress = receivedPayloads.some(
    (p) => (p as Record<string, unknown>).type === 'progress',
  );
  expect(hasProgress).toBe(false);
});

it('step_type field is "message" for text completions and "tool_result" for tool events', async () => {
  // Purpose: validates the step_type discriminator field is correctly set,
  // allowing Agent A to distinguish text progress from tool activity.
  await relay.registerEndpoint('relay.inbox.dispatch.step-type-test');

  const receivedPayloads: unknown[] = [];
  relay.subscribe('relay.inbox.dispatch.step-type-test', (envelope) => {
    receivedPayloads.push(envelope.payload);
  });

  vi.mocked(agentManager.sendMessage).mockReturnValue(
    (async function* () {
      yield { type: 'text_delta', data: { text: 'Hello' } } as StreamEvent;
      yield { type: 'tool_call_start', data: { tool_use_id: 'tu1', name: 'Bash' } } as StreamEvent;
      yield { type: 'tool_result', data: { tool_use_id: 'tu1', content: 'output' } } as StreamEvent;
      yield { type: 'done', data: {} } as StreamEvent;
    })(),
  );

  await relay.publish(
    'relay.agent.target',
    { text: 'Do work' },
    { from: 'relay.agent.src', replyTo: 'relay.inbox.dispatch.step-type-test' },
  );

  const progressEvents = receivedPayloads.filter(
    (p) => (p as Record<string, unknown>).type === 'progress',
  ) as Array<Record<string, unknown>>;

  const messageSteps = progressEvents.filter((p) => p.step_type === 'message');
  const toolSteps = progressEvents.filter((p) => p.step_type === 'tool_result');

  expect(messageSteps.length).toBeGreaterThan(0);
  expect(toolSteps.length).toBeGreaterThan(0);
});
```

### Mocking Strategy

- Use `vi.fn()` for `RelayCore` methods in unit tests (`registerEndpoint`, `unregisterEndpoint`, `publish` return controlled mock values)
- CCA integration tests use real `RelayCore` with a temp directory (existing pattern from `relay-cca-roundtrip.test.ts`)
- Mock `agentManager.sendMessage` returns async generators with controlled event sequences

---

## Performance Considerations

- **Progress publish overhead:** Each CCA progress publish is a `relay.publish()` call — synchronous `EventEmitter2` dispatch (no network). Overhead is negligible.
- **Memory:** Dispatch inboxes accumulate messages in Maildir on disk until unregistered. For a 20-minute session with one progress step per tool call (~50 calls), this is ~50 messages at ~1 KB each ≈ 50 KB. Not a concern.
- **relay_query unchanged:** The timeout raise to 600 s is a Zod schema max change. No runtime overhead.
- **text buffer:** CCA accumulates `messageBuffer` (a string) in the dispatch path — no material memory impact vs. the existing `collectedText` accumulation.

---

## Security Considerations

- **Inbox subject namespace:** `relay.inbox.dispatch.{UUID}` uses `randomUUID()` (Node.js crypto), which is cryptographically secure. Inboxes cannot be guessed.
- **Feature gate:** Both new tools are gated behind `DORKOS_RELAY_ENABLED`. No exposure when relay is off.
- **Access control:** `relay.publish()` enforces existing relay access control rules on the target subject; relay_dispatch does not bypass them.
- **Inbox cleanup:** Auto-unregister on early rejection prevents orphaned inboxes. Server restarts naturally clear in-memory endpoint state.
- **No new attack surface:** relay_unregister_endpoint can only remove endpoints the caller knows the name of. Since names are UUIDs, callers cannot remove other agents' inboxes without knowing the exact UUID.

---

## Documentation

- **RELAY_TOOLS_CONTEXT** in `context-builder.ts` updated (Section 8 of Technical Design above) — this is the primary documentation for agents
- No user-facing docs changes required (relay_dispatch is agent-to-agent; not surfaced in the DorkOS UI)
- `contributing/architecture.md` — no changes needed (patterns are extensions of existing relay architecture)

---

## Implementation Phases

### Phase 1: New Types and Tool Skeleton

1. Add `RelayProgressPayloadSchema` and `RelayAgentResultPayloadSchema` to `packages/shared/src/relay-schemas.ts`
2. Add `createRelayDispatchHandler` to `relay-tools.ts` (no CCA changes needed yet)
3. Add `createRelayUnregisterEndpointHandler` to `relay-tools.ts`
4. Register both tools in `getRelayTools()` in `relay-tools.ts`
5. Export new handlers from `mcp-tools/index.ts`
6. Add both tools to `RELAY_TOOLS` in `tool-filter.ts`
7. Raise relay_query `.max(120000)` to `.max(600000)`
8. Update unit tests: tool count (14→16), relay tool names, tool-filter inclusion/exclusion

**Verification:** `pnpm vitest run apps/server/src/services/core/__tests__/mcp-tool-server.test.ts apps/server/src/services/core/__tests__/tool-filter.test.ts`

### Phase 2: CCA Streaming Progress

1. Refactor `handleAgentMessage()` in `claude-code-adapter.ts`:
   - Split `isInboxReplyTo` into `isDispatchInbox` and `isQueryInbox`
   - Add text buffer accumulation and flush logic for dispatch inboxes
   - Add `publishDispatchProgress()` private helper
   - Update `publishAgentResult()` to include `done: true`
2. Add integration tests to `relay-cca-roundtrip.test.ts` (three new tests from Testing Strategy above)

**Verification:** `pnpm vitest run packages/relay/src/__tests__/relay-cca-roundtrip.test.ts`

### Phase 3: context-builder Documentation

1. Replace `RELAY_TOOLS_CONTEXT` in `context-builder.ts` with updated version (Section 8)
2. Run full test suite to confirm no regressions

**Verification:** `pnpm test -- --run`

---

## Open Questions

All implementation decisions from the ideation have been resolved. No open questions remain.

For future consideration:
- **Endpoint type metadata**: Add `type: 'dispatch' | 'persistent'` field to relay_list_endpoints output so agents can filter dispatch inboxes. Deferred from this spec.
- **Server-side TTL for dispatch inboxes**: Auto-expire after 30–60 min for agents that fail to clean up. Deferred from this spec.
- **relay_query streaming**: If relay_query's timeout is raised further (>10 min), consider whether relay_query should also benefit from streaming progress. Requires rethinking the EventEmitter resolve-on-first-message pattern.

---

## Related ADRs

- **ADR-0010** (`0010-use-maildir-for-relay-message-storage.md`) — Dispatch inboxes use Maildir on disk; messages persist until unregistered
- **ADR-0012** (`0012-use-ulid-for-relay-message-ids.md`) — Relay message IDs use ULIDs; dispatch `messageId` follows this convention
- **ADR-0028** (`0028-sqlite-trace-storage-in-relay-index.md`) — Trace spans are recorded for all relay deliveries including dispatch

---

## References

- `research/20260304_agent-to-agent-reply-patterns.md` — Prior research on relay_query and fire-and-poll patterns
- `research/20260304_relay_async_query_and_subagent_mcp.md` — Confirms fire-and-poll pattern; documents SDK subagent MCP limitation (Anthropic #13898, #14496, #5465)
- `packages/relay/src/adapters/claude-code-adapter.ts` — CCA implementation; `handleAgentMessage()` is the primary change target
- `apps/server/src/services/core/mcp-tools/relay-tools.ts` — Relay MCP tool definitions
- `apps/server/src/services/core/tool-filter.ts` — RELAY_TOOLS constant
- `apps/server/src/services/core/context-builder.ts` — RELAY_TOOLS_CONTEXT static string
- Google A2A protocol "Tasks" primitive — fire-and-poll design inspiration
