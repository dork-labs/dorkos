---
title: 'Agent-to-Agent Request/Reply Patterns for DorkOS Relay'
date: 2026-03-04
type: internal-architecture
status: final
tags: [relay, agent-communication, mcp, request-reply, claude-agent-sdk, polling, push, relay_query]
feature_slug: fix-relay-agent-routing-cwd
searches_performed: 12
sources_count: 24
---

# Agent-to-Agent Request/Reply Patterns for DorkOS Relay

## Executive Summary

The current DorkOS relay workflow (register inbox → send message → poll inbox in a loop) is fundamentally sound but ergonomically painful. The status vocabulary bug that prevented agents from filtering "unread" messages has been fixed with the alias normalizer in `relay-tools.ts`. The remaining problem is purely latency and turn cost: polling consumes LLM turns that could be doing real work.

The most pragmatic near-term fix is **Option B — a `relay_query` blocking MCP tool** that hides the polling loop from the agent entirely. It is implementable in a single afternoon, requires no new infrastructure, and is transparent to the agent model. For long-running inter-agent collaborations, the system should also expose the RelayCore's `subscribe()` channel as an SSE endpoint agents can poll via Bash (Option E variant), giving a push-notification path without SDK changes. Option C (push via `relay.agent.*`) and Option D (background subagent) are deferred for later.

---

## Background

DorkOS agents communicate via Relay subjects. When Agent A wants to ask Agent B a question, the current workflow is:

1. Agent A calls `relay_register_endpoint(subject="relay.inbox.{myAgentId}")`
2. Agent A calls `relay_send(subject="relay.agent.{agentBId}", payload, replyTo="relay.inbox.{myAgentId}")`
3. CCA (ClaudeCodeAdapter) picks up the message from `relay.agent.>`, runs Agent B's SDK session, and publishes the aggregated result text to `relay.inbox.{agentAId}`
4. Agent A calls `relay_inbox(endpoint_subject="relay.inbox.{myAgentId}", status="unread")` in a loop until the reply appears

The status vocabulary normalizer (`new`/`unread` → `pending`, `cur`/`read` → `delivered`) was just added, so the polling mechanics now work correctly. But polling still costs tokens per turn and requires agents to structure their reasoning around a wait loop.

---

## Research Findings

### 1. Claude Agent SDK Concurrency Model

**Key constraint confirmed from source code and official docs:**

The Claude Agent SDK's `query()` function creates a new `ProcessTransport` and spawns a fresh Claude CLI subprocess for each call. The SDK documentation confirms:

- Multiple `query()` calls on **different session IDs** run fully in parallel — each gets its own subprocess and there is no cross-session contention.
- Multiple `query()` calls on the **same session ID** (`resume: sessionId`) cannot overlap. CCA's `processWithQueue()` already serializes these with a per-agentId promise chain to prevent the "Already connected to a transport" error.
- A CLI session open in a terminal against the same CWD creates a **third independent subprocess** — it does NOT conflict at the SDK transport level (each process has its own lock file). However, concurrent writes to the same JSONL transcript can cause ordering issues.

The CCA's existing `agentQueues` Map (introduced in ADR-0075) prevents the "Already connected" error for overlapping relay messages to the same agent. Cross-agent parallelism is unaffected.

**Background/async subagents (confirmed from SDK docs):**

The `Task` tool supports background subagent spawning with `run_in_background: true`. When a subagent completes, it automatically "wakes up the main agent with results." The `AgentOutputTool` surfaces results automatically. This is the mechanism behind Option D.

Subagents:

- Cannot spawn their own subagents (`Task` is not in subagent `tools`)
- Run in isolated context (separate JSONL file)
- Can be resumed via `resume: sessionId` in a subsequent `query()` call
- Are identified in transcripts by `parent_tool_use_id`

### 2. MCP Tool Blocking and Timeout Behavior

**Can an MCP tool block for 30–60 seconds?**

Yes, with important caveats. The MCP specification (2025-06-18) states that implementations "should establish timeouts for all sent requests" and recommends "reset the timeout clock when receiving a progress notification." There is no hard protocol-level timeout specified — it is implementation-defined. However:

- The Claude Agent SDK's in-process MCP server (`createSdkMcpServer`) runs tool handlers in the same Node.js event loop as the server. A tool handler that blocks the event loop (e.g., a synchronous `while` loop) would freeze the entire server.
- An async tool handler that uses `await Promise.race([replyPromise, timeoutPromise])` with a 30–60 second timeout is **fully valid** — it is non-blocking (yields to the event loop during the await).
- The MCP 2025-11-25 specification introduced a formal `Tasks` primitive ("call-now, fetch-later") for operations exceeding transport timeout thresholds. For a 30-60 second wait, a blocking async await is simpler and within practical timeouts.
- GitHub Issue #41 on `anthropics/claude-agent-sdk-typescript` documents "Stream closed" errors for concurrent tool calls via in-process MCP servers, suggesting there is a race condition in the SDK transport when multiple tool handlers execute simultaneously. A blocking tool serializes naturally and avoids this issue.

**Practical limit:** A well-structured async `relay_query` tool can wait up to 60–120 seconds before typical HTTP/SSE client timeouts kick in. Since the DorkOS MCP tools run in-process (not over HTTP), there is no transport-level timeout — only the agent session's overall TTL budget applies.

### 3. RelayCore Subscription Mechanism

RelayCore exposes `relay.subscribe(pattern, handler): Unsubscribe`, which registers a direct in-process callback for matching envelopes. This is EventEmitter2-backed and fires synchronously within the same process. For Option F (hybrid EventEmitter), a `relay_query` tool handler can:

```typescript
const reply = await new Promise<RelayEnvelope>((resolve, reject) => {
  const unsub = relayCore.subscribe(ephemeralInbox, (envelope) => {
    unsub();
    resolve(envelope);
  });
  setTimeout(() => {
    unsub();
    reject(new Error('relay_query timeout'));
  }, timeoutMs);
});
```

This is zero-overhead (no polling, no disk I/O) and resolves the moment CCA publishes the reply. CCA already publishes to `relay.inbox.*` subjects via `publishAgentResult()`.

### 4. Industry Patterns for Agent-to-Agent RPC

**A2A Protocol (Google, April 2025 / v0.3 July 2025):**
The Agent2Agent protocol uses three modalities: synchronous request/response, SSE streaming for real-time updates, and webhook push for long-running or disconnected scenarios. The SSE model is the primary recommendation for low-latency agent-to-agent communication. For DorkOS, the analogous mechanism is RelayCore's `subscribe()` + in-process MCP tool await.

**LangGraph:**
LangGraph uses a shared-state scratchpad model where agents communicate via a typed state graph, not via async messaging. This is architecturally different from DorkOS's pub/sub relay and not directly applicable. For agent-to-agent handoff, LangGraph passes full session context as a "transfer packet."

**AutoGen v0.4 (January 2025):**
AutoGen added asynchronous messaging with both event-driven and request/response patterns. Its approach is an event loop where agents are explicit endpoints and messages are routed through an orchestrator. The async-first design avoids polling: agents register handlers and are notified on message arrival. This is closest to Option F.

**CrewAI:**
CrewAI uses sequential or hierarchical process execution — agents execute tasks in a predetermined order with results passed directly. No async messaging; not applicable to DorkOS's use case.

**MCP Agent-to-Agent (Microsoft, AWS, 2025):**
Microsoft's "Can You Build Agent2Agent Communication on MCP?" demonstrates that MCP's streaming notifications enable push-based agent-to-agent messaging. AWS's open protocol series (Part 1: Inter-Agent on MCP) confirms MCP's native support for multi-turn interactions via sampling and elicitation. Both confirm that blocking MCP tools are a valid pattern for short-lived synchronous sub-tasks.

**General Industry Consensus:**
The industry has moved strongly toward push-based / event-driven architectures (SSE, webhooks, EventEmitter callbacks) over polling for agent-to-agent communication. Polling is acceptable only for:

- Disconnected/unreliable clients (webhooks → poll for full state)
- Very long-running background tasks (minutes to hours)
- Environments where persistent connections are unavailable

For in-process or same-server communication (DorkOS's primary use case), an EventEmitter/Promise-based await is universally preferred.

---

## Option Analysis

### Option A: Fix + Keep Polling (Status Quo++)

The status vocabulary bug is already fixed. The current flow works but is ergonomically poor.

| Dimension                 | Assessment                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Latency**               | Depends on poll interval. With a 2-second sleep between polls, worst case is 2 seconds extra. 3-5 polls = 4-10 seconds overhead.                                        |
| **Turn cost**             | High. Each `relay_inbox` call consumes one MCP tool use turn. 3-5 polls = 3-5 extra turns. With typical 10-turn budgets, this is significant.                           |
| **Complexity**            | Lowest — no new infrastructure required.                                                                                                                                |
| **Reliability**           | Good. Messages persist in SQLite. If the agent session restarts, it can still find the reply.                                                                           |
| **Concurrency safety**    | Good. The inbox is a passive maildir — no session conflicts.                                                                                                            |
| **Context window impact** | Moderate. Each `relay_inbox` response adds tool result blocks to the context.                                                                                           |
| **Agent autonomy**        | Poor. The agent must explicitly structure its reasoning around a wait loop. Agents often mishandle this (forget to sleep, poll immediately, hit turn budget).           |
| **Verdict**               | Acceptable baseline, but not a long-term solution. Guides agents to poll without a status filter (`relay_inbox(endpoint_subject="...", limit=1)`) and add a Bash sleep. |

### Option B: `relay_query` Blocking MCP Tool

Add a new MCP tool that internally handles the register/send/wait/return cycle, transparent to the agent.

```typescript
tool(
  'relay_query',
  'Send a message to an agent and wait synchronously for the reply. Handles inbox registration, send, and wait internally.',
  {
    to_subject: z.string().describe('Target subject (e.g., "relay.agent.{agentId}")'),
    payload: z.unknown().describe('Message payload'),
    from: z.string().describe('Sender identifier'),
    timeout_ms: z.number().int().min(1000).max(120000).optional().describe('Wait timeout in ms (default: 60000)'),
    budget: z.object({ ... }).optional(),
  },
  async (args) => {
    // 1. Register an ephemeral inbox subject (use randomUUID for uniqueness)
    const inboxSubject = `relay.inbox.query.${randomUUID()}`;
    await relayCore.registerEndpoint(inboxSubject);

    // 2. Send the message with replyTo pointing at our ephemeral inbox
    await relayCore.publish(args.to_subject, args.payload, {
      from: args.from,
      replyTo: inboxSubject,
      budget: args.budget,
    });

    // 3. Wait for a reply via in-process RelayCore subscription
    const timeout = args.timeout_ms ?? 60_000;
    try {
      const reply = await new Promise<RelayEnvelope>((resolve, reject) => {
        const unsub = relayCore.subscribe(inboxSubject, (envelope) => {
          unsub();
          resolve(envelope);
        });
        setTimeout(() => { unsub(); reject(new Error('relay_query timed out')); }, timeout);
      });
      return jsonContent({ reply: reply.payload, from: reply.from, messageId: reply.id });
    } finally {
      // Clean up ephemeral endpoint
      // (RelayCore may need a deregisterEndpoint() method — if not, use a short TTL)
    }
  }
)
```

| Dimension                 | Assessment                                                                                                                                                                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Latency**               | Excellent. Resolves within milliseconds of CCA publishing the reply. No polling interval.                                                                                                                                                                                                |
| **Turn cost**             | Minimal. One tool call (`relay_query`) instead of 3+ (`relay_register_endpoint` + `relay_send` + N × `relay_inbox`).                                                                                                                                                                     |
| **Complexity**            | Moderate. Requires: (1) new `relay_query` tool, (2) RelayCore `subscribe()` hookup in tool context, (3) optional `deregisterEndpoint()` for cleanup.                                                                                                                                     |
| **Reliability**           | Good for timeouts ≤ 120 seconds. If the receiving agent's session exceeds the TTL, the tool returns a timeout error and the caller can fall back to polling.                                                                                                                             |
| **Concurrency safety**    | Excellent. Ephemeral inbox is unique per call (randomUUID). No shared state.                                                                                                                                                                                                             |
| **Context window impact** | Minimal. One clean tool result instead of multiple inbox poll results.                                                                                                                                                                                                                   |
| **Agent autonomy**        | Excellent. The agent makes one call and gets the answer — identical to calling any other synchronous tool.                                                                                                                                                                               |
| **Verdict**               | **Recommended primary solution.** Transparent, low-turn-cost, implementable quickly. The key dependency is that RelayCore's `subscribe()` must be accessible from the MCP tool context — which it is, since DorkOS's MCP tools receive `deps.relayCore` via the `McpToolDeps` injection. |

**Critical implementation note:** The ephemeral inbox must be cleaned up after use. Two approaches:

1. Add `deregisterEndpoint(subject)` to RelayCore API.
2. Register with a short TTL so the SQLite row auto-expires. The watcher for that endpoint should also be removed.

Option 2 is lower risk if `deregisterEndpoint` does not exist; Option 1 is cleaner.

**CCA compatibility:** CCA already detects `relay.inbox.*` replyTo addresses and uses `publishAgentResult()` to send a single aggregated `{ type: 'agent_result', text }` envelope. The `relay_query` tool's `relayCore.subscribe()` handler will receive exactly this envelope. No CCA changes required.

### Option C: Reply via `relay.agent.*` (Push into Session)

Change CCA to publish replies to `relay.agent.{senderId}` instead of `relay.inbox.{senderId}`. CCA would pick up this message and deliver it as a new turn to Agent A's session.

| Dimension                 | Assessment                                                                                                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Latency**               | Excellent — no polling delay.                                                                                                                                                                                       |
| **Turn cost**             | Zero extra turns — the reply arrives as the next conversation turn.                                                                                                                                                 |
| **Complexity**            | High. Requires careful loop prevention (CCA already detects and skips StreamEvent payloads, but an `agent_result` envelope would need similar handling).                                                            |
| **Reliability**           | Moderate. If Agent A's session is busy with CCA (processing a different message in the queue), the reply must queue behind it. The per-agent queue handles this, but ordering becomes subtle.                       |
| **Concurrency safety**    | Risky. If Agent A also has an active CLI session or web console, a third entity tries to write to the same conversation. CCA's queue prevents SDK transport conflicts, but it cannot prevent interleaving from CLI. |
| **Context window impact** | None — the reply arrives naturally as a message in the conversation thread.                                                                                                                                         |
| **Agent autonomy**        | Excellent in principle, but the agent must be designed to "stop and wait" before the reply arrives, which is non-trivial.                                                                                           |
| **Verdict**               | Architecturally appealing but introduces loop risk and session conflict scenarios that Option B avoids. Defer until concurrency model is better understood.                                                         |

### Option D: Background Subagent Polling

Agent A spawns a background subagent (via the `Task` tool with `run_in_background: true`) to poll the inbox. The subagent returns the result when the reply arrives, waking up Agent A.

| Dimension                 | Assessment                                                                                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Latency**               | Poor. The subagent still polls `relay_inbox`, adding polling latency plus subagent startup overhead (200–500ms for a new SDK subprocess).                                                                                                                 |
| **Turn cost**             | High. The subagent consumes its own turns for polling. These are from a separate context/budget, which is an advantage, but the total compute cost is higher.                                                                                             |
| **Complexity**            | Very high. Subagents cannot use custom MCP tools defined in the parent session (they inherit the parent's allowed tools but not SDK MCP server instances). This means the subagent cannot call `relay_inbox` unless relay tools are in its `tools` array. |
| **Reliability**           | Moderate. The subagent runs in a separate transcript. If it times out or fails, Agent A may not be notified reliably.                                                                                                                                     |
| **Concurrency safety**    | The subagent uses a different SDK session ID, so no transport conflicts. But two SDK sessions may share the same CWD.                                                                                                                                     |
| **Context window impact** | The subagent's polling loop does not pollute Agent A's context — this is the main advantage.                                                                                                                                                              |
| **Agent autonomy**        | Low. Agent A must explicitly invoke the Task tool with careful parameterization. The agent needs sophisticated prompting to use this correctly.                                                                                                           |
| **Verdict**               | Not recommended. Adds complexity without meaningfully improving latency. The background subagent feature is useful for truly long-running background work (code analysis, log monitoring), not for short synchronous queries.                             |

### Option E: SSE/WebSocket Subscription

Expose a relay SSE stream endpoint (`GET /api/relay/stream?subject=relay.inbox.{agentId}`) that agents can subscribe to via the Bash tool (`curl --no-buffer`).

| Dimension                 | Assessment                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Latency**               | Near-zero once connected. SSE events arrive within milliseconds.                                                                                                                                                                                        |
| **Turn cost**             | Low. One Bash tool call to start the subscription, which blocks until the reply arrives. No polling loop.                                                                                                                                               |
| **Complexity**            | Moderate for server side (DorkOS already has relay SSE endpoints via `routes/relay.ts`). The client side requires agents to know how to consume SSE via curl.                                                                                           |
| **Reliability**           | Moderate. Bash tool calls have timeouts. If the curl command times out (typically 30 seconds for the SDK's Bash tool), the agent must retry.                                                                                                            |
| **Concurrency safety**    | Excellent. SSE is a read-only operation against an HTTP endpoint. No session conflicts.                                                                                                                                                                 |
| **Context window impact** | Low. One Bash tool result with the reply content.                                                                                                                                                                                                       |
| **Agent autonomy**        | Moderate. The agent must construct the correct curl command with proper SSE parsing. This is docable but not transparent.                                                                                                                               |
| **Verdict**               | Viable as an intermediate option while `relay_query` is being built. Could be documented in RELAY_TOOLS_CONTEXT as an alternative pattern. However, it requires agents to parse raw SSE format (the `data:` prefix, event types), which adds fragility. |

**Existing infrastructure check:** `routes/relay.ts` has a `GET /api/relay/stream` endpoint that streams relay events as SSE. Its authentication model (X-Client-Id) and subject filtering capabilities need verification. If it supports `?subject=relay.inbox.{id}` filtering, this option requires zero server changes.

### Option F: Hybrid EventEmitter (relay_query implemented with RelayCore.subscribe)

This is the implementation-level approach for Option B. The difference from "Option B" as a user-visible feature is nil — this describes how to build it internally.

The `relay_query` tool handler:

1. Generates a unique ephemeral inbox subject
2. Calls `relayCore.subscribe(inboxSubject, handler)` — an in-process EventEmitter2 subscription
3. Calls `relayCore.publish(...)` with `replyTo: inboxSubject`
4. Awaits a `Promise` that resolves when the handler fires or rejects on timeout
5. Calls `unsub()` to clean up the subscription in both cases

This is purely an EventEmitter pattern — no polling, no disk I/O, no HTTP round-trips. The subscribe handler fires immediately when CCA calls `publishAgentResult()`, which itself fires the `relayCore.publish()` → subscription dispatch path.

| Dimension                 | Assessment                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Latency**               | Sub-millisecond from when CCA publishes to when relay_query resolves.                                                                                                                 |
| **Turn cost**             | One tool call.                                                                                                                                                                        |
| **Complexity**            | Low. The RelayCore already exposes `subscribe()`. The MCP tool handler is ~30 lines.                                                                                                  |
| **Reliability**           | Bounded by timeout parameter. If CCA's agent session exceeds the timeout, the tool returns an error. Messages persist in SQLite and can be retrieved via `relay_inbox` as a fallback. |
| **Concurrency safety**    | Each call gets a unique inbox subject (UUID). Multiple concurrent `relay_query` calls are fully safe.                                                                                 |
| **Context window impact** | Minimal.                                                                                                                                                                              |
| **Agent autonomy**        | Maximum.                                                                                                                                                                              |
| **Verdict**               | **This is the implementation strategy for Option B.** Not a separate option — same recommendation.                                                                                    |

---

## Recommendation

### Primary Recommendation: Option B implemented as Option F (relay_query + EventEmitter)

**Rationale:**

- Eliminates polling from the agent's perspective entirely
- Works within existing DorkOS infrastructure (RelayCore subscribe, CCA publishAgentResult)
- No SDK changes required
- No new services or databases required
- Handles the CCA concurrency constraint naturally (the tool await runs outside the agent SDK's event loop)
- Industry precedent: all leading frameworks (AutoGen v0.4, A2A protocol, MCP streaming) have moved to push/EventEmitter patterns for agent-to-agent communication

**Secondary Recommendation: Improve Option A ergonomics immediately**

While `relay_query` is being built, update `RELAY_TOOLS_CONTEXT` in `context-builder.ts` with clearer guidance:

```
When waiting for an agent reply:
1. Call relay_send() with replyTo set to your inbox endpoint
2. Use Bash to sleep 3 seconds: `sleep 3`
3. Call relay_inbox(endpoint_subject="...", limit=5) WITHOUT a status filter to return all messages
4. If no reply, repeat steps 2-3 up to 5 times
5. If still no reply after 5 attempts (~15 seconds), consider the request timed out
```

Removing the status filter (so the agent gets all recent messages regardless of read state) is simpler and less error-prone than relying on the status vocabulary.

### Implementation Sketch for relay_query

**Step 1: Add to `relay-tools.ts`**

```typescript
/** Send a message and synchronously wait for the reply (up to timeout_ms). */
export function createRelayQueryHandler(deps: McpToolDeps) {
  return async (args: {
    to_subject: string;
    payload: unknown;
    from: string;
    timeout_ms?: number;
    budget?: { maxHops?: number; ttl?: number; callBudgetRemaining?: number };
  }) => {
    const err = requireRelay(deps);
    if (err) return err;

    const relay = deps.relayCore!;
    const timeoutMs = args.timeout_ms ?? 60_000;
    const inboxSubject = `relay.inbox.query.${randomUUID()}`;

    // Register ephemeral inbox
    try {
      await relay.registerEndpoint(inboxSubject);
    } catch (e) {
      return jsonContent({ error: 'Failed to register ephemeral inbox', detail: String(e) }, true);
    }

    let unsub: (() => void) | undefined;
    const cleanup = () => {
      unsub?.();
      // Best-effort: deregister the ephemeral endpoint
      // relay.deregisterEndpoint?.(inboxSubject);
    };

    try {
      // Send the message with our ephemeral inbox as replyTo
      await relay.publish(args.to_subject, args.payload, {
        from: args.from,
        replyTo: inboxSubject,
        budget: args.budget,
      });

      // Await reply via in-process EventEmitter subscription
      const replyEnvelope = await new Promise<RelayEnvelope>((resolve, reject) => {
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error(`relay_query timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        unsub = relay.subscribe(inboxSubject, (envelope) => {
          clearTimeout(timer);
          cleanup();
          resolve(envelope);
        });
      });

      return jsonContent({
        reply: replyEnvelope.payload,
        from: replyEnvelope.from,
        messageId: replyEnvelope.id,
        subject: replyEnvelope.subject,
      });
    } catch (e) {
      cleanup();
      const message = e instanceof Error ? e.message : String(e);
      return jsonContent({ error: message, code: 'RELAY_QUERY_FAILED' }, true);
    }
  };
}
```

**Step 2: Register the tool in `getRelayTools()`**

Add to the tools array in `relay-tools.ts`:

```typescript
tool(
  'relay_query',
  'Send a message to an agent and wait synchronously for the reply. One call replaces relay_register_endpoint + relay_send + relay_inbox polling.',
  {
    to_subject: z.string().describe('Target subject (e.g., "relay.agent.{agentId}")'),
    payload: z.unknown().describe('Message payload'),
    from: z.string().describe('Sender identifier'),
    timeout_ms: z
      .number()
      .int()
      .min(1000)
      .max(120000)
      .optional()
      .describe('Max wait time in ms. Default 60000 (60 seconds). Increase for slow agents.'),
    budget: z
      .object({
        maxHops: z.number().int().min(1).optional(),
        ttl: z.number().int().optional(),
        callBudgetRemaining: z.number().int().min(0).optional(),
      })
      .optional()
      .describe('Optional budget constraints'),
  },
  createRelayQueryHandler(deps)
);
```

**Step 3: Update `context-builder.ts` relay_tools block**

Add `relay_query` to the documented tools and recommend it as the default for agent-to-agent calls.

**Step 4: Consider adding `deregisterEndpoint()` to RelayCore**

The ephemeral inbox endpoint should be cleaned up after use to avoid accumulating dead endpoints in the SQLite index and watcher filesystem. This requires:

- `RelayCore.deregisterEndpoint(subject: string): void` — removes the endpoint from EndpointRegistry, closes its chokidar watcher, removes the maildir directory
- Or: register endpoints with a short TTL (e.g., 5 minutes) and rely on the existing expiry mechanism

The TTL approach is lower risk and requires no new RelayCore API. The `registerEndpoint()` method can accept `{ ttl?: number }` options.

---

## Research Gaps and Limitations

1. **CCA timeout interaction:** When `relay_query` blocks for 60 seconds, the CCA session running Agent B may also be within its own TTL budget. If Agent B's TTL expires before `relay_query` does, CCA publishes nothing and `relay_query` times out. The error message should distinguish "timeout waiting for reply" from "target agent responded with error."

2. **Multiple concurrent relay_query calls from the same agent session:** Each call gets a unique inbox UUID so there are no subject collisions. However, two concurrent awaiting Promises within the same MCP tool executor could interact with the in-process SDK MCP server's concurrent tool call race (GitHub Issue #41). Testing is recommended.

3. **relay.subscribe() vs relay.inbox polling as fallback:** If the `relay_query` tool times out, the message is still in the SQLite inbox. The agent should be guided to fall back to `relay_inbox` polling if `relay_query` returns a timeout error.

4. **Option C deferred work:** Pushing replies to `relay.agent.*` would eliminate the need for `relay_query` entirely for the common case. The main blocker is designing a reliable "Agent A is waiting, do not interrupt" signal that prevents CLI/web console races. This is worth a separate ADR.

5. **Option E (SSE via Bash) verifying existing endpoint:** The `GET /api/relay/stream` endpoint's subject filtering capabilities were not fully inspected. If it supports `?subject=` filtering, agents could use `curl -N "http://localhost:6942/api/relay/stream?subject=relay.inbox...."` as an alternative to `relay_query` today.

---

## Contradictions and Disputes

- **Polling vs. push consensus:** Industry strongly favors push (EventEmitter, SSE, webhooks) for local/same-process agent communication. However, polling has a meaningful advantage: **persistence**. If the polling agent's session restarts, the messages are still in SQLite. A pushed/awaited message that arrives while the agent is restarting is lost if the in-process EventEmitter fires and no listener exists. `relay_query` must document this: for fault-tolerant communication, use `relay_send` + `relay_inbox` polling; for fast synchronous queries, use `relay_query`.

- **MCP tool timeouts:** The MCP 2025-11-25 spec's Tasks primitive is designed for operations lasting hours. For 60-second waits, a blocking async await is simpler and equally correct. The Tasks primitive adds polling overhead that `relay_query` avoids.

---

## Sources

| Source                                          | URL                                                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Claude Agent SDK — Sessions                     | https://platform.claude.com/docs/en/agent-sdk/sessions                                                                          |
| Claude Agent SDK — Subagents                    | https://platform.claude.com/docs/en/agent-sdk/subagents                                                                         |
| MCP Specification (2025-06-18) — Lifecycle      | https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle                                                        |
| MCP Async Tasks (WorkOS)                        | https://workos.com/blog/mcp-async-tasks-ai-agent-workflows                                                                      |
| MCP Long-Running Tasks (Agnost)                 | https://agnost.ai/blog/long-running-tasks-mcp/                                                                                  |
| MCP SEP-1686: Tasks                             | https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1686                                                        |
| A2A Protocol Specification                      | https://a2a-protocol.org/latest/specification/                                                                                  |
| A2A Streaming & Async Operations                | https://a2a-protocol.org/latest/topics/streaming-and-async/                                                                     |
| Agent2Agent Protocol Announcement               | https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/                                                   |
| Can You Build A2A on MCP? (Microsoft)           | https://developer.microsoft.com/blog/can-you-build-agent2agent-communication-on-mcp-yes                                         |
| LangGraph Multi-Agent Workflows                 | https://blog.langchain.com/langgraph-multi-agent-workflows/                                                                     |
| AutoGen Asynchronous Conversations              | https://www.blocksimplified.com/blog/autogen-asynchronous-multi-agent-conversations                                             |
| Beyond Request-Response (Google ADK)            | https://developers.googleblog.com/en/beyond-request-response-architecting-real-time-bidirectional-streaming-multi-agent-system/ |
| Claude Code Async Subagents (Anthropic Threads) | https://www.threads.com/@claudeai/post/DSGA1yGkdTN                                                                              |
| SDK MCP Server Stream Closed Issue              | https://github.com/anthropics/claude-agent-sdk-typescript/issues/41                                                             |
| DorkOS claude-code-adapter.ts                   | packages/relay/src/adapters/claude-code-adapter.ts                                                                              |
| DorkOS relay-tools.ts                           | apps/server/src/services/core/mcp-tools/relay-tools.ts                                                                          |
| DorkOS relay-core.ts                            | packages/relay/src/relay-core.ts                                                                                                |
| Prior research: Agent SDK capabilities          | research/claude-code-sdk-agent-capabilities.md                                                                                  |
| Prior research: Agent messaging transport       | research/20260224_agent_messaging_transport_libraries.md                                                                        |

## Search Methodology

- Searches performed: 12 web searches + 8 WebFetch calls
- Most productive search terms: "MCP tool long-poll blocking timeout specification", "Claude Agent SDK concurrent query sessions", "A2A protocol streaming async", "Claude Code Task tool subagent background async"
- Primary information sources: platform.claude.com (official SDK docs), a2a-protocol.org, modelcontextprotocol.io, GitHub issues
- DorkOS source files read: `claude-code-adapter.ts`, `relay-tools.ts`, `relay-core.ts`, `adapter-delivery.ts`, existing research on SDK capabilities and agent messaging transports
