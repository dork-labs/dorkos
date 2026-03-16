---
number: 136
title: Hybrid Hook Event Routing by hook_event Field
status: draft
created: 2026-03-16
spec: hook-lifecycle-events
superseded-by: null
---

# 136. Hybrid Hook Event Routing by hook_event Field

## Status

Draft (auto-extracted from spec: hook-lifecycle-events)

## Context

The Claude Agent SDK emits three hook lifecycle messages (`hook_started`, `hook_progress`, `hook_response`) for user-configured hooks. Hooks fire in two contexts: around tool execution (`PreToolUse`, `PostToolUse`, `PostToolUseFailure`) and at session lifecycle boundaries (`SessionStart`, `UserPromptSubmit`, `PreCompact`, etc.). These two contexts have fundamentally different user expectations — tool hooks are causally linked to a specific tool call, while session hooks are ambient system events.

Four approaches were evaluated: (1) all hooks as ToolCallCard sub-rows, (2) all hooks as standalone cards, (3) all hooks as ephemeral SystemStatusZone messages, (4) hybrid routing based on the `hook_event` field.

## Decision

Route hook events based on the `hook_event` field using a `TOOL_CONTEXTUAL_HOOK_EVENTS` set containing `PreToolUse`, `PostToolUse`, and `PostToolUseFailure`. Tool-contextual hooks render as sub-rows inside the associated `ToolCallCard`, correlated via `toolState.currentToolId`. Session-level hooks route through the existing `system_status` event for success and escalate to the `error` event type on failure.

## Consequences

### Positive

- Tool hooks maintain clear causal relationship with their triggering tool call
- No new top-level component needed — extends existing `ToolCallCard` and `SystemStatusZone`
- Session-level hook failures get persistent error visibility via the existing error banner
- Routing decision is a simple set lookup on a known SDK field

### Negative

- Two code paths in the mapper for hook events (tool-contextual vs session-level)
- Tool-hook correlation relies on temporal proximity (`toolState.currentToolId`), requiring an orphan buffer for `PreToolUse` hooks that arrive before `tool_call_start`
- Session-level hook progress is silently dropped (no UI for mid-execution output of session hooks)
