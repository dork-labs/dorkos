---
title: 'Relay Async Query Patterns and Subagent MCP Access'
date: 2026-03-04
type: internal-architecture
status: active
tags:
  [
    relay,
    relay_query,
    mcp,
    subagent,
    async,
    agent-to-agent,
    claude-agent-sdk,
    task-tool,
    background-subagent,
  ]
feature_slug: relay-async-query
searches_performed: 6
sources_count: 14
---

# Relay Async Query Patterns and Subagent MCP Access

## Executive Summary

This report covers two related problems in DorkOS's relay system:

1. **relay_query timeout for long-running tasks**: The blocking `relay_query` MCP tool (120s max) is insufficient for agent-to-agent tasks lasting 20+ minutes. The recommended solution is an **async fire-and-poll pattern** combining `relay_send` (fire) with periodic `relay_inbox` polling from the caller's next turn — the same architecture used by Google's A2A protocol for long-horizon work.

2. **Subagent MCP tool access**: When Claude Code spawns background Tasks (subagents), MCP tool access is **unreliable by design** — multiple confirmed GitHub bugs show subagents fail to inherit parent session MCP tools under various conditions. For DorkOS specifically, in-process SDK MCP servers (`createSdkMcpServer`) do **not** propagate to Task-spawned subagents. The recommended mitigation is to **avoid relying on relay tools inside subagents** and instead use the parent agent's relay tools to dispatch and retrieve results.

---

## Prior Research: relay_query is Already Implemented

The companion research file `research/20260304_agent-to-agent-reply-patterns.md` (same date) covers the `relay_query` blocking tool in full. Key status:

- `relay_query` is **already implemented** in `apps/server/src/services/core/mcp-tools/relay-tools.ts` (lines 117–198)
- It uses the EventEmitter/Promise pattern: registers ephemeral inbox → publishes → awaits `relayCore.subscribe()` → resolves on CCA reply
- Current max timeout: 120,000ms (120 seconds)
- This report focuses on **what to do when 120 seconds is not enough** and **the subagent MCP access problem**

---

## Topic 1: Async Patterns When relay_query Timeout Is Insufficient

### The Problem

`relay_query` blocks the MCP tool call and awaits an in-process EventEmitter reply. The maximum supported timeout is 120 seconds. Agent-to-agent tasks (code review, test suite execution, architectural analysis) can take 20+ minutes. There is no in-process solution for this: the MCP protocol itself does not support open-ended blocking calls beyond what the underlying transport tolerates.

### Industry Patterns for Long-Running Agent Tasks

**Google A2A Protocol (2025)** defines three modalities for agent-to-agent communication:

1. Synchronous request/response — for sub-second tasks
2. SSE streaming for real-time updates — for tasks with intermediate progress
3. Webhook/callback push for long-running or disconnected scenarios — for tasks lasting minutes or hours

The A2A spec explicitly recommends the webhook/callback pattern for long-horizon tasks. The caller provides a `replyTo` address and returns immediately; the callee delivers the result when done.

**AutoGen v0.4 (2025)** uses an event-driven async message bus. Agents register handlers and emit events; the runtime dispatches without blocking. For long tasks, the initiating agent moves on to other work and processes the reply message when it arrives in its event loop.

**MCP Tasks primitive (SEP-1686, 2025)** — the MCP specification introduced a formal `Tasks` primitive for "call-now, fetch-later" semantics. The initiating client calls the tool, receives a task ID immediately, then polls with a separate `get_task_status(taskId)` call. This is precisely the pattern needed for DorkOS.

### Recommended Solution: Tiered Timeout Strategy

Use `relay_query` for tasks expected to complete within 120 seconds, and fall back to an async fire-and-poll pattern for long-running tasks.

#### Tier 1: relay_query (< 120s)

Use the existing `relay_query` tool with `timeout_ms` up to 120,000. Good for: quick agent queries, status checks, simple transformations.

#### Tier 2: relay_send + relay_inbox polling (> 120s)

For long-running tasks, the agent should:

1. Register an inbox endpoint: `relay_register_endpoint(subject="relay.inbox.{myAgentId}")`
2. Fire the message: `relay_send(subject="relay.agent.{targetId}", payload, replyTo="relay.inbox.{myAgentId}")`
3. Do other work (or end the turn)
4. In subsequent turns, poll: `relay_inbox(endpoint_subject="relay.inbox.{myAgentId}", limit=5)`
5. Stop polling when a reply appears

The polling interval should be communicated to agents in the `RELAY_TOOLS_CONTEXT` system prompt. Recommended: Bash `sleep 30` between polls for long tasks (not `sleep 2-3` which was designed for short waits).

#### Tier 3: relay_dispatch (Future — Job ID Pattern)

A new `relay_dispatch` tool (not yet implemented) would:

- Register an ephemeral inbox internally
- Send the message
- Return immediately with `{ dispatchId, inboxSubject }` instead of blocking
- The caller stores `dispatchId` and polls `relay_inbox(inboxSubject)` at appropriate intervals

This is the MCP Tasks primitive pattern adapted to DorkOS's relay architecture. Implementation complexity: medium. Recommended if agents consistently need to fire-and-check over multi-minute windows.

### Implementation Note: relay_query Cleanup Gap

The current `relay_query` implementation (relay-tools.ts:193–196) uses `relay.unregisterEndpoint(inboxSubject)` in the `finally` block. This requires that `RelayCore.unregisterEndpoint()` exists. Confirm this method is implemented in `packages/relay/src/relay-core.ts` before relying on the cleanup. If not present, ephemeral endpoints accumulate in SQLite until manual pruning.

---

## Topic 2: Subagent MCP Tool Access

### The Core Problem

When Claude Code spawns a background `Task` (subagent), the subagent runs in an **isolated subprocess**. DorkOS's in-process MCP server (`createSdkMcpServer`) lives in the parent Node.js process. The subagent subprocess has no knowledge of and no connection to this in-process server.

This is not a DorkOS-specific limitation — it is an architectural consequence of how the Claude Agent SDK and Claude CLI spawn subagents.

### What the Official Documentation Says

From `platform.claude.com/docs/en/agent-sdk/subagents`:

> "If omitted, [the subagent] inherits all available tools"
> "Subagents cannot spawn their own subagents. Don't include Task in a subagent's tools array."

The documentation implies MCP tools are inherited. The reality is more complex.

### Confirmed GitHub Bugs

**Issue #13898: Custom Subagents Cannot Access Project-Scoped MCP Servers**

- Custom subagents defined in `.claude/agents/` cannot access MCP tools from project-level `.mcp.json`
- They hallucinate plausible-looking but incorrect results — the bug is difficult to detect
- Built-in `general-purpose` subagents work; custom subagents do not
- Workaround: move MCP servers to user scope (`~/.claude.json`) or perform MCP calls at orchestrator level and pass results
- Secondary finding: async/background subagents fail even with user-scoped MCP servers

**Issue #14496: Task Tool Subagents Fail to Access MCP Tools with Complex Prompts**

- Simple one-step Task prompts: MCP tools work
- Complex multi-step Task prompts: subagent claims "MCP tools are not available in my current toolset"
- Status: closed as duplicate of #13890 (parent bug)
- Workaround: split complex tasks into two calls (first call simple, second call resumes the agent)

**Issue #5465: Task Subagents Fail to Inherit Permissions in MCP Server Mode**

- When Claude Code runs as an MCP server (not relevant to DorkOS's server-side SDK usage)
- Subagents fail to inherit `--permission-mode bypassPermissions` from parent
- Status: closed as NOT PLANNED
- Confirms Anthropic does not intend to fix all MCP inheritance issues in subagents

### What This Means for DorkOS Specifically

DorkOS registers its MCP tools via `createSdkMcpServer()` (the `type: "sdk"` in-process MCP transport). This creates an in-process server within the DorkOS Node.js server process. When `AgentManager.sendMessage()` calls `query()`, it passes this server in `mcpServers`. The SDK connects the Claude CLI subprocess to this in-process server via an internal transport.

When the Claude CLI subprocess spawns a subagent (via the Task tool), that subagent runs as a **nested subprocess**. The nested subprocess does not have a connection to the parent's in-process MCP server because:

1. The in-process MCP server uses an internal SDK transport, not a network socket
2. The nested subprocess cannot import or connect to a TypeScript object in the parent process
3. No socket address or URL is passed to the subagent for reconnection

**Result: DorkOS MCP tools (relay*send, relay_query, relay_inbox, mesh*\_, pulse\_\_, etc.) are NOT available inside Task-spawned subagents.**

### Workarounds

#### Workaround 1: Orchestrator-Level Relay (Recommended for DorkOS)

Keep relay operations in the parent agent. The parent agent:

1. Calls `relay_send` to dispatch work to the target agent
2. Receives results via `relay_query` or `relay_inbox`
3. Spawns subagents only for local computation tasks that do not need relay

This matches DorkOS's intended architecture: the parent session is the relay-aware orchestrator; subagents are lightweight context-isolated workers.

#### Workaround 2: Pass Results as Prompt Context

If a subagent needs relay-derived data, the parent fetches it and passes it directly in the Task prompt:

```
Use the code-reviewer agent to analyze the following changes:
[paste relay reply content here]
```

This avoids the MCP access problem entirely by making the subagent data-only (no tool calls needed).

#### Workaround 3: stdio MCP Server for Subagent Access

If subagents genuinely need relay tool access, register the DorkOS MCP tools as a `stdio` server (subprocess-based) rather than an in-process SDK server. A stdio server runs as a separate process and listens on stdin/stdout; Claude CLI subprocesses can connect to it.

Tradeoffs:

- Requires a separate Node.js entry point that starts the MCP server
- Higher latency than in-process (IPC vs function call)
- More complex operational setup
- Enables MCP tool access in subagents

This is a significant refactor and is not recommended until there is a confirmed need for relay tools inside Task-spawned subagents.

#### Workaround 4: Explicit Agent Definition with Tool List

When the parent session calls `query()` with `agents: { "my-agent": { ... } }`, the programmatic agent definition does NOT include MCP tools in the `tools` array. The `tools` array only accepts built-in tool names (`Read`, `Write`, `Bash`, etc.).

There is currently no documented way to pass an MCP server config to a programmatic subagent definition. The SDK `AgentDefinition` type does not include `mcpServers`.

### Async Background Subagents (run_in_background: true)

The `Task` tool's `run_in_background: true` flag is confirmed to be available. From prior research:

> "The Task tool supports background subagent spawning with run_in_background: true. When a subagent completes, it automatically 'wakes up the main agent with results.'"

However, the MCP access issue is compounded for background subagents: even user-scoped MCP servers fail in async execution mode (GitHub #13898 secondary finding). DorkOS in-process MCP tools are completely unavailable to background subagents.

**Implication for DorkOS relay:** An agent cannot call `relay_send` from inside a background subagent. Any relay operations for background tasks must be orchestrated by the parent session.

---

## Recommendation

### For Long-Running relay_query (> 120s)

Use the **Tier 2 fire-and-poll pattern**: `relay_send` with `replyTo` set to a persistent inbox, combined with `relay_inbox` polling in subsequent turns. Update `RELAY_TOOLS_CONTEXT` in `context-builder.ts` with guidance:

```
For long-running agent tasks (expected to take more than 2 minutes):
1. Use relay_send() with replyTo pointing to your inbox — do NOT use relay_query
2. Proceed with other work or end the turn
3. In a later turn, poll relay_inbox() — use Bash sleep 30 between polls for slow tasks
4. The reply will be in the inbox when the target agent finishes
```

For tasks under 2 minutes, `relay_query` with `timeout_ms: 120000` remains the preferred single-call pattern.

### For Subagent MCP Access

**Do not expect DorkOS MCP tools to work inside Task-spawned subagents.** Document this constraint clearly in `RELAY_TOOLS_CONTEXT` and `MESH_TOOLS_CONTEXT`:

```
NOTE: relay_* and mesh_* tools are only available in the main agent session.
If you spawn a Task subagent, do not instruct it to call relay or mesh tools —
those tools are not available inside subagents. Perform relay operations in the
main session and pass results to subagents via their prompt.
```

This is the correct architectural boundary: the parent session owns the relay/mesh connection; subagents are context-isolated workers.

---

## Sources

| Source                                                         | URL                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Claude Agent SDK — Subagents                                   | https://platform.claude.com/docs/en/agent-sdk/subagents                  |
| GitHub: Custom subagents cannot access project-scoped MCP      | https://github.com/anthropics/claude-code/issues/13898                   |
| GitHub: Task tool subagents fail MCP with complex prompts      | https://github.com/anthropics/claude-code/issues/14496                   |
| GitHub: Task subagents fail permission inheritance in MCP mode | https://github.com/anthropics/claude-code/issues/5465                    |
| A2A Protocol: Streaming and Async Operations                   | https://a2a-protocol.org/latest/topics/streaming-and-async/              |
| MCP SEP-1686: Tasks primitive                                  | https://github.com/modelcontextprotocol/modelcontextprotocol/issues/1686 |
| Prior research: Agent-to-Agent Reply Patterns                  | research/20260304_agent-to-agent-reply-patterns.md                       |
| DorkOS relay-tools.ts                                          | apps/server/src/services/core/mcp-tools/relay-tools.ts                   |
| DorkOS claude-code-adapter.ts                                  | packages/relay/src/adapters/claude-code-adapter.ts                       |

## Search Methodology

- Searches performed: 6 web searches + 3 WebFetch calls
- Most productive search terms: "Claude Code subagent Task tool MCP server inheritance 2025 2026", "claude agent SDK background task subagent MCP tools access parent session"
- Primary information sources: platform.claude.com (official SDK docs), GitHub anthropics/claude-code issues
- DorkOS source files read: relay-tools.ts (full), prior research files
