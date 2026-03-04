---
number: 62
title: Remove Mesh Feature Flag — Make Mesh Always-On
status: proposed
created: 2026-03-03
spec: agent-centric-ux
superseded-by: null
---

# 62. Remove Mesh Feature Flag — Make Mesh Always-On

## Status

Proposed

## Context

The Mesh agent registry is gated behind `DORKOS_MESH_ENABLED`, a feature flag that defaults to `false` in the env var schema but `true` in the config schema. This mismatch causes confusion. The new global command palette depends on `useMeshAgentPaths()` to list agents, making the registry a prerequisite for the core UX. ADR-0043 confirms the filesystem is canonical and the SQLite index can always rebuild, so there is no risk from always initializing MeshCore. ADR-0054 already proposed inverting feature flags to enabled-by-default.

## Decision

Remove the `DORKOS_MESH_ENABLED` environment variable and `mesh.enabled` config field entirely. MeshCore initializes unconditionally at server startup. The existing try/catch and `setMeshInitError()` pattern remains for graceful degradation if SQLite fails. Client-side `useMeshEnabled()` returns `true` unconditionally.

## Consequences

### Positive

- Eliminates the env var / config schema default mismatch
- Enables the command palette to always have agent data
- Reduces ~50 lines of conditional initialization code
- Simplifies ~8 test files that mock the feature flag

### Negative

- Users who explicitly disabled Mesh lose that option (mitigated: Mesh was already defaulting to on in config)
- MeshCore initialization (~50ms) runs even if no agents exist (negligible cost)
