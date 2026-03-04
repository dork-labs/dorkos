---
number: 68
title: Use Static XML Blocks for Agent Tool Context Injection
status: proposed
created: 2026-03-04
spec: agent-tool-context-injection
superseded-by: null
---

# 68. Use Static XML Blocks for Agent Tool Context Injection

## Status

Proposed

## Context

DorkOS provides 28 MCP tools across relay, mesh, adapter, binding, and trace domains. The `tool()` description strings explain what each tool does, but agents receive no documentation on how to use tools together — subject hierarchy conventions, cross-tool workflow sequences, or naming patterns. Three alternative approaches were considered: (1) static XML blocks in `context-builder.ts`, (2) a `.claude/tool-instructions.md` file loaded by the SDK, and (3) bloating the `tool()` descriptions with workflow guidance.

## Decision

Use static XML string constants (`<relay_tools>`, `<mesh_tools>`, `<adapter_tools>`) injected via the existing `context-builder.ts` → `buildSystemPromptAppend()` → `systemPrompt.append` pipeline. Each block is a module-level constant, conditionally returned by a synchronous builder function gated on feature flags and config toggles. The blocks document subject hierarchy, cross-tool workflows, and naming conventions — information that cannot live in per-tool descriptions.

## Consequences

### Positive

- Zero new abstractions — extends the existing context builder pattern used by `<env>`, `<git_status>`, `<agent_identity>`, and `<agent_persona>`
- Static strings have no per-request allocation or I/O cost
- Testable as pure functions with mocked feature flags
- Content is co-located with all other context injection logic in one file

### Negative

- Content updates require code changes (not user-editable without touching source)
- Content may drift from actual tool definitions if tools are updated without updating the context blocks
- Couples context-builder to relay-state and config-manager modules
