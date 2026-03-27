---
number: 195
title: Hybrid Agent UI Control — Explicit Tool + Minimal Implicit Side-Effects
status: draft
created: 2026-03-26
spec: ext-platform-01-agent-ui-control
superseded-by: null
---

# 0195. Hybrid Agent UI Control — Explicit Tool + Minimal Implicit Side-Effects

## Status

Draft (auto-extracted from spec: ext-platform-01-agent-ui-control)

## Context

DorkOS agents need to control the host application's UI — opening panels, showing notifications, displaying content in a canvas pane. Industry patterns fall into two camps: Cursor uses primarily implicit side-effects (file created → file opens in editor), while CopilotKit uses explicit tool calls for all UI actions. Both have trade-offs: implicit feels magical but is unpredictable for novel actions; explicit is precise but verbose for common operations.

## Decision

Use a hybrid approach: an explicit `control_ui` tool with 14 action variants for direct agent control, plus exactly two implicit side-effects for universally expected behaviors (scroll-to-bottom on new message, error toast on stream error). The implicit list is deliberately minimal and static — resist growth. All other UI reactions require the agent to explicitly call the tool.

## Consequences

### Positive

- Agent has full programmatic control over the UI for novel actions (canvas, panels, toasts)
- Common behaviors (scroll, error notification) feel natural without agent involvement
- Implicit list is small enough to reason about exhaustively — no hidden coupling surprises
- Extensible: new action types can be added to the union without changing the architecture

### Negative

- Two code paths to maintain (explicit dispatcher + implicit observers), though the implicit path is trivially small
- Agent must learn to use the `control_ui` tool — adds to system prompt size
- If the implicit list grows over time, it becomes harder to predict UI behavior
