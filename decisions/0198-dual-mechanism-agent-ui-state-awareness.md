---
number: 198
title: Dual-Mechanism Agent UI State Awareness — Context Injection + Tool Query
status: draft
created: 2026-03-26
spec: ext-platform-01-agent-ui-control
superseded-by: null
---

# 0198. Dual-Mechanism Agent UI State Awareness — Context Injection + Tool Query

## Status

Draft (auto-extracted from spec: ext-platform-01-agent-ui-control)

## Context

For the `control_ui` tool to be useful, the agent needs to know the current UI state — which panels are open, whether the canvas is showing, which sidebar tab is active. Three approaches were considered: (1) context injection into the system prompt at turn start, (2) a `get_ui_state` tool for on-demand queries, (3) defer entirely. The key constraint: SDK context is frozen at turn start and does not update mid-turn, so context injection alone cannot reflect state changes made by the agent during a turn.

## Decision

Use both mechanisms. Client sends a UI state snapshot as metadata with each `sendMessage()` call. Server injects this into the agent's system prompt at turn start (~200 bytes). Additionally, a `get_ui_state` tool allows the agent to query current state mid-turn — essential after the agent has issued `control_ui` commands and needs to verify the result or chain further UI decisions.

## Consequences

### Positive

- Agent always knows the UI state at turn start (90% case) without consuming a tool call
- Agent can verify UI changes mid-turn (10% case) via explicit tool query
- Consistent schema between injected context and tool response — same `UiState` type
- Transport already supports `options` parameter — extending with `uiState` is low-friction

### Negative

- Two code paths for state delivery (injection vs tool) — must keep schemas synchronized
- Client must snapshot and send state with every message (minor overhead)
- `get_ui_state` mid-turn returns the state as of the last message, not real-time — adequate for v1 but may need a real-time sync mechanism if latency becomes an issue
