---
slug: topology-overhaul
number: 122
created: 2026-03-11
status: ideation
---

# Topology Visualization Overhaul

**Slug:** topology-overhaul
**Author:** Claude Code
**Date:** 2026-03-11

---

## 1) Intent & Assumptions

- **Task brief:** Overhaul the React Flow topology visualization to remove the Claude Code Adapter (CCA) as a graph node, always show namespace containers, add a ghost adapter placeholder, add MiniMap/Background, and align adapter nodes and binding edges with the spec 120 labeling and filter work.

- **Assumptions:**
  - The existing React Flow + ELK.js architecture is sound and unchanged
  - The CCA is an internal runtime adapter, not an external relay adapter — every agent uses it by definition
  - Only external relay adapters (Telegram, webhook, etc.) should appear as graph-level nodes
  - Namespace containers already work (NamespaceGroupNode + ELK compound layout) but are gated behind a multi-namespace check
  - Spec 120 (adapter-binding-ux-overhaul) will land adapter labels and chatId/channelType binding fields — the topology should surface these
  - The topology serves three roles equally: operational dashboard, configuration tool, mental model builder — with LOD progressive disclosure handling the tension between them

- **Out of scope:**
  - Health indicator upgrade (dot → arc ring SVG) — future Tier 2 enhancement
  - NodeToolbar for secondary actions — future Tier 2 enhancement
  - Animated SVG particles on edges (Kiali-style) — future Tier 3 enhancement
  - Real-time message throughput counters — future Tier 3 enhancement
  - Click-to-expand/collapse namespace containers — future Tier 3 enhancement
  - Dark mode `colorMode="system"` sync — future Tier 1 enhancement
  - `onlyRenderVisibleElements` performance optimization — future Tier 1 enhancement

## 2) Pre-reading Log

- `research/20260228_graph_topology_visualization_ux.md`: LOD rendering, edge labels, drag-to-connect, minimap, health indicators, node grouping, color encoding. Primary design reference.
- `research/20260226_mesh_topology_elevation.md`: Three-tier enhancement roadmap. Tier 1 (Background, MiniMap, DenyEdge, colorMode), Tier 2 (fly-to-selection, NodeToolbar, LOD expansion, health arc), Tier 3 (particles, ELK groups).
- `research/20260225_mesh_panel_ux_overhaul.md`: MeshPanel mode A/B progressive disclosure.
- `research/20260225_mesh_network_topology.md`: Network topology fundamentals.
- `specs/adapter-binding-ux-overhaul/02-specification.md`: Spec 120 — adapter labels, multi-instance, chatId/channelType binding fields.
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx`: Main topology component, layout orchestration.
- `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts`: Pure element builder function.
- `apps/client/src/layers/features/mesh/ui/AgentNode.tsx`: Agent node with 3-band LOD, health dot, capabilities.
- `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx`: Adapter node with status, platform icon, binding count.
- `apps/client/src/layers/features/mesh/ui/NamespaceGroupNode.tsx`: Namespace container with ELK compound layout.
- `apps/client/src/layers/features/mesh/ui/BindingEdge.tsx`: Binding edge with hover label and delete action.
- `apps/client/src/layers/features/mesh/lib/elk-layout.ts`: ELK async layout engine.
- `apps/client/src/layers/features/mesh/lib/use-lod-band.ts`: Zoom-based LOD selector.
- `apps/client/src/layers/features/mesh/ui/use-topology-handlers.ts`: All ReactFlow event handlers.

## 3) Codebase Map

**Primary Components/Modules:**

| Path                                                                  | Role                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx`           | Main component, layout orchestration, ReactFlow wrapper     |
| `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts` | Pure element builder: nodes + edges from topology data      |
| `apps/client/src/layers/features/mesh/ui/AgentNode.tsx`               | Agent rendering, 3-band LOD, health dot, capability badges  |
| `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx`             | Adapter rendering, status dot, platform icon, binding count |
| `apps/client/src/layers/features/mesh/ui/NamespaceGroupNode.tsx`      | Namespace container, colored header, agent count            |
| `apps/client/src/layers/features/mesh/ui/BindingEdge.tsx`             | Adapter→Agent binding edge, hover label, delete action      |
| `apps/client/src/layers/features/mesh/ui/use-topology-handlers.ts`    | All ReactFlow event handlers                                |
| `apps/client/src/layers/features/mesh/lib/elk-layout.ts`              | ELK.js async layout engine                                  |
| `apps/client/src/layers/features/mesh/lib/use-lod-band.ts`            | Zoom-based LOD selector                                     |
| `apps/client/src/layers/features/mesh/ui/topology-graph.css`          | Handle visibility, drag-to-connect states                   |

**Data Flow:**

1. `useTopology()` + `useRelayAdapters()` + `useBindings()` fetch server data
2. `buildTopologyElements()` creates raw nodes/edges (pure function, in useMemo)
3. `applyElkLayout()` positions nodes via ELK.js (async)
4. `TopologyGraph` renders positioned elements in ReactFlow
5. `use-topology-handlers` manages all user interactions

**Blast Radius:**

- Direct: ~6 files (build-topology-elements, TopologyGraph, AgentNode, AdapterNode, BindingEdge, use-topology-handlers)
- Indirect: ~3 files (tests for build-topology-elements, AgentNode, AdapterNode)

## 4) Root Cause Analysis

Not applicable — this is a UX improvement, not a bug fix.

## 5) Research

Two existing research reports are the primary references:

### `research/20260228_graph_topology_visualization_ux.md`

- MiniMap is "critical for spatial orientation" — highest-value addition
- LOD rendering is the "single highest-leverage technique" — already implemented
- Background dots provide spatial reference when panning/zooming
- Edge labels should hover-to-reveal for dense graphs — already implemented

### `research/20260226_mesh_topology_elevation.md`

- Three-tier roadmap: Tier 1 (quick wins), Tier 2 (core elevation), Tier 3 (signature delight)
- This spec covers selected Tier 1 items (MiniMap, Background) plus the CCA/namespace changes

## 6) Decisions

| #   | Decision             | Choice                                          | Rationale                                                                                                                                                          |
| --- | -------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | CCA as graph node    | Remove; show runtime as badge on AgentNode      | CCA is an internal runtime, not relay topology. Every agent uses it, so it adds noise without information. Badge communicates runtime without wasting graph space. |
| 2   | Namespace containers | Always show, even with single namespace         | Teaches the concept, provides visual structure, consistent as users scale up. Already implemented but gated behind multi-namespace check.                          |
| 3   | Empty adapter state  | Ghost placeholder node with dashed border       | Progressive disclosure — teaches relay capability without requiring setup. Click-to-add entry point. Disappears when real adapters exist.                          |
| 4   | MiniMap + Background | Add both (React Flow built-ins)                 | Highest-value quick wins from research. MiniMap for spatial orientation, Background dots for spatial reference.                                                    |
| 5   | Adapter node labels  | Show label (primary) + type name (secondary)    | Aligns with spec 120 adapter labeling. Multi-instance adapters differentiated by label.                                                                            |
| 6   | Binding edge filters | Show chatId/channelType as badges on edge label | Aligns with spec 120 binding filter fields. Communicates routing specificity at a glance.                                                                          |
| 7   | Topology purpose     | All three: dashboard, config tool, mental model | LOD progressive disclosure handles the tension. Zoomed out = status. Mid = relationships. Zoomed in = configuration.                                               |
