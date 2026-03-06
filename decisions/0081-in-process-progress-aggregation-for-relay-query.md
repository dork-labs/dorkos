---
number: 81
title: Use In-Process Progress Aggregation for relay_query (MCP Single-Response Constraint)
status: proposed
created: 2026-03-05
spec: relay-inbox-lifecycle
superseded-by: null
---

# 0081. Use In-Process Progress Aggregation for relay_query (MCP Single-Response Constraint)

## Status

Proposed

## Context

MCP tool handlers must return a single `CallToolResult` (array of content blocks) — they cannot stream individual messages. `relay_query` uses a `relay.inbox.query.*` ephemeral inbox and resolves the MCP response when the reply arrives. For 5–10 minute CCA tasks, agents using `relay_query` had no visibility into what the target agent was doing during the wait, because the query inbox previously received only a single aggregated `agent_result` (spec #91 backward-compat contract). Two options were considered: (1) relay_query becomes relay_dispatch internally (non-backward-compat, large change); (2) accumulate progress events in-process and return them in the single MCP response as a `progress[]` field.

## Decision

We change `relay_query`'s subscribe handler from resolve-on-first to resolve-on-done. Messages arriving on `relay.inbox.query.*` that have `type === 'progress' && done === false` are accumulated in a `progressEvents[]` array. Any other message (agent_result with `done: true`, or a plain payload for non-CCA backward compat) triggers resolve with `{ payload, progress: progressEvents, from, id }`. Simultaneously, CCA is updated to publish progress events to all `relay.inbox.*` replyTos (not just `relay.inbox.dispatch.*`), enabling query inboxes to actually receive these events before the final `agent_result`.

## Consequences

### Positive

- Backward compatible: `progress` is an additive field; existing callers destructuring only `reply`, `from`, `replyMessageId` are unaffected.
- Single MCP response contract preserved — relay_query still returns one `CallToolResult`.
- Non-CCA agents that publish a plain reply message still resolve relay_query correctly (`progress` will be an empty array).
- No new MCP tools, no new relay transport patterns.

### Negative

- Progress events accumulate in memory until the promise resolves — bounded at ~20 KB for a 10-minute task, acceptable.
- The spec #91 backward-compat integration test (`'still publishes single agent_result for relay.inbox.query.* replyTo'`) must be updated, as query inboxes now receive progress events + final agent_result.
- relay_query cannot provide real-time streaming visibility (MCP constraint is fundamental); agents needing live streaming must use relay_dispatch.
