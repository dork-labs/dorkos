---
number: 71
title: Implicit Tool Group Hierarchy for User-Facing Toggles
status: accepted
created: 2026-03-04
spec: agent-tools-elevation
superseded-by: null
---

# 71. Implicit Tool Group Hierarchy for User-Facing Toggles

## Status

Accepted

## Context

The MCP tool server has 7 domain groups (Core, Pulse, Relay, Adapter, Binding, Trace, Mesh). Exposing all 7 as separate toggles would create a complex UI. Binding tools are semantically part of the adapter system (they configure adapter-to-agent routing). Trace tools are a Relay subsystem (they query message delivery traces). The question was whether to expose 4, 6, or 7 user-facing toggles.

## Decision

Expose 4 user-facing toggles: Pulse, Relay, Mesh, Adapter. Binding tools implicitly follow the Adapter toggle. Trace tools implicitly follow the Relay toggle. Core tools are always enabled and not toggleable. The `enabledToolGroups` schema in the agent manifest has 4 optional boolean fields matching these 4 domains.

## Consequences

### Positive

- Simpler UX — 4 toggles instead of 6-7
- Semantic grouping is intuitive (bindings are part of adapters, traces are part of relay)
- Fewer fields in the manifest schema

### Negative

- Cannot independently disable bindings while keeping adapters enabled (or trace without relay)
- If binding/trace grow into distinct subsystems, the implicit grouping may need revisiting
- Users who want fine-grained control must accept the domain-level granularity
