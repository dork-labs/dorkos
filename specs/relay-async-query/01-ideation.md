---
slug: relay-async-query
number: 90
created: 2026-03-04
status: ideation
---

# Relay Async Dispatch + CCA Streaming Progress

**Slug:** relay-async-query
**Author:** Claude Code
**Date:** 2026-03-04
**Branch:** preflight/relay-async-query

---

## 1) Intent & Assumptions

- **Task brief:** `relay_send_and_wait` has a 120s hard maximum. Agent-to-agent tasks can take 20+ minutes. The current all-at-once delivery model means Agent A sees nothing until Agent B's entire session finishes. We need: (a) a non-blocking dispatch tool that returns immediately, (b) CCA streaming progress updates so Agent A can poll for incremental results, and (c) a raised timeout cap on `relay_send_and_wait` for medium-duration tasks. Additionally, agents that try to use relay/mesh tools inside a Claude Code `Task()` subagent silently fail — this needs to be documented with the correct orchestrator pattern.

- **Assumptions:**
  - The relay subject schema (`relay.agent.{agentId}`, `relay.inbox.*`) is unchanged
  - CCA's per-agent concurrency queue remains the serialization mechanism
  - Polling (not WebSocket/SSE push to the calling agent) is the right model for async result retrieval
  - Agent B's SDK session may emit many events (tool calls, messages); CCA decides granularity of progress publishes
  - Ephemeral dispatch inboxes require explicit caller cleanup (no server-side TTL for MVP)

- **Out of scope:**
  - Making DorkOS MCP tools available inside SDK subagents (SDK architectural limitation — tracked in Anthropic issues #13898, #14496, #5465)
  - Push-based notification to Agent A's session (no "interrupt" mechanism in current relay)
  - Persisting in-flight dispatch jobs across server restarts
  - Streaming individual text deltas (too granular; progress per tool-completion or message-completion is the right level)

---

## 2) Pre-reading Log

- `research/20260304_agent-to-agent-reply-patterns.md`: Prior research recommending relay_send_and_wait (already implemented) and fire-and-poll as the long-running fallback. Google's A2A protocol recommends the job-ID pattern for long-horizon work.
- `research/20260304_relay_async_query_and_subagent_mcp.md`: New research confirming fire-and-poll is the right pattern; subagent MCP access is a confirmed SDK bug (multiple GitHub issues), not a DorkOS fixable problem.
- `apps/server/src/services/core/mcp-tools/relay-tools.ts`: relay_send_and_wait fully implemented using EventEmitter subscribe. 120s max on line 265. Five relay tools total.
- `packages/relay/src/adapters/claude-code-adapter.ts`: CCA collects all text via `collectedText += delta.text`, publishes ONE aggregated result via `publishAgentResult()` after session ends. Progress streaming requires publishing intermediate updates to `envelope.replyTo` during the session.
- `apps/server/src/services/core/agent-manager.ts`: MCP factory injected via `setMcpServerFactory()` called on each `sendMessage()`. Subagents spawn in separate subprocess — factory is NOT inherited.
- `packages/relay/src/relay-core.ts`: `subscribe(pattern, handler)` is a thin wrapper over SubscriptionRegistry (in-memory EventEmitter2). Fires synchronously on `publish()` delivery — no polling.
- `apps/server/src/services/relay/agent-session-store.ts`: JSON-file persistence pattern (tmp+rename atomic write). Template for any new lightweight persistent stores.
- `apps/server/src/services/relay/trace-store.ts`: SQLite trace table alongside `relay/index.db`. Template for job-state persistence if needed in future.

---

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/server/src/services/core/mcp-tools/relay-tools.ts` — relay MCP tool definitions. `createRelayQueryHandler` contains the subscribe/Promise pattern. New `createRelayDispatchHandler` goes here.
- `apps/server/src/services/core/mcp-tools/index.ts` — `createDorkOsToolServer()` composes all tools. Add relay_send_async registration here.
- `packages/relay/src/adapters/claude-code-adapter.ts` — CCA delivery bridge. `handleAgentMessage()` is where streaming progress publishes need to be added. `publishAgentResult()` is the existing final-publish helper.
- `apps/server/src/services/core/context-builder.ts` — `RELAY_TOOLS_CONTEXT` static string. Needs three updates: (1) document relay_send_async workflow, (2) raise timeout guidance for relay_send_and_wait, (3) add subagent MCP constraint warning.
- `apps/server/src/services/core/tool-filter.ts` — `RELAY_TOOLS` constant. relay_send_async must be added here.
- `apps/server/src/services/core/__tests__/mcp-tool-server.test.ts` — tool count test (currently 14). Will become 15.
- `apps/server/src/services/core/__tests__/tool-filter.test.ts` — relay tool inclusion/exclusion tests.
- `packages/relay/src/__tests__/relay-cca-roundtrip.test.ts` — integration tests for CCA delivery. Progress streaming needs coverage here.

**Shared Dependencies:**

- `packages/relay/src/relay-core.ts` — `RelayCore.subscribe()`, `publish()`, `registerEndpoint()`, `unregisterEndpoint()`. CCA calls `this.relay.publish()` for progress updates.
- `packages/relay/src/subscription-registry.ts` — underlying EventEmitter2 pub/sub.
- `packages/relay/src/adapter-delivery.ts` — `AdapterDelivery` routes published messages to CCA via `deliver()`.
- `@dorkos/shared/relay-schemas` — `RelayEnvelope` type. Progress payload type should be defined here.

**Data Flow (current — all-at-once):**

```
Agent A: relay_send_and_wait(to_subject="relay.agent.{B}", timeout=120s)
  → relay.registerEndpoint(ephemeral inbox)
  → relay.publish("relay.agent.{B}", replyTo=ephemeral inbox)
  → relay.subscribe(ephemeral inbox, resolve)
  → await Promise (120s max)
  ← [120s later or when B finishes]
  ← CCA publishAgentResult → relay.publish(ephemeral inbox, { type:'agent_result', text })
  ← Promise resolves → return { reply, from, ... }
```

**Data Flow (proposed — async dispatch + streaming):**

```
Agent A: relay_send_async(to_subject="relay.agent.{B}")
  → relay.registerEndpoint("relay.inbox.dispatch.{UUID}")
  → relay.publish("relay.agent.{B}", replyTo="relay.inbox.dispatch.{UUID}")
  ← return immediately: { messageId, inboxSubject: "relay.inbox.dispatch.{UUID}" }

[Agent B's session runs — CCA publishes incremental progress:]
  → [each AssistantMessage or tool_result]: relay.publish(inboxSubject, {type:'progress', step:N, text:'...', done:false})
  → [session end]: relay.publish(inboxSubject, {type:'agent_result', text:'...full...', done:true})

Agent A (polling): relay_inbox(endpoint_subject="relay.inbox.dispatch.{UUID}")
  ← receives progress messages + final result
  → when done:true received: relay_unregister_endpoint (cleanup)

  OR Agent A: relay_send_and_wait (still works for ≤10 min tasks, raised timeout)
```

**Feature Flags/Config:**

- `DORKOS_RELAY_ENABLED` — relay tools gated behind this (relay_send_async follows same gate)
- `tool-filter.ts` `RELAY_TOOLS` — relay_send_async must be in this list

**Potential Blast Radius:**

- Direct: 6 files (relay-tools.ts, mcp-tools/index.ts, claude-code-adapter.ts, context-builder.ts, tool-filter.ts, relay-schemas.ts)
- Tests: 3 test files (mcp-tool-server.test.ts, tool-filter.test.ts, relay-cca-roundtrip.test.ts)
- Indirect: relay_list_endpoints (dispatch inboxes will appear in the list), relay_unregister_endpoint behavior

---

## 4) Root Cause Analysis

Not a bug fix. Enhancement driven by a real constraint:

- **relay_send_and_wait max timeout = 120s** (line 265 in relay-tools.ts: `.max(120000)`)
- **Real agent task duration = 20+ minutes** (20× the hard limit)
- **CCA publish model = all-at-once** (claude-code-adapter.ts: collects all `collectedText`, publishes once after session ends)
- **Result**: Agents doing long research, code generation, or analysis tasks can never use relay_send_and_wait successfully; they silently time out.

The three gaps compound each other:

1. No way to dispatch without blocking
2. No progress visibility during the wait
3. Even if you extend the timeout, blocking 10+ min on a synchronous tool call is an anti-pattern

---

## 5) Research

**Potential solutions analyzed:**

1. **relay_send_async + polling (recommended)** — fire and return job token. Agent polls with relay_inbox. Simple, composable, matches Google A2A "Tasks" primitive. No changes to existing relay_send_and_wait semantics.
   - Pros: immediate return, agents retain control, composable with existing relay_inbox tool, no new SDK interaction
   - Cons: caller must manage polling loop, inbox must be manually cleaned up, no push notification

2. **Raise relay_send_and_wait timeout** — change `.max(120000)` to `.max(600000)`. Covers medium-duration tasks (5-10 min).
   - Pros: zero new APIs, no behavior change
   - Cons: doesn't solve 20-min tasks, blocking for 10 min is still bad practice

3. **CCA progress streaming** — publish incremental updates to replyTo during Agent B's session.
   - Pros: Agent A sees real-time progress, can detect stuck agents, meaningful partial results
   - Cons: more CCA changes, progress payload type needs definition, relay_inbox must handle multi-message sequences

4. **Full job store with relay_job_status** — SQLite persistence, relay_job_list/relay_job_status tools.
   - Pros: queryable history, survives server restarts, observable by operators
   - Cons: significantly more complex, overkill for MVP

5. **Subagent MCP access** — not a solution path. SDK architectural limitation (confirmed Anthropic issues #13898, #14496, #5465). No DorkOS-side fix available.

**Recommendation:** Combine (1) + (2) + (3). relay_send_async covers the long-running case; relay_send_and_wait timeout raised to 10 min covers medium tasks; CCA progress streaming gives Agent A visibility; documentation warns about subagent MCP limitation.

---

## 6) Decisions

| #   | Decision                        | Choice                                                                                                                 | Rationale                                                                                                                                                        |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Async dispatch API design       | New `relay_send_async` tool (separate, explicit)                                                                       | Clean mental model: relay_send=fire-forget, relay_send_and_wait=short-sync, relay_send_async=long-async. Avoids overloading existing tool semantics.             |
| 2   | relay_send_and_wait timeout cap | Raise from 120s to 600s (10 min)                                                                                       | Covers medium-duration tasks without pushing to the full async pattern. Still disciplined — agents with truly long tasks use relay_send_async.                   |
| 3   | Progress updates from Agent B   | Full streaming: CCA publishes intermediate updates per AssistantMessage/tool_result                                    | Agent A can see real-time progress, detect stuck agents, and act on partial results. 20-min black-box is unacceptable for production agent systems.              |
| 4   | Subagent MCP limitation         | Document constraint + orchestrator pattern in RELAY_TOOLS_CONTEXT                                                      | Can't fix architecturally. Documenting prevents wasted tool calls and silent failures. Pattern: parent does relay/mesh work, injects results into Task() prompt. |
| 5   | relay_send_async inbox cleanup  | Caller-initiated (no server-side TTL)                                                                                  | Simplest for MVP. Caller reads `done:true` and calls relay_unregister_endpoint. Future enhancement: TTL-based auto-cleanup.                                      |
| 6   | Progress payload schema         | `{ type: 'progress', step: number, text: string, done: false }` / `{ type: 'agent_result', text: string, done: true }` | Distinguishable from final result; `done` flag allows Agent A to know when to stop polling without parsing content.                                              |

---

## 7) Open Implementation Questions

1. **Progress granularity in CCA**: Publish after every `AssistantMessage` completion, or also after each `tool_result`? Tool results give better visibility but more messages. Recommended: both, with a `step_type: 'message' | 'tool_result'` field.

2. **relay_send_async inbox subject namespace**: `relay.inbox.dispatch.{UUID}` or `relay.inbox.query.{UUID}` (already used by relay_send_and_wait)? Separate namespace `relay.inbox.dispatch.*` is cleaner for filtering.

3. **relay_send_async rejection handling**: Same early-return logic as relay_send_and_wait when `deliveredTo === 0 && rejected.length > 0`? Yes — but in this case the registered inbox must also be unregistered on early return.

4. **Impact on relay_list_endpoints**: Dispatch inboxes will appear in the endpoint list while open. Should they be filterable? Consider adding a `type: 'dispatch' | 'persistent'` field to endpoint metadata in a future pass.

5. **relay_unregister_endpoint**: Does this tool already exist? If not, CCA callers have no way to clean up dispatch inboxes. Check whether it's already in `getRelayTools()`. (It's not in the current 5-tool set — needs to be added or documented as a gap.)

---

## 8) Next Steps

Run `/ideate-to-spec specs/relay-async-query/01-ideation.md` to produce the full specification.
