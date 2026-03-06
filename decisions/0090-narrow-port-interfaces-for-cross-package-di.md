---
number: 90
title: Narrow Port Interfaces for Cross-Package DI
status: proposed
created: 2026-03-06
spec: agent-runtime-review-remediation
superseded-by: null
---

# 0090. Narrow Port Interfaces for Cross-Package DI

## Status

Proposed

## Context

The `AgentRuntime` interface in `@dorkos/shared` needs to accept `MeshCore` and `RelayCore` instances for dependency injection, but importing those concrete types would create circular dependencies between packages (`shared` cannot depend on `mesh` or `relay`). The original implementation used `unknown` types for `setMeshCore()` and `setRelay()`, which compiled but provided zero type safety at call sites — any object could be passed without error.

## Decision

Define narrow "port" interfaces in `@dorkos/shared` that capture only the methods the runtime actually calls: `AgentRegistryPort` (for mesh operations) and `RelayPort` (for relay operations). TypeScript's structural typing means `MeshCore` and `RelayCore` satisfy these interfaces without `implements` clauses — no circular imports needed, and call sites get full type checking.

## Consequences

### Positive

- Full type safety at DI call sites — passing the wrong object is a compile error
- No circular package dependencies — port interfaces live in `@dorkos/shared`
- Self-documenting — the port interface declares exactly what the runtime needs from each dependency
- Follows hexagonal architecture port principle — the application layer defines what it needs

### Negative

- Port interfaces must be maintained in sync with actual runtime usage — adding a new method call requires updating the port
- Two sources of truth for the contract (port interface + concrete class) — though TypeScript will flag mismatches at compile time
