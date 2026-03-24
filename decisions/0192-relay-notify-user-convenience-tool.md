---
number: 192
title: High-Level relay_notify_user MCP Tool for Agent-Initiated Messaging
status: draft
created: 2026-03-24
spec: relay-outbound-awareness
superseded-by: null
---

# 192. High-Level `relay_notify_user` MCP Tool for Agent-Initiated Messaging

## Status

Draft (auto-extracted from spec: relay-outbound-awareness)

## Context

DorkOS provides `relay_send` for fire-and-forget messaging, `relay_send_and_wait` for synchronous queries, and `relay_send_async` for long-running dispatches. All three require the agent to know the exact relay subject (e.g., `relay.human.telegram.telegram-lifeos.817732118`). When a user says "message me on Telegram," the agent must resolve the adapter type to a binding, the binding to an active session, and the session to a relay subject — a multi-step reasoning chain that agents frequently get wrong. The alternative of always relying on the `<relay_connections>` context block fails for edge cases where sessions are established after the block was built.

## Decision

Add a `relay_notify_user(message, channel?, agentId)` MCP tool that abstracts the outbound resolution chain. The tool resolves bindings for the given agent, filters by channel (adapter type or ID) if specified, selects the most recently active chat using the BindingRouter's LRU-ordered session map, constructs the relay subject, and publishes via `relayCore.publish()`. When `channel` is omitted, it defaults to the most recently active chat across all bound adapters. On failure, it returns available channels so the agent can retry with a specific target.

## Consequences

### Positive

- One tool call replaces the 5+ fumble sequence documented in transcript 05da5015
- Self-describing name matches natural user intent ("message me on Telegram" → `relay_notify_user`)
- Always uses live data from the session map, handling edge cases the static context block cannot
- Helpful error messages with available channels guide the agent to success

### Negative

- Adds a 4th relay send variant alongside relay_send, relay_send_and_wait, relay_send_async
- Hides the routing decision from the agent — less transparent than composing binding_list_sessions + relay_send
- Requires agentId as a parameter, which the agent must extract from its `<agent_identity>` block
