---
number: 46
title: Use Central BindingRouter for Adapter-Agent Routing
status: draft
created: 2026-02-28
spec: adapter-agent-routing
superseded-by: null
---

# 46. Use Central BindingRouter for Adapter-Agent Routing

## Status

Draft (auto-extracted from spec: adapter-agent-routing)

## Context

DorkOS has a working adapter system (Telegram, Webhooks, plugin-based) and an agent identity system, but no routing layer connects them. Adapters publish to `relay.human.*` subjects but nothing resolves which agent should handle those messages. Three approaches were considered: (1) adapter-side routing where each adapter resolves its own target, (2) relay-core integration baked into the publish pipeline, (3) a central BindingRouter service that intercepts and re-routes messages.

## Decision

Implement a central BindingRouter service inside `packages/relay/` that subscribes to `relay.human.*`, resolves adapter-to-agent bindings from a BindingStore, and republishes messages to `relay.agent.*` for ClaudeCodeAdapter to handle. Adapters remain dumb protocol bridges; all routing logic is centralized in one service. The BindingRouter manages session lifecycle (create/resume) based on configurable per-binding session strategies.

## Consequences

### Positive

- Single point of routing logic — easy to debug, test, and extend
- Adapters stay simple (protocol bridges only), reducing per-adapter complexity
- Session strategy is configurable per binding without adapter changes
- Binding table is inspectable and modifiable at runtime

### Negative

- Single point of failure — if BindingRouter is down, no messages route
- Extra hop in the message path (adapter → BindingRouter → ClaudeCodeAdapter)
- BindingRouter must understand all subject patterns used by adapters
