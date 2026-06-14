---
number: 281
title: Ship /flow as a DorkOS Marketplace Plugin-Type Package from P1
status: proposed
created: 2026-06-14
spec: unified-workflow-system
superseded-by: null
---

# 281. Ship /flow as a DorkOS Marketplace Plugin-Type Package from P1

## Status

Proposed

## Context

The system should be one identifiable installable unit and eventually a Claude Code / DorkOS plugin, without a later rewrite to extract it.

## Decision

Build `.agents/flow/` as a DorkOS marketplace `plugin`-type package from Phase 1, embedding a `.claude-plugin/plugin.json` via `requiresClaudePlugin()`. v1 contributes commands/skills/hooks/templates with no `extensions` layer (that server layer is P5). `.agents/` stays the cross-harness glue; the harness manifest syncs skills only, while commands and hooks remain Claude-native (registered, not synced).

## Consequences

### Positive

- One identifiable installable unit on day one; on-mission dogfooding of our own package format.
- Extracting the later product extension is additive, not a rewrite.

### Negative

- Packaging overhead in v1.
- A fully self-contained, fully-synced `.agents/flow/` is the plugin end-state, not the v1 layout.
