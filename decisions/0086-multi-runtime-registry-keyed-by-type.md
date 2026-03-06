---
number: 86
title: Multi-Runtime Registry Keyed by Type
status: proposed
created: 2026-03-06
spec: agent-runtime-abstraction
superseded-by: null
---

# 86. Multi-Runtime Registry Keyed by Type

## Status

Proposed

## Context

When supporting multiple agent backends, we need a mechanism to resolve which runtime handles a given request. Two approaches were considered: a single active runtime that can be swapped, or a registry holding multiple runtimes simultaneously. DorkOS's Mesh architecture already assigns agents to different backends via the `agent.runtime` field in manifests.

## Decision

Use a `RuntimeRegistry` that holds multiple `AgentRuntime` instances keyed by type string (e.g., 'claude-code', 'opencode'). The registry has a default runtime for unqualified requests and a `resolveForAgent()` method that looks up an agent's manifest to determine which runtime to use.

## Consequences

### Positive

- Different agents can use different backends simultaneously (matches Mesh architecture)
- Adding a runtime is additive — register it and agents can opt in
- Default runtime ensures backward compatibility

### Negative

- Slightly more complex than a single-runtime approach
- Must handle edge cases where an agent references an unregistered runtime
