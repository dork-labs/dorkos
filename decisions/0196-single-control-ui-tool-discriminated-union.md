---
number: 196
title: Single control_ui Tool with Discriminated Union Action Schema
status: draft
created: 2026-03-26
spec: ext-platform-01-agent-ui-control
superseded-by: null
---

# 0196. Single control_ui Tool with Discriminated Union Action Schema

## Status

Draft (auto-extracted from spec: ext-platform-01-agent-ui-control)

## Context

Agent tool schema design for UI control had two viable approaches: a single `control_ui` tool with a discriminated union on the `action` field (14 variants), or 14 separate tools (`open_panel`, `close_panel`, `show_toast`, etc.). MCP tool design guidance (Workato) recommends single-purpose tools, but this targets domain CRUD operations, not unified control surfaces.

## Decision

Use a single `control_ui` tool with a Zod discriminated union on the `action` field. The tool description enumerates all 14 variants with their parameters. A companion `get_ui_state` tool reads current state.

## Consequences

### Positive

- Token-efficient: one tool description in the system prompt instead of 14
- Conceptually honest: these are all "UI control" actions, not independent operations
- Matches industry practice: CopilotKit and AG-UI both use single-tool-with-union for UI actions
- Additive: new variants added to the union don't require new tool registration

### Negative

- Tool description is longer and more complex than any single-purpose tool would be
- LLM must parse the discriminated union schema correctly (mitigated by rich description)
- If any single action needs special server-side handling (e.g., validation, side-effects), the handler grows in complexity
