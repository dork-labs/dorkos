---
number: 50
title: Agent Identity Independent of Mesh Feature Flag
status: draft
created: 2026-02-26
spec: agents-first-class-entity
superseded-by: null
---

# 50. Agent Identity Independent of Mesh Feature Flag

## Status

Draft (auto-extracted from spec: agents-first-class-entity)

## Context

Agent identity (name, description, persona, visual identity) is a core UX concept that should be available to all DorkOS users. Currently, agent-related API endpoints are behind `DORKOS_MESH_ENABLED`, which controls the full Mesh subsystem (discovery, registry, topology, health monitoring). Users who only want to name their agents and set personas should not need to enable the entire Mesh stack with its SQLite database, periodic reconciliation, and network topology features.

## Decision

Create a new `/api/agents` route group that is always mounted (not behind any feature flag). These lightweight endpoints read/write `.dork/agent.json` files directly via `readManifest()`/`writeManifest()` from `@dorkos/shared/manifest`. The existing `/api/mesh/agents` routes remain behind the Mesh flag for registry, health, and topology operations. The context-builder persona injection also reads manifests directly, not through Mesh.

## Consequences

### Positive

- Every DorkOS user gets agent identity, visual identity, and persona injection out of the box
- Mesh remains an opt-in advanced feature for multi-agent coordination
- Simpler mental model: "agents are always available, Mesh adds coordination"

### Negative

- Two route groups serve agent data (`/api/agents` and `/api/mesh/agents`) with partially overlapping concerns
- When Mesh IS enabled, agent updates via `/api/agents/current` must also be reconciled into the Mesh registry (handled by existing periodic reconciliation)
