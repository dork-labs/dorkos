---
number: 78
title: CCA Dispatch Streaming Gated on relay.inbox.dispatch.* Prefix
status: draft
created: 2026-03-05
spec: relay-async-query
superseded-by: null
---

# 78. CCA Dispatch Streaming Gated on relay.inbox.dispatch.\* Prefix

## Status

Draft (auto-extracted from spec: relay-async-query)

## Context

ClaudeCodeAdapter (CCA) routes two types of replyTo inbox addresses: `relay.inbox.query.*` (used by relay_query's EventEmitter subscribe pattern) and the new `relay.inbox.dispatch.*` (used by relay_dispatch's polling pattern). relay_query resolves its Promise on the first message delivered to the inbox — if CCA streams multiple progress events there, relay_query would resolve prematurely on the first progress event rather than the final agent_result, breaking backward compatibility. The streaming vs. aggregation behavior must be discriminated at the inbox subject prefix level.

## Decision

In `handleAgentMessage()`, CCA checks `envelope.replyTo` for the `relay.inbox.dispatch.` prefix. If present, CCA publishes incremental progress events (`{ type: 'progress', step, step_type: 'message'|'tool_result', text, done: false }`) at each AssistantMessage text completion and tool*result, followed by a final `{ type: 'agent_result', text, done: true }`. All other `relay.inbox.*` addresses (including `relay.inbox.query.*`) continue to receive a single aggregated `agent_result` after session completion. Non-inbox replyTo addresses (relay.agent.*, relay.human.\_) continue to receive raw StreamEvent streaming as before.

## Consequences

### Positive

- relay_query inbox behavior is completely unchanged — full backward compatibility
- Clean prefix-based dispatch; no additional envelope metadata required
- Agent A receives real-time visibility into Agent B's work during long-running tasks
- `done: true` flag on agent_result is a simple, unambiguous terminal signal

### Negative

- CCA must buffer partial AssistantMessage text until a `tool_call_start` or `done` event signals message completion — slightly more stateful than current logic
- The `relay.inbox.dispatch.*` namespace is now a behavioral contract; renaming it would require a migration
- Progress events are best-effort; if the server restarts mid-session, in-flight progress is lost (acceptable for MVP)
