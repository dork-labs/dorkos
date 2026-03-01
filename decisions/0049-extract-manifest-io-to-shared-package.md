---
number: 49
title: Extract Agent Manifest I/O to Shared Package
status: draft
created: 2026-02-26
spec: agents-first-class-entity
superseded-by: null
---

# 49. Extract Agent Manifest I/O to Shared Package

## Status

Draft (auto-extracted from spec: agents-first-class-entity)

## Context

The agent manifest file I/O functions (`readManifest`, `writeManifest`, `removeManifest`) currently live in `packages/mesh/src/manifest.ts`. These functions are pure filesystem operations with zero dependencies on Mesh, Drizzle, or SQLite. However, their location in the Mesh package forces any consumer of agent identity to depend on `@dorkos/mesh`, even when Mesh features are disabled. The new agent-first-class feature needs the server to read agent manifests for the `/api/agents` routes and `context-builder.ts` persona injection, independently of the Mesh subsystem.

## Decision

Move `readManifest()`, `writeManifest()`, `removeManifest()`, and associated constants (`MANIFEST_DIR`, `MANIFEST_FILE`) from `packages/mesh/src/manifest.ts` to `packages/shared/src/manifest.ts`. Export via `@dorkos/shared/manifest`. The Mesh package re-exports from shared to preserve existing imports.

## Consequences

### Positive

- Agent identity features (sidebar, persona injection, API) work without `DORKOS_MESH_ENABLED`
- Clean dependency graph: server routes import from `@dorkos/shared`, not `@dorkos/mesh`
- No breaking changes to existing Mesh imports (re-export preserves API)

### Negative

- Shared package gains a `node:fs/promises` dependency (already present via other modules)
- Slightly more complex package exports in `@dorkos/shared`
