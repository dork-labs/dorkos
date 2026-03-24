---
number: 191
title: Dynamic <relay_connections> Context Block for Agent Outbound Awareness
status: draft
created: 2026-03-24
spec: relay-outbound-awareness
superseded-by: null
---

# 191. Dynamic `<relay_connections>` Context Block for Agent Outbound Awareness

## Status

Draft (auto-extracted from spec: relay-outbound-awareness)

## Context

DorkOS agents receive static XML context blocks (`<relay_tools>`, `<adapter_tools>`, `<peer_agents>`) in their system prompt via `context-builder.ts`. These blocks document tool workflows and available peers, but contain no information about which adapters are bound to the current agent or which chats are active. When a user says "message me on Telegram" from a non-relay source, the agent has no way to discover the correct relay subject without 5+ failed MCP tool calls. The session map data exists in `BindingRouter.sessionMap` but is completely inaccessible to agents.

## Decision

Add a dynamic `<relay_connections>` XML block to the system prompt that lists the agent's bound adapters, their connection status, active chat subjects, and a ready-to-use `relay_send` template. Unlike the existing static blocks (ADR-0068), this block queries live data from `BindingStore`, `BindingRouter`, and `AdapterManager` at prompt-build time. The `buildSystemPromptAppend()` signature is expanded with an optional `relayContext` parameter following the existing `meshCore` pattern. The block degrades gracefully — returning empty string when no bindings exist, relay is disabled, or adapter tools are toggled off (ADR-0069 dual-gate pattern).

## Consequences

### Positive

- Agents know their communication channels with zero discovery tool calls (>95% of outbound messaging cases)
- Follows the established context builder pattern (ADR-0051, ADR-0068)
- ~150-200 tokens per block — negligible overhead on 50K+ token system prompts
- Backward compatible — existing call sites pass `undefined` for relayContext

### Negative

- First dynamic (non-static) context block — reads from three services at prompt-build time, unlike the pure-string constants used by `<relay_tools>` and `<adapter_tools>`
- Session data is snapshot-scoped — chats established after the block was built won't appear until the next session resume
- Requires threading `BindingRouter`, `BindingStore`, and `AdapterManager` through to `message-sender.ts`
