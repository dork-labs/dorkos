---
number: 35
title: Use @xyflow/react (React Flow v12) for Mesh Topology Visualization
status: draft
created: 2026-02-25
spec: mesh-observability-lifecycle
superseded-by: null
---

# 35. Use @xyflow/react (React Flow v12) for Mesh Topology Visualization

## Status

Draft (auto-extracted from spec: mesh-observability-lifecycle)

## Context

The Mesh observability layer needs a network graph visualization showing agents as nodes with health status indicators, runtime badges, and interactive click-to-inspect behavior. Evaluated five options: @xyflow/react (React Flow v12), Cytoscape.js, Sigma.js, vis-network, and custom SVG with d3-force. The network is small (10-50 agents max, single-machine DorkOS).

## Decision

Use `@xyflow/react` (React Flow v12) with dagre layout for the topology graph. Custom nodes are plain React components, enabling direct embedding of shadcn/ui Badge and status indicator components. The Topology tab is lazy-loaded via `React.lazy()` to avoid adding ~150-200 KB to the initial bundle.

## Consequences

### Positive

- Confirmed React 19 + Tailwind CSS 4 compatibility (explicit changelog)
- Custom nodes are real React components — reuse existing shadcn Badge, status dots
- First-party dagre and ELK layout adapters with copy-paste examples
- 2.9M weekly npm downloads — strong community and maintenance
- Built-in Controls component for zoom/pan

### Negative

- ~150-200 KB min+gz bundle size (mitigated by lazy loading)
- `nodeTypes` must be defined outside parent component (known footgun)
- New dependency added to apps/client
