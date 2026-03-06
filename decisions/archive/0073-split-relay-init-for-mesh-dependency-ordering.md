---
number: 73
title: Split Relay Initialization for meshCore Dependency Ordering
status: draft
created: 2026-03-04
spec: fix-relay-agent-routing-cwd
superseded-by: null
---

# 73. Split Relay Initialization for meshCore Dependency Ordering

## Status

Draft (auto-extracted from spec: fix-relay-agent-routing-cwd)

## Context

The server's `index.ts` initializes subsystems in a single sequential pass. The relay subsystem
(RelayCore + TraceStore + AdapterManager) was initialized in one monolithic `if (relayEnabled)` block.
MeshCore was always-on and initialized after the relay block. This meant AdapterManager was
constructed before MeshCore existed, making it impossible to inject meshCore as a dependency.

## Decision

Split the relay initialization into two phases with MeshCore initialization interleaved:

1. **Phase A** (inside `if (relayEnabled)`): Initialize AdapterRegistry, TraceStore, and RelayCore.
2. **Phase B** (always-on): Initialize MeshCore with the now-available RelayCore reference.
3. **Phase C** (back inside `if (relayEnabled)`): Initialize AdapterManager with both RelayCore and MeshCore.

MeshCore has no dependency on AdapterManager, making this reorder safe.

## Consequences

### Positive

- AdapterManager can receive meshCore as a constructor dependency, fixing agent-to-agent routing.
- The initialization order is now explicitly documented in code (comments explain why phases are ordered as they are).
- No circular dependencies introduced.

### Negative

- The relay initialization block is no longer contiguous, which slightly complicates reading `index.ts`.
- Future developers adding subsystems must be aware of the phase boundary.
