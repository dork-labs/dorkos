---
number: 82
title: Unify Discovery Scanners into Single Implementation
status: proposed
created: 2026-03-06
spec: unify-discovery-system
superseded-by: null
---

# 82. Unify Discovery Scanners into Single Implementation

## Status

Proposed

## Context

Two independent BFS filesystem scanners existed for agent discovery: Scanner A (standalone in `apps/server/`) with timeout support, progress events, and 14 exclude patterns, and Scanner B (in `packages/mesh/`) with pluggable DiscoveryStrategy instances, registry/denial filtering, and symlink cycle detection. Both performed the same fundamental task — scanning directories for AI agent markers — but with different feature sets, different type definitions, and different consumption patterns (SSE streaming vs. batch JSON).

## Decision

Create a single unified scanner in `packages/mesh/src/discovery/` that combines the best of both implementations: Scanner B's strategy pattern and registered/denied path filtering with Scanner A's timeout support, progress events, and comprehensive exclude list. The unified scanner yields typed `ScanEvent` objects (candidate, auto-import, progress, complete) as an async generator. All consumers (SSE endpoint, batch endpoint, MCP tools, DirectTransport) use this single scanner.

## Consequences

### Positive

- Single source of truth for discovery logic eliminates DRY violations
- All consumers benefit from all features (timeout, progress, filtering, strategies)
- Scanner lives in `packages/mesh/` making it importable by both server and Obsidian plugin
- Canonical `DiscoveryCandidate` type from `@dorkos/shared` used everywhere

### Negative

- Breaking internal API change to `MeshCore.discover()` return type (ScanEvent instead of DiscoveryCandidate)
- Callers that only want candidates must filter for `event.type === 'candidate'`
- Unified exclude set is larger, potentially skipping directories one scanner would have traversed
