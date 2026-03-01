---
number: 52
title: Replace dagre with ELK.js for Topology Layout
status: draft
created: 2026-02-26
spec: mesh-topology-elevation
superseded-by: null
---

# 52. Replace dagre with ELK.js for Topology Layout

## Status

Draft (auto-extracted from spec: mesh-topology-elevation)

## Context

The Mesh topology visualization currently uses dagre for left-to-right layered layout with a hub-spoke model. Hub nodes represent namespaces and spoke edges connect agents to their namespace hub. This flat layout cannot visually group agents inside their namespace — agents float freely with only edges indicating membership. ELK.js (Eclipse Layout Kernel) supports compound/group nodes natively, allowing agents to be positioned inside their namespace container as child nodes.

## Decision

Replace dagre (`^0.8.5`) with ELK.js (`elkjs`) for all topology layout computation. Use ELK's layered algorithm with compound node support to position agent nodes inside namespace group containers. The layout runs asynchronously via `elk.layout()` with a loading skeleton during computation. Configuration: `elk.algorithm: 'layered'`, `elk.direction: 'RIGHT'`, `elk.spacing.nodeNode: 60`. For multi-namespace topologies, namespaces become parent ELK nodes with agents as children. Single-namespace topologies skip the group wrapper.

## Consequences

### Positive

- Agents are visually contained within their namespace — no spoke edges needed
- ELK's compound layout handles cross-group edge routing automatically
- Async layout prevents blocking the main thread for large graphs
- ELK supports more layout algorithms (force, stress) if needed in the future

### Negative

- ~150KB additional bundle size (mitigated by React.lazy() on TopologyGraph)
- Async layout adds a brief loading state on initial render and topology changes
- ELK's API is slightly more complex than dagre's synchronous graph-based API
- dagre is better documented in the React Flow ecosystem; ELK.js + React Flow has fewer community examples
