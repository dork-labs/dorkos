---
title: "Mesh Topology Elevation — Research Findings"
date: 2026-02-26
type: external-best-practices
status: active
tags: [mesh, topology, elk-js, xyflow, layout, visualization]
feature_slug: mesh-topology-elevation
---

# Mesh Topology Elevation — Research Findings

**Date**: 2026-02-26
**Topic**: Elevating the Mesh topology chart to world-class agent topology visualization
**Mode**: Deep Research (14 tool calls)
**Codebase context**: React 19, Tailwind CSS 4, shadcn/ui, @xyflow/react v12, Calm Tech design language

---

## Research Summary

The current topology is a solid foundation: dagre LR layout, agent nodes with health dot and capability badges, namespace hub nodes, NamespaceEdge/CrossNamespaceEdge, a legend, and basic Controls. The gaps are in visual richness, interactivity, spatial orientation, progressive disclosure, and data density. By combining seven targeted enhancements — Background, MiniMap, contextual LOD nodes, arc-style health rings, animated flow edges, hover-activated NodeToolbar, and fly-to selection — the chart can reach the level of Kiali, Datadog APM, or Grafana's node graph while staying true to the Calm Tech aesthetic.

---

## Current State Audit

### What Exists

| Component | File | Current capability |
|---|---|---|
| `TopologyGraph` | `TopologyGraph.tsx` | dagre LR, Controls (no-interactive), legend, `fitView`, lazy-loaded |
| `AgentNode` | `AgentNode.tsx` | Health dot (green/amber/zinc), name, runtime badge, up-to-2 capability badges, namespace left-border accent |
| `NamespaceHubNode` | `NamespaceHubNode.tsx` | Pill shape, namespace name, agent count badge, namespace color |
| `NamespaceEdge` | `NamespaceEdge.tsx` | Plain bezier, `--color-border`, 1px stroke |
| `CrossNamespaceEdge` | `CrossNamespaceEdge.tsx` | Dashed bezier, blue, `animated: true` dashes, `EdgeLabelRenderer` label |
| `TopologyLegend` | `TopologyLegend.tsx` | Bottom-left Panel, edge type legend + namespace colors |

### What Is Missing

- No `Background` component (canvas has no spatial reference frame)
- No `MiniMap` (disorienting on larger graphs)
- No contextual zoom / level of detail
- No hover interaction on nodes (no `NodeToolbar`)
- No fly-to animation on node selection
- No arc/ring health indicator (just a 10px dot)
- No `deny`-rule visualisation on edges (only `allow` cross-namespace edges shown)
- No `onlyRenderVisibleElements` for performance
- No namespace grouping as visual parent containers (uses hub-spoke instead)
- No `colorMode` prop for automatic dark mode sync

---

## Key Findings

### 1. React Flow v12 Built-In Components Available but Unused

React Flow ships `Background`, `MiniMap`, `Controls` (already used partially), `Panel`, `NodeToolbar`, `NodeResizer`, `EdgeToolbar`, `EdgeLabelRenderer`, `BaseEdge`, and `ViewportPortal`. Of these, only `Controls` and `Panel` are used today.

**Background**: Three `BackgroundVariant` options — `Lines`, `Dots`, `Cross`. Supports `color`, `size`, `gap`, `patternClassName`. The `Dots` variant at low opacity is the Calm Tech choice — it provides spatial reference without visual noise.

**MiniMap**: Non-interactive by default. Can be made `zoomable` and `pannable`. Supports custom `nodeColor` function (maps to namespace colors), custom `nodeComponent` renderer. Provides critical spatial orientation for multi-namespace graphs (5+ nodes).

**NodeToolbar**: Appears on node selection, does not scale with viewport (always readable). Positioned at any side (`Position.Top/Bottom/Left/Right`). Default visibility is `isVisible` = selected. Can be overridden for hover via the `isVisible` prop.

**EdgeToolbar**: New in 2024. Renders unscaled HTML on top of an edge — can show a dismiss button, access rule details, or quick-action buttons on edge selection.

**colorMode prop**: Pass `colorMode="system"` to ReactFlow and it auto-syncs with the OS/browser dark mode, adding the `dark` class to the wrapper. Currently the component has no colorMode, so dark mode CSS variables may be mismatched.

### 2. Contextual Zoom / Level of Detail

React Flow provides a `useStore` hook that exposes the current viewport transform. The zoom is at `transform[2]`. A simple selector:

```typescript
const showDetail = useStore((s) => s.transform[2] >= 0.75);
```

This enables LOD rendering in custom nodes:
- Zoomed out (< 0.6): compact pill — just a colored dot + name, ~32px tall
- Normal (0.6–1.2): current layout — dot, name, runtime badge, 2 capability badges
- Zoomed in (> 1.2): expanded — add description excerpt, adapter icons, last-seen timestamp

This is how Kiali and Grafana node graph handle high node counts without overwhelming the user.

### 3. Layout Algorithms

**Dagre** (currently used): LR direction, `nodesep: 50`, `ranksep: 100`. Simple, fast, deterministic. Does NOT support parent-child sub-flows (namespaces as containers).

**ELK.js**: Supports sub-flows natively, hierarchical layout, edge routing around nodes. Much more powerful — would allow true namespace containers as visual `group` nodes with agents inside. Complexity is higher but the output is significantly more readable. Required for the "namespace as container" pattern.

**D3-Force**: Physics-based. Good for exploring organic relationships. Not ideal for access-rule topology which has a clear hierarchy.

**Recommendation**: Stay on dagre for now (it works well), but implement ELK.js as an opt-in "hierarchical" view toggle for when namespace containers become a priority.

### 4. Edge Enhancement Options

| Pattern | Description | Complexity |
|---|---|---|
| `smoothstep` path | Orthogonal with rounded corners — cleaner than bezier for hub-spoke | Low |
| `animated: true` dashes | Already used on cross-namespace. Add custom CSS `strokeDashoffset` animation for direction/speed control | Low |
| SVG `animateMotion` particle | Animate a small circle along the path to show data flow direction | Medium |
| Edge width by activity | Vary `strokeWidth` proportional to message count from Relay metrics | Medium |
| `EdgeToolbar` on select | Floating unscaled button bar — "Revoke access", "View trace", "Copy rule" | Low |
| Deny-rule edges | Currently, deny rules produce NO edge. Add a red dashed `deny` edge type | Low |

The SVG `animateMotion` particle pattern (a circle moving along the edge path) is the signature feature of Kiali's traffic animation — it immediately communicates directionality and activity level. It is natively supported in React Flow's `animating-edges` example using `<animateMotion>` on an SVG element.

### 5. Node Design Elevations

**Arc/Ring Health Indicator (Grafana Node Graph pattern)**:
Grafana's node graph wraps each circle node in colored arc segments. For DorkOS rect nodes, the ring maps to a small `24×24` SVG circle in the node:
- Full green arc = `active`
- Partial amber arc (~60%) = `inactive`
- Minimal gray arc (~20%) = `stale`

Implementation via SVG `strokeDasharray` computed from the circumference:

```tsx
function HealthRing({ status }: { status: 'active' | 'inactive' | 'stale' }) {
  const circumference = 2 * Math.PI * 10; // r=10
  const FILL = { active: circumference, inactive: circumference * 0.6, stale: circumference * 0.2 };
  const COLOR = { active: '#10b981', inactive: '#f59e0b', stale: '#94a3b8' };
  return (
    <svg width="24" height="24" className="shrink-0">
      <circle cx="12" cy="12" r="10" fill="none" stroke="var(--color-border)" strokeWidth="2" />
      <circle
        cx="12" cy="12" r="10"
        fill="none"
        stroke={COLOR[status]}
        strokeWidth="2"
        strokeDasharray={`${FILL[status]} ${circumference}`}
        strokeLinecap="round"
        transform="rotate(-90 12 12)"
      />
    </svg>
  );
}
```

**Capability Icons instead of text badges**:
Map known capabilities (e.g. `code`, `search`, `browser`) to Lucide icons. Show icons at normal zoom, text badges at zoomed-in. Reduces node width by ~40%.

**Pulse animation on active agents**:
A subtle `animate-ping` ring (Tailwind CSS) around the health dot for `active` agents only. Only `active` nodes pulse; `inactive` and `stale` are static. This subtly draws the eye to live agents — Calm Tech compliant.

**Last-seen timestamp (zoomed-in only)**:
When zoom > 1.2, reveal a `text-[10px] text-muted-foreground` line with relative time ("2m ago"). Progressive disclosure without cluttering the default view.

### 6. Viewport and Interaction Patterns

**Fly-to selection**:
When `onSelectAgent` fires, use `useReactFlow().setCenter(x, y, { zoom: 1.4, duration: 350 })` to smoothly animate the viewport to the selected node. Currently nothing happens to the viewport on node click.

```typescript
const { setCenter, getNode } = useReactFlow();

const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
  if (node.type === 'agent') {
    const n = getNode(node.id);
    if (n) {
      setCenter(
        n.position.x + (n.measured?.width ?? AGENT_NODE_WIDTH) / 2,
        n.position.y + (n.measured?.height ?? AGENT_NODE_HEIGHT) / 2,
        { zoom: 1.4, duration: 350 }
      );
    }
    onSelectAgent?.(node.id);
  }
}, [onSelectAgent, setCenter, getNode]);
```

Note: `useReactFlow()` requires the calling component to be a descendant of `<ReactFlowProvider>`. The cleanest fix is wrapping `TopologyGraph` at its usage site in `MeshPanel` with `<ReactFlowProvider>`, then extracting an inner component that uses the hook.

**Fit view on topology change**:
When `namespaces` data changes (new agent registered), trigger `fitView({ duration: 300 })`. Use a `useEffect` with a prev-value comparison — only re-fit when agent count changes, not on every refetch.

**Pan on scroll vs zoom on scroll**:
For a sidebar panel (not full-screen), set `panOnScroll={true}` and `zoomOnScroll={false}` to prevent scroll hijacking.

### 7. Performance

React Flow optimization props:
- `onlyRenderVisibleElements` — only renders nodes currently in the viewport. Set to `true`.
- `nodesDraggable={false}` and `nodesConnectable={false}` for read-only topology (avoids unnecessary event handlers)
- `NODE_TYPES` and `EDGE_TYPES` already correctly defined outside the component (referentially stable — do not move inside)
- All custom node/edge components already use `React.memo`

At 50–100 nodes (realistic for a multi-team DorkOS deployment), performance remains smooth. Above 200 nodes, `onlyRenderVisibleElements` becomes critical.

### 8. Background Component

```tsx
<Background
  variant={BackgroundVariant.Dots}
  gap={20}
  size={1}
  color="var(--color-border)"
/>
```

`Dots` at `gap={20}`, `size={1}` creates a very subtle dot grid. The `--color-border` CSS variable is already correctly themed for light/dark mode in the project's Tailwind CSS 4 setup.

### 9. Deny-Rule Edges

Currently, `deny` access rules produce zero visual output — the code has `if (rule.action !== 'allow') continue;`. A red dashed edge between namespace hubs for deny rules would:
- Make the ACL policy visible at a glance
- Make "deny" feel like an intentional, visible action (not invisible absence)
- Help operators debug misconfigured namespace isolation

A `DenyEdge` type: red (`#ef4444`), `strokeDasharray: "4 2"`, no arrowhead, no animation. The legend gets a third entry.

### 10. MiniMap Customization

```tsx
<MiniMap
  nodeColor={(node) => {
    if (node.type === 'namespace-hub') return node.data.color as string;
    return (node.data as AgentNodeData).namespaceColor ?? '#94a3b8';
  }}
  pannable
  zoomable
  style={{ height: 80 }}
/>
```

At the top-right corner, this gives users a bird's-eye view of the entire topology while interacting with a specific region. Essential once the graph has 8+ nodes across 3+ namespaces.

---

## Industry Best Practices (World-Class Topology UIs)

### Kiali (Istio Service Mesh)

**What makes it great**:
- Four graph modes (workload / app / versioned app / service) for different abstraction levels
- Traffic animation: circles for successful requests, red diamonds for errors — density encodes rate
- Color coding: edges AND nodes encode health state
- Double-click drill-down: go from cluster view to node-specific detail graph
- Bookmarkable state including replay data
- Find/hide filtering for large graphs

**Applicable to DorkOS**:
- Traffic animation on cross-namespace edges (particle = Relay message activity)
- Double-click for drilldown (more deliberate than single-click)
- Namespace-based graph modes (hub view vs. flat agent view)

### Datadog APM Service Map

**What makes it great**:
- Nodes = services with monitor health embedded directly (no separate panel needed to see status)
- Edges = request rate, error rate, latency revealed on hover
- Grouping by team or application as colored region backgrounds
- Highlighted edges for highest throughput paths

**Applicable to DorkOS**:
- Embed message count or last-active timestamp directly on nodes (zoom-dependent)
- On edge hover: show access rule details inline via `EdgeToolbar` or `EdgeLabelRenderer` tooltip
- When Relay metrics are available: vary edge stroke width by message throughput

### Grafana Node Graph Panel

**What makes it great**:
- Arc segments around node circles: each arc encodes a health metric as a proportion
- Nodes have configurable main stat and secondary stat displayed inside the circle
- Edge thickness encodes traffic volume
- Context menus on click reveal all `detail__`-prefixed fields
- Grid layout fallback for accessibility

**Applicable to DorkOS**:
- Health arc ring (SVG `strokeDasharray` technique) on AgentNode
- Main stat inside node body (last message count at high zoom)
- Edge thickness variation based on Relay activity

### Headlamp / Kubernetes Dashboard

**What makes it great**:
- Application-centric grouping across namespaces (Projects feature)
- Map view + list view as complementary views of the same data
- Real-time status without page refresh

**Applicable to DorkOS**:
- The existing Topology (graph) + Agents (list) tab pattern already implements this correctly
- Add auto-refresh polling or SSE-based topology updates

### Figma / FigJam Canvas Patterns

**What users love**:
- Minimap as navigation anchor
- Fit-to-selection (not just fit-all)
- Selection box for multi-select

**Applicable to DorkOS**:
- Fit-to-selection: when user clicks a namespace hub, `fitView({ nodes: [hubNode, ...agentNodes], duration: 300 })`

---

## Enhancement Categories — Full Analysis

### Category 1: Canvas Foundation (Background + MiniMap + colorMode)

**Description**: Add `<Background>` dots, `<MiniMap>` with namespace colors, and `colorMode="system"` to `ReactFlow`. Also add `onlyRenderVisibleElements`, `nodesDraggable={false}`, `nodesConnectable={false}`, `panOnScroll={true}`, `zoomOnScroll={false}`.

**Visual outcome**:
- Dot grid provides spatial reference — users know where they are relative to the canvas
- MiniMap shows full topology at a glance when user is panned or zoomed in
- Dark mode works correctly without CSS variable mismatches
- Scroll behavior no longer hijacks page scrolling

**Pros**: Very low effort (5–10 lines total), immediate visual polish, zero breaking changes

**Cons**: MiniMap adds a small permanent UI element — may feel cluttered at very small panel sizes; can be hidden below a breakpoint

**Complexity**: Trivial (1–2 hours)

**UX Impact**: High — grounding the canvas is fundamental; users without a reference grid feel spatially lost

**Implementation sketch**:
```tsx
<ReactFlow
  colorMode="system"
  onlyRenderVisibleElements
  nodesDraggable={false}
  nodesConnectable={false}
  panOnScroll
  zoomOnScroll={false}
  ...
>
  <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border)" />
  <MiniMap
    nodeColor={(n) => (n.data as AgentNodeData).namespaceColor ?? '#94a3b8'}
    pannable
    zoomable
    style={{ height: 80 }}
  />
  <Controls showInteractive={false} />
  <TopologyLegend ... />
</ReactFlow>
```

---

### Category 2: Contextual Zoom (Level of Detail)

**Description**: Use `useStore((s) => s.transform[2])` inside `AgentNode` to render three detail levels.

**Visual outcome**:
- Zoomed out (< 0.6): compact 32px pill — colored dot + truncated name only (no badges)
- Default (0.6–1.2): current design
- Zoomed in (> 1.2): full card — adds description line, adapter icons, last-seen, budget limits

**Pros**: Large graphs become navigable at wide zoom without node overlap; full information available on drill-down without a separate click

**Cons**: Node height changes with zoom can cause layout jitter — mitigate with `min-height` and CSS `transition: height 150ms ease`

**Complexity**: Medium (3–4 hours, careful CSS needed)

**UX Impact**: Very high for graphs with 10+ agents

**Key code pattern** (from React Flow docs):
```typescript
// Inside AgentNodeComponent
const isCompact = useStore((s) => s.transform[2] < 0.6);
const isExpanded = useStore((s) => s.transform[2] > 1.2);
```

---

### Category 3: Health Arc Ring on AgentNode

**Description**: Replace the 10px dot health indicator with a SVG arc ring.

**Visual outcome**: A 24×24 SVG circle with a colored arc proportional to health severity. Full ring = healthy, partial = degraded, minimal = stale. More quantitative than a binary dot.

**Pros**: Encodes health as a quantitative spectrum; looks premium; matches Grafana's visual language; distinguishable even for colorblind users (arc length vs. color)

**Cons**: Must decide what ring fill represents beyond enum (currently `active/inactive/stale`) — could map to uptime percentage if that data becomes available

**Complexity**: Low–Medium (2–3 hours including design decisions)

**UX Impact**: High — the ring immediately communicates "how healthy" not just "whether healthy"

---

### Category 4: Deny-Rule Edge Type

**Description**: Render cross-namespace `deny` rules as red dashed edges. Currently they are silently dropped with `if (rule.action !== 'allow') continue`.

**Visual outcome**: A red dashed line between namespace hubs, no arrowhead, no animation. Blue animated = allow. Red dashed static = deny.

**Pros**: ACL policy becomes fully visible; "deny" feels intentional and managed; operators can audit policy at a glance; legend gets third entry (red dashed = deny)

**Cons**: In dense graphs, red edges add noise — mitigate by setting them to 60% opacity by default, full opacity on hover

**Complexity**: Trivial (copy CrossNamespaceEdge, change color and animation behavior, add to legend)

**UX Impact**: High for operators managing multi-namespace setups

---

### Category 5: NodeToolbar on Selection

**Description**: Add `<NodeToolbar>` inside `AgentNode` with quick actions: View Health Detail, Copy Agent ID, (future) Unregister.

```tsx
// Inside AgentNodeComponent
<NodeToolbar isVisible={selected} position={Position.Top}>
  <button className="..." onClick={() => void navigator.clipboard.writeText(id)}>
    Copy ID
  </button>
  <button className="..." onClick={() => onViewHealth?.(id)}>
    Health
  </button>
</NodeToolbar>
```

**Pros**: Actions are contextual and non-intrusive. The toolbar doesn't exist until needed. Avoids cluttering the node with permanent action buttons.

**Cons**: Select-triggered toolbar fires simultaneously with `onNodeClick` → `AgentHealthDetail`. The NodeToolbar should contain only secondary actions (Copy ID); the primary action (open health detail) should remain on `onNodeClick`.

**Complexity**: Low (1–2 hours)

**UX Impact**: Medium–High — surfaces agent actions without adding permanent UI chrome

---

### Category 6: Fly-to Selection Animation

**Description**: When `onSelectAgent` fires, smoothly animate the viewport to center on the selected agent node.

**Visual outcome**: Clicking a node causes the canvas to smoothly pan (and optionally zoom) to center on that node, anchoring the user's attention before the side panel opens.

**Pros**: Establishes clear visual connection between clicking a node and the detail panel opening. The animated pan communicates "this is the node you selected."

**Cons**: At very high zoom levels, `setCenter` might over-zoom. Use `Math.max(currentZoom, 1.4)` to avoid unnecessary zoom-out. Requires `ReactFlowProvider` wrapping.

**Implementation note**: `useReactFlow()` requires being inside `<ReactFlowProvider>`. Wrap `TopologyGraph` in `<ReactFlowProvider>` at its usage site in `MeshPanel.tsx`, then create a `TopologyGraphInner` component that calls `useReactFlow()`.

**Complexity**: Low (2 hours including ReactFlowProvider refactor)

**UX Impact**: Very high — this is the #1 interaction that feels "premium" in topology visualizations

---

### Category 7: Animated SVG Particles on Active Edges

**Description**: For cross-namespace `allow` edges, add an SVG `<animateMotion>` particle — a small circle traveling along the bezier path. Kiali's signature feature.

**Visual outcome**: A 3px blue circle glides along the edge from source to target namespace, ~2s per loop. Denser/faster animation when Relay message volume is higher.

```tsx
// Inside CrossNamespaceEdge, after BaseEdge:
// Assign an id to the BaseEdge path, then:
<circle r="3" fill="#3b82f6" opacity="0.8">
  <animateMotion dur="2s" repeatCount="indefinite">
    <mpath href={`#edge-path-${props.id}`} />
  </animateMotion>
</circle>
```

For `deny` edges: no particle (dead connection = no flow). For `inactive` agent spoke edges: a slowed or stopped particle.

**Respect `prefers-reduced-motion`**: Check `window.matchMedia('(prefers-reduced-motion: reduce)').matches` and conditionally omit the animation.

**Pros**: Immediately communicates directionality and "liveness"; the single most visually impressive upgrade; no additional data required (purely decorative)

**Cons**: CSS animations across many edges could affect performance on low-end devices; `<animateMotion>` with `<mpath>` requires the path element to have a stable DOM `id` — needs careful handling in React Flow's SVG output

**Complexity**: Medium (3–4 hours, careful SVG path ID handling)

**UX Impact**: Very high — this is the signature "wow" feature

---

### Category 8: Namespace as Visual Container (Group Nodes with ELK.js)

**Description**: Replace the hub-spoke model with React Flow's `extent: 'parent'` group node pattern. Each namespace becomes a visual rounded-rectangle container with agents positioned inside it.

**Current model**: `namespace-hub` node + spoke edges connecting agents to hub.

**Group node model**: A `group` type node represents the namespace as a visual container. Agent nodes have `parentId: namespaceId` and `extent: 'parent'`. No spoke edges needed — spatial containment replaces the hub node entirely.

**Layout**: Requires switching from dagre to ELK.js which natively supports sub-flow layout. ELK options: `elk.algorithm: 'layered'`, `elk.direction: 'RIGHT'`.

**Pros**: More intuitive — agents are visually "inside" their namespace. Cross-namespace edges connect between container borders. Cleaner for 3+ namespace graphs.

**Cons**: Highest complexity of all enhancements. Requires ELK.js migration (async layout). Node sizes become dynamic (group expands to fit agents). Higher layout computation time.

**Complexity**: High (8–12 hours including ELK.js migration, group node sizing, dynamic layout)

**UX Impact**: Very high for multi-namespace graphs (3+ namespaces), minimal for single-namespace

---

### Category 9: Auto-Refresh and Live Updates

**Description**: Add polling to the topology query and add smart `fitView` on agent count change.

```typescript
// In use-mesh-topology.ts
useQuery({ ..., refetchInterval: 15_000 });
```

For smart fitView: track previous agent count with `useRef`; only call `fitView({ duration: 300 })` when the count increases (new agent added).

**Complexity**: Trivial (30–60 minutes)

**UX Impact**: Medium — removes the "stale map" problem; topology stays fresh when agents are registered from the Discovery tab

---

## Recommendation: Prioritized Implementation Plan

### Tier 1 — Immediate Wins (4–6 hours total)

These can be shipped in a single focused session. No structural changes required.

| # | Enhancement | Files changed | Effort | UX Impact |
|---|---|---|---|---|
| 1 | `<Background>` dots + `colorMode="system"` + read-only props | `TopologyGraph.tsx` | 30 min | High |
| 2 | `<MiniMap>` with namespace colors | `TopologyGraph.tsx` | 1 hr | High |
| 3 | `DenyEdge` type + legend update | New `DenyEdge.tsx`, `TopologyGraph.tsx`, `TopologyLegend.tsx` | 1 hr | High |
| 4 | `onlyRenderVisibleElements` + performance props | `TopologyGraph.tsx` | 15 min | Medium |
| 5 | Auto-refresh polling (15s) + smart fitView | `use-mesh-topology.ts`, `TopologyGraph.tsx` | 45 min | Medium |

### Tier 2 — Core Elevation (1–2 days total)

| # | Enhancement | Files changed | Effort | UX Impact |
|---|---|---|---|---|
| 6 | Fly-to selection (`ReactFlowProvider` + `setCenter`) | `MeshPanel.tsx`, `TopologyGraph.tsx` | 2 hr | Very High |
| 7 | `NodeToolbar` on select (Copy ID, secondary actions) | `AgentNode.tsx` | 1.5 hr | Medium–High |
| 8 | Contextual zoom LOD in `AgentNode` | `AgentNode.tsx` | 3–4 hr | Very High |
| 9 | Health arc SVG ring replacing dot indicator | `AgentNode.tsx` | 2–3 hr | High |

### Tier 3 — Signature Delight (3–4 days total)

| # | Enhancement | Files changed | Effort | UX Impact |
|---|---|---|---|---|
| 10 | Animated SVG particle on allow-rule edges | `CrossNamespaceEdge.tsx` | 3–4 hr | Very High (visual signature) |
| 11 | Namespace group node containers (ELK.js) | `TopologyGraph.tsx`, new `NamespaceGroupNode.tsx` | 8–12 hr | Very High (structural) |

### What NOT to Add (Calm Tech Violations)

- **Drag-to-rearrange nodes**: This topology is read-only infrastructure data, not a user-designed diagram. Enabling drag implies the user controls layout — misleading.
- **Real-time traffic metrics on edges**: Relay telemetry data is not yet rich enough to feed meaningful throughput numbers. Save for when Relay metrics are richer.
- **Right-click context menu**: Too much chrome for current feature set. NodeToolbar on select is cleaner.
- **Force-directed layout (D3-Force)**: Produces unstable positions on re-render. Calm Tech requires predictable, stable layouts.
- **Floating tooltips on every hover**: Each hover interaction should reveal only one thing. Tooltip + NodeToolbar + LOD expansion on the same trigger = overwhelming.

---

## Calm Tech Design Constraints

The Calm Tech principles that should guide every implementation decision:

1. **Periphery-first**: The MiniMap and subtle Background dots live in the periphery. They inform without demanding attention.
2. **Progressive disclosure**: Compact nodes at zoom-out; full detail at zoom-in. The health ring communicates severity without requiring a click.
3. **Motion with purpose**: The `setCenter` animation anchors the user's attention. The particle animation communicates data flow direction. Both have semantic meaning. Gratuitous animations (bounce, spin, pulse without meaning) are excluded.
4. **Color communicates, not decorates**: Namespace palette is already deterministic. Health ring colors (green/amber/gray/red) map directly to system state. No arbitrary color use.
5. **No modal interruptions**: `AgentHealthDetail` is already a non-modal panel. `NodeToolbar` keeps actions inline. This is the right model — maintain it.

---

## Technical Notes for Implementation

### ReactFlowProvider Pattern

`useReactFlow()` must be called inside a `<ReactFlowProvider>`. The current `TopologyGraph` renders `<ReactFlow>` directly, which is also a provider. Two clean approaches:

**Option A**: Wrap `<LazyTopologyGraph>` in `MeshPanel.tsx` with `<ReactFlowProvider>`. Then `TopologyGraph` can create an inner component that calls `useReactFlow()`.

**Option B**: Keep the current structure; move only the node click handler logic into a child `<Panel>` component that calls `useReactFlow()`.

Option A is cleaner and matches the React Flow documentation pattern.

### dagre → ELK.js Migration Path

If namespace group containers (Tier 3, item 11) are pursued:
1. Install `elkjs` and `web-worker` packages
2. Replace `applyDagreLayout` with an async `applyElkLayout` function
3. Handle async layout with `useState` + `useEffect`
4. Group nodes require `extent: 'parent'` on child agent nodes
5. ELK layout options: `elk.algorithm: 'layered'`, `elk.direction: 'RIGHT'`

The migration is self-contained: all layout logic lives in the `applyDagreLayout` function in `TopologyGraph.tsx`.

### `animateMotion` and Path IDs

React Flow renders edge SVG paths without exposing `id` attributes on the `<path>` element. To use `<mpath href="#id">`, you need to:
1. Render a duplicate hidden `<path>` with a stable `id` based on `props.id`
2. Or use `keyPoints`/`keyTimes` on `<animateMotion>` directly with `path` attribute instead of `<mpath>`

The `path` attribute approach is simpler:
```tsx
<animateMotion dur="2s" repeatCount="indefinite" path={edgePath} />
```

`edgePath` is already available from `getBezierPath()`.

### `colorMode` and Tailwind CSS 4

React Flow's `colorMode="system"` adds a `dark` class to the `.react-flow__renderer` wrapper div (not to `html`). This means:
- React Flow's internal CSS variables respond to dark mode correctly
- Tailwind classes on custom nodes (which use `html.dark`) are unaffected — they already work via the existing Tailwind dark mode setup

No conflict exists between React Flow's dark mode and Tailwind CSS 4's dark mode.

---

## Research Gaps and Limitations

- No direct test of `animateMotion` with `path` attribute vs `<mpath>` in @xyflow/react v12 — implementation may require a small proof of concept
- ELK.js sub-flow layout time complexity for 20+ agents not benchmarked — the official React Flow docs note it is "the most complicated" option
- Grafana's arc indicator implementation uses a Grafana-specific data schema — the DorkOS health ring must be designed from scratch (not a port)
- No data source for edge "weight" / message throughput yet — the edge width variation enhancement depends on Relay metrics being exposed to the topology API

---

## Search Methodology

- **Searches performed**: 14
- **WebFetch calls**: 7
- **Most productive search terms**: "@xyflow/react v12 advanced features", "React Flow contextual zoom level of detail", "Kiali topology visualization UX", "Grafana node graph panel", "React Flow built-in components", "Datadog APM service map design patterns"
- **Primary information sources**: reactflow.dev docs, kiali.io docs, grafana.com docs, docs.datadoghq.com, xyflow GitHub, calmtech.com

---

## Sources

- [React Flow 12 Release](https://xyflow.com/blog/react-flow-12-release)
- [Custom Nodes — React Flow](https://reactflow.dev/learn/customization/custom-nodes)
- [Custom Edges — React Flow](https://reactflow.dev/learn/customization/custom-edges)
- [Built-In Components — React Flow](https://reactflow.dev/learn/concepts/built-in-components)
- [Contextual Zoom — React Flow](https://reactflow.dev/examples/interaction/contextual-zoom)
- [Expand and Collapse — React Flow](https://reactflow.dev/examples/layout/expand-collapse)
- [Animating Edges — React Flow](https://reactflow.dev/examples/edges/animating-edges)
- [Edge Toolbar — React Flow](https://reactflow.dev/examples/edges/edge-toolbar)
- [Node Toolbar — React Flow](https://reactflow.dev/examples/nodes/node-toolbar)
- [NodeToolbar API — React Flow](https://reactflow.dev/api-reference/components/node-toolbar)
- [MiniMap API — React Flow](https://reactflow.dev/api-reference/components/minimap)
- [Background API — React Flow](https://reactflow.dev/api-reference/components/background)
- [Layouting Overview — React Flow](https://reactflow.dev/learn/layouting/layouting)
- [ELK.js Example — React Flow](https://reactflow.dev/examples/layout/elkjs)
- [Sub Flows — React Flow](https://reactflow.dev/learn/layouting/sub-flows)
- [Performance — React Flow](https://reactflow.dev/learn/advanced-use/performance)
- [Zoom Transitions — React Flow](https://reactflow.dev/examples/interaction/zoom-transitions)
- [React Flow Pro Examples](https://reactflow.dev/pro/examples)
- [Kiali Topology Features](https://kiali.io/docs/features/topology/)
- [Grafana Node Graph Panel](https://grafana.com/docs/grafana/latest/visualizations/panels-visualizations/visualizations/node-graph/)
- [Datadog Service Map](https://docs.datadoghq.com/tracing/services/services_map/)
- [Headlamp 2025 Highlights](https://kubernetes.io/blog/2026/01/22/headlamp-in-2025-project-highlights/)
- [Calm Technology Principles](https://calmtech.com/)
- [Calm Tech Institute Principles](https://www.calmtech.institute/calm-tech-principles)
- [Smart Edge Library](https://github.com/tisoap/react-flow-smart-edge)
- [Animated SVG Edge — React Flow](https://reactflow.dev/ui/components/animated-svg-edge)
- [Edge Markers — React Flow](https://reactflow.dev/examples/edges/markers)
