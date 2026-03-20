---
slug: mesh-topology-elevation
number: 67
created: 2026-02-26
status: ideation
---

# Mesh Topology Chart Elevation

**Slug:** mesh-topology-elevation
**Author:** Claude Code
**Date:** 2026-02-26
**Branch:** preflight/mesh-topology-elevation
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Elevate the Mesh topology chart from a functional React Flow visualization to a world-class, living system map. The topology should communicate agent health, relay adapter status, pulse schedule presence, cross-namespace permissions, and provide progressive disclosure that rewards exploration — all while maintaining the Calm Tech minimalist aesthetic.

- **Assumptions:**
  - The agents-first-class-entity spec (spec #66) will be implemented before or alongside this work, providing color/emoji overrides on AgentManifest
  - ELK.js will be added for namespace group containers (Tier 3), while dagre remains for simpler layouts
  - React Flow v12 features (NodeToolbar, Background, MiniMap, CSS variables, animateMotion) are available and sufficient
  - Cross-subsystem data (Relay adapters, Pulse schedules) can be enriched into topology nodes via new batch endpoints or client-side joins
  - `prefers-reduced-motion` must be respected for all animations
  - Typical mesh scale is 3–20 agents, but design should gracefully handle 50+

- **Out of scope:**
  - Real-time traffic metrics on edges (Relay telemetry is not rich enough yet)
  - Drag-to-rearrange nodes (topology is infrastructure data, not a user-designed diagram)
  - Force-directed layout (unstable positions on re-render violate Calm Tech predictability)
  - Edge creation/deletion via UI (ACL management stays in the Access tab)
  - Collaborative multi-user editing of topology

## 2) Pre-reading Log

- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx`: Main React Flow graph — 211 lines, dagre LR layout, hub-spoke model with onNodeClick → AgentHealthDetail. No Background, no MiniMap, no hover effects.
- `apps/client/src/layers/features/mesh/ui/AgentNode.tsx`: Custom node — 55 lines, health dot, name, runtime badge, 2 capability badges, 180×60px. No hover state, no selection ring, no adapter indicators.
- `apps/client/src/layers/features/mesh/ui/NamespaceHubNode.tsx`: Hub node — 36 lines, colored pill with namespace name + agent count badge.
- `apps/client/src/layers/features/mesh/ui/CrossNamespaceEdge.tsx`: Cross-namespace edge — 52 lines, dashed blue (`#3b82f6` hardcoded), animated, label via EdgeLabelRenderer. Label always visible (cluttered at scale).
- `apps/client/src/layers/features/mesh/ui/NamespaceEdge.tsx`: Spoke edge — 22 lines, bezier, `var(--color-border)` stroke, 1px. Invisible on dark backgrounds.
- `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`: 5-tab container — 272 lines, topology tab renders LazyTopologyGraph with selectedAgentId state.
- `apps/client/src/layers/features/mesh/ui/AgentHealthDetail.tsx`: Right-side panel — 149 lines, w-64 border-l, shows health/capabilities/registration. No slide animation.
- `apps/client/src/layers/features/mesh/ui/MeshStatsHeader.tsx`: Status bar — 39 lines, total/active/inactive/stale counts.
- `apps/client/src/layers/features/mesh/ui/TopologyLegend.tsx`: Legend — 51 lines, edge type descriptions + namespace colors.
- `apps/client/src/layers/features/mesh/ui/TopologyPanel.tsx`: ACL management — 246 lines, cross-namespace rule CRUD.
- `apps/client/src/layers/features/mesh/lib/namespace-colors.ts`: 8-color palette for namespace visualization.
- `apps/client/src/layers/entities/mesh/index.ts`: 14 entity hooks (useTopology, useMeshAgentHealth, useRegisteredAgents, etc.).
- `packages/shared/src/mesh-schemas.ts`: TopologyView, AgentManifest, CrossNamespaceRule, AgentHealth, MeshInspect schemas.
- `decisions/0035-use-xyflow-react-for-mesh-topology.md`: ADR for React Flow v12 selection.
- `specs/agents-first-class-entity/02-specification.md`: Agent Settings Dialog (4 tabs), color/emoji identity, persona injection.
- `specs/mesh-panel-ux-overhaul/02-specification.md`: Progressive disclosure Mode A/B, ScanRootInput.
- `specs/mesh-network-topology/02-specification.md`: Namespace derivation, cross-namespace ACLs, budget constraints.
- `specs/mesh-observability-lifecycle/02-specification.md`: Agent health tracking, lifecycle events, diagnostic tools.
- `contributing/design-system.md`: Calm Tech — off-white/near-black, grayscale + accent blue, 8pt grid, rounded-xl cards, 100-300ms motion.
- `contributing/animations.md`: Motion v12, transform/opacity only, respect `prefers-reduced-motion`.

## 3) Codebase Map

**Primary Components/Modules:**

- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx` — Main React Flow graph container, dagre layout, node/edge construction
- `apps/client/src/layers/features/mesh/ui/AgentNode.tsx` — Custom agent node component (React.memo)
- `apps/client/src/layers/features/mesh/ui/NamespaceHubNode.tsx` — Namespace hub node (React.memo)
- `apps/client/src/layers/features/mesh/ui/CrossNamespaceEdge.tsx` — Animated cross-namespace edge with label
- `apps/client/src/layers/features/mesh/ui/NamespaceEdge.tsx` — Spoke edge (hub-to-agent)
- `apps/client/src/layers/features/mesh/ui/AgentHealthDetail.tsx` — Right-side health detail panel
- `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx` — Tab container managing topology state
- `apps/client/src/layers/features/mesh/ui/TopologyLegend.tsx` — Edge type legend

**Shared Dependencies:**

- `@xyflow/react` — React Flow v12 (custom nodes, edges, Background, MiniMap, NodeToolbar, Controls)
- `dagre` — Graph layout engine (LR, rank-based)
- `lucide-react` — Icon library
- `apps/client/src/layers/shared/ui/` — Badge, Tooltip, ResponsiveDialog
- `apps/client/src/layers/features/mesh/lib/namespace-colors.ts` — 8-color namespace palette

**Data Flow:**

```
MeshPanel → TopologyGraph → useTopology() → transport.getMeshTopology()
  → Server /api/mesh/topology → TopologyView response
  → Build nodes/edges → dagre layout → ReactFlow render
  → onNodeClick → AgentHealthDetail (side panel)
```

**Feature Flags/Config:**

- `DORKOS_MESH_ENABLED` controls entire Mesh subsystem availability

**Potential Blast Radius:**

- Direct: 8 UI component files (TopologyGraph, AgentNode, NamespaceHubNode, CrossNamespaceEdge, NamespaceEdge, AgentHealthDetail, TopologyLegend, MeshPanel)
- Schema/interface: AgentNodeData, NamespaceHubData, TopologyView enrichment
- Entity hooks: Possibly new hooks for Relay/Pulse data per agent
- New dependency: `elkjs` for namespace group containers
- CSS/theming: React Flow CSS variable overrides
- Tests: Updated mocks and new component tests

## 4) Root Cause Analysis

N/A — this is a feature enhancement, not a bug fix.

## 5) Research

### Industry Patterns (What Makes Topology Visualizations "World-Class")

**Grafana Node Graph Panel:** Arc indicators (multi-colored ring around nodes representing proportional metrics), stats inside circles, layered layout. The arc is the single most expressive status visualization — one glance communicates health composition.

**Datadog Service Map:** Nodes colored by error rate gradient, edge thickness scales with traffic, collapsible cluster nodes, hover tooltip for mini-stats, sliding side panel on click.

**Kiali (Kubernetes):** Animated flow particles traveling along edges to show traffic direction and activity — the defining visual of a "live system map." Different particle speeds for different throughput levels.

**Common patterns across all three:**

1. Every pixel communicates something — no decorative chrome
2. Information density achieved through layering (tooltip → node → panel), not cramming
3. Color is semantic and consistent (green/amber/red/gray)
4. Animation is functional — shows direction, activity, or state change
5. Empty/loading states are as polished as populated states

### React Flow v12 Features Available (Not Currently Used)

| Feature                          | Description                                                       | Impact                                 |
| -------------------------------- | ----------------------------------------------------------------- | -------------------------------------- |
| `NodeToolbar`                    | Floating toolbar on selected node, doesn't scale with zoom        | Quick actions without UI clutter       |
| `Background`                     | Dot/line/cross grid behind canvas                                 | Spatial anchoring, visual polish       |
| `MiniMap`                        | Bird's-eye overview with viewport indicator, `nodeColor` callback | Navigation for 5+ agents               |
| `animateMotion` SVG              | Circle traveling along edge path                                  | "Data flowing" on allow edges          |
| CSS variables (`--xy-*`)         | Full theming control                                              | Dark mode fix, design system alignment |
| `fitView` with duration          | Animated initial viewport fit                                     | Smooth load experience                 |
| `useStore(s => s.transform[2])`  | Read zoom level inside nodes                                      | Contextual zoom LOD                    |
| `useReactFlow().setCenter()`     | Programmatic viewport animation                                   | Fly-to on node selection               |
| `extent: 'parent'` + group nodes | Child nodes constrained to parent                                 | Namespace containers                   |
| `onlyRenderVisibleElements`      | Skip rendering off-screen nodes                                   | Performance at scale                   |

### Progressive Disclosure Design (4 Tiers)

**Tier 0 — At-a-glance (always visible on node):**

- Agent name (truncated with ellipsis)
- Health status ring (animated ping for active)
- Runtime icon (tiny icon, not a badge)
- Relay/Pulse indicator icons (when present)

**Tier 1 — Hover state (Tooltip):**

- Full agent name (untruncated)
- Last seen timestamp (`2m ago`)
- Capability tags (up to 5)
- Budget: `100 calls/hr · 5 max hops`
- Relay subject if present

**Tier 2 — Selected state (NodeToolbar):**

- Floating action bar: [Open Settings] [View Health] [Unregister]
- Quick actions without click-through

**Tier 3 — Click (Side panel + optional dialog):**

- AgentHealthDetail slides in from right (animated)
- Full capabilities, budget, behavior config, last seen event
- "Open Settings" button → Agent Settings Dialog (4 tabs from spec #66)

### Potential Solutions

**1. Layered Enhancement (Recommended)**

Add React Flow built-in components (Background, MiniMap), enhance existing node/edge components with indicators and animations, add NodeToolbar for actions, implement contextual zoom LOD, add animated flow particles, and optionally ELK.js for namespace group containers.

- Pros: Incremental, each enhancement independently valuable, preserves architecture
- Cons: Many moving parts, requires careful staging
- Complexity: High (but decomposable)

**2. React Flow Pro subscription**

- Pros: Pre-built premium components
- Cons: Cost, dependency on third-party premium tier
- Not recommended: Open-source features are sufficient

**3. Alternative library (D3, vis.js)**

- Pros: Some built-in features
- Cons: Massive rewrite, ADR-0035 decided on React Flow
- Not recommended

### Recommendation

**Solution 1 (Layered Enhancement)** across three tiers of implementation:

**Tier 1 — Immediate Wins (highest ROI, lowest effort):**

- `<Background variant="dots">` with design system color
- `<MiniMap>` with namespace-colored nodes
- Deny-rule edge type (red dashed, no animation)
- `onlyRenderVisibleElements` + `nodesConnectable={false}`
- Auto-refresh polling (15s refetchInterval)
- CSS variable theming (fix hardcoded `#3b82f6`)
- `fitView` with `duration: 400`

**Tier 2 — Core Elevation (high impact, medium effort):**

- Fly-to selection animation (`useReactFlow().setCenter()`)
- NodeToolbar on select ([Settings] [Health] [Remove])
- Contextual zoom LOD (3 detail levels based on `useStore` zoom)
- Health pulse ring (animated ping for active agents)
- Indicator row on nodes (Relay adapter icons + Pulse count)
- AgentHealthDetail slide-in animation
- Edge label show-on-hover/selected only

**Tier 3 — Signature Delight (highest visual impact):**

- Animated SVG flow particles on allow-rule cross-namespace edges
- ELK.js namespace group containers replacing hub-spoke model
- Namespace hub active/total count with pulse glow

### Performance Considerations

- `React.memo` already wraps AgentNode/NamespaceHubNode (correct)
- `useCallback` already wraps handlers (correct)
- SVG `<animateMotion>` runs on compositor thread (no JS cost)
- `animate-ping` is GPU-accelerated (transform + opacity)
- `onlyRenderVisibleElements` skips off-screen node rendering
- ELK.js layout is async — use `useState` + `useEffect` pattern
- For 20+ nodes: consider throttling animations or animating only visible nodes
- `prefers-reduced-motion` gates all animations

### Calm Tech Design Constraints

1. **Periphery-first**: MiniMap and Background dots live in periphery — inform without demanding attention
2. **Progressive disclosure**: Compact nodes at zoom-out; full detail at zoom-in. Tooltip on hover. Panel on click.
3. **Motion with purpose**: setCenter anchors attention. Flow particles communicate data flow. No gratuitous animation.
4. **Color communicates**: Green = active, amber = degraded, gray = stale. Namespace palette is deterministic.
5. **No modal interruptions**: Side panel and NodeToolbar are non-modal. Agent Dialog opens only via explicit toolbar action.
6. **Respect reduced motion**: All animations gated on `prefers-reduced-motion`

## 6) Decisions

| #   | Decision               | Choice                                                 | Rationale                                                                                                                                                                                                      |
| --- | ---------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Node click behavior    | Keep side panel + add NodeToolbar with Settings button | Best of both worlds: quick health info on click (graph stays visible), full Agent Dialog via toolbar action. Mirrors Datadog/Grafana pattern.                                                                  |
| 2   | Enhancement scope      | All 3 tiers (maximum ambition)                         | Background, MiniMap, deny edges, flow particles, fly-to, NodeToolbar, contextual zoom LOD, health pulse, indicators, ELK.js namespace containers. Go big.                                                      |
| 3   | Relay/Pulse indicators | Show directly on agent nodes                           | Subtle indicator row with Relay adapter icons and Pulse schedule count. Requires data enrichment (new batch endpoint or client-side join). High information density gain.                                      |
| 4   | Contextual zoom LOD    | Yes, 3 detail levels                                   | Zoomed out (<0.6): compact pill with dot+name. Default: current card. Zoomed in (>1.2): expanded card with description, adapters, last-seen, budget. Makes large graphs navigable while rewarding exploration. |
