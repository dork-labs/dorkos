---
slug: mesh-topology-elevation
number: 67
created: 2026-02-26
status: specified
---

# Specification: Mesh Topology Chart Elevation

**Spec:** #67
**Author:** Claude Code
**Date:** 2026-02-26
**Status:** Draft
**Source:** [Ideation](./01-ideation.md)

---

## 1. Overview

Elevate the Mesh topology chart from a functional React Flow visualization to a world-class, living system map. The topology will communicate agent health, relay adapter status, pulse schedule presence, cross-namespace permissions, and agent identity — all through progressive disclosure that rewards exploration while maintaining the Calm Tech minimalist aesthetic.

This specification covers three tiers of enhancements:

1. **Visual Foundation** — Background dots, MiniMap, deny edges, CSS variable theming, fitView animation, auto-refresh polling
2. **Core Elevation** — Fly-to selection animation, NodeToolbar quick actions, contextual zoom LOD (3 detail levels), health pulse ring, Relay/Pulse indicator row, AgentHealthDetail slide-in animation, edge label show-on-hover
3. **Signature Delight** — Animated SVG flow particles on allow edges, ELK.js namespace group containers replacing dagre hub-spoke, namespace group active/total count with pulse glow

## 2. Background / Problem Statement

The current topology visualization is functional but basic:

- No background grid or MiniMap for spatial context
- Agent nodes show minimal data (name, health dot, runtime badge, 2 capabilities) with no hover/selection states
- Cross-namespace edges use hardcoded `#3b82f6` instead of design system tokens
- Deny rules are silently dropped — users cannot see what's blocked
- No indication of which agents have Relay adapters or Pulse schedules
- Hub-spoke layout doesn't visually group agents within their namespace
- No fly-to animation when selecting agents
- AgentHealthDetail panel appears without entrance animation
- No contextual zoom — same detail level at all zoom levels

Industry topology visualizations (Grafana Node Graph, Datadog Service Map, Kiali) set expectations for health rings, progressive disclosure, flow particles, and semantic color. Users exploring the DorkOS mesh deserve the same level of polish.

## 3. Goals

- Every visible element communicates system state — no decorative chrome
- Progressive disclosure across 4 tiers: at-a-glance → hover → selected → click
- Agents display cross-subsystem context (Relay adapters, Pulse schedules) inline
- Namespace boundaries are visually clear through ELK.js group containers
- Deny rules are visible as distinct red dashed edges
- Animated flow particles on allow edges communicate data flow direction
- Contextual zoom LOD rewards exploration at high zoom levels
- All animations respect `prefers-reduced-motion`
- Smooth 60fps performance at 20+ agents with animations enabled
- Design system compliance: CSS variables, Calm Tech palette, 8pt grid

## 4. Non-Goals

- Real-time traffic metrics on edges (Relay telemetry not rich enough)
- Drag-to-rearrange nodes (topology is infrastructure data, not user diagram)
- Force-directed layout (unstable positions violate Calm Tech predictability)
- Edge creation/deletion via UI (ACL management stays in the Access tab)
- Collaborative multi-user editing
- React Flow Pro subscription features

## 5. Technical Dependencies

| Dependency      | Version              | Purpose                                                                      |
| --------------- | -------------------- | ---------------------------------------------------------------------------- |
| `@xyflow/react` | `^12.10.1` (current) | React Flow — custom nodes, edges, Background, MiniMap, NodeToolbar, Controls |
| `elkjs`         | `^0.9.x` (NEW)       | Async layered layout with compound/group node support                        |
| `dagre`         | `^0.8.5` (REMOVE)    | Current layout engine — replaced by ELK.js                                   |
| `motion`        | `^12.33.0` (current) | AgentHealthDetail slide animation                                            |
| `lucide-react`  | current              | Icons for indicators and toolbar actions                                     |

**Hard dependency:** Spec #66 (Agents as First-Class Entity) must be implemented before or alongside this work. The Agent Settings Dialog, color/emoji identity overrides, and persona display are required for the NodeToolbar [Settings] action and expanded node detail.

### Related ADRs

- **ADR-0035**: Use @xyflow/react (React Flow v12) for Mesh Topology Visualization
- **ADR-0032**: Use Hybrid Filesystem + Manifest Namespace Derivation
- **ADR-0033**: Use Default-Deny Cross-Namespace with Subject-Pattern ACLs
- **ADR-0036**: Compute Agent Health Status at Query Time via SQL

## 6. Detailed Design

### 6.1 React Flow Canvas Foundation (`TopologyGraph.tsx`)

Add React Flow built-in components and configure the canvas for design system compliance.

**New components inside `<ReactFlow>`:**

```tsx
import { Background, MiniMap, Controls } from '@xyflow/react';

<ReactFlow
  nodes={nodes}
  edges={edges}
  nodeTypes={NODE_TYPES}
  edgeTypes={EDGE_TYPES}
  onNodeClick={handleNodeClick}
  fitView
  fitViewOptions={{ duration: 400, padding: 0.15 }}
  colorMode="system"
  onlyRenderVisibleElements
  nodesConnectable={false}
  proOptions={{ hideAttribution: true }}
>
  <Background variant="dots" gap={20} size={1} color="var(--color-border)" />
  <MiniMap
    nodeColor={(n) => n.data?.namespaceColor ?? '#94a3b8'}
    pannable
    zoomable
    style={{ height: 80 }}
  />
  <Controls showInteractive={false} />
  <TopologyLegend namespaces={legendEntries} />
</ReactFlow>;
```

**CSS variable scoping** — Add a wrapper class for design system theming:

```css
.topology-container .react-flow {
  --xy-background-pattern-dots-color-default: var(--color-border);
  --xy-node-background-color-default: var(--color-card);
  --xy-node-border-default: 1px solid var(--color-border);
  --xy-node-boxshadow-hover-default: 0 0 0 2px var(--color-primary);
  --xy-node-boxshadow-selected-default: 0 0 0 2px var(--color-primary);
  --xy-edge-stroke-default: var(--color-border);
  --xy-edge-stroke-width-default: 1.5;
}
```

**Auto-refresh polling** — Add `refetchInterval: 15_000` to `useTopology()` query options. Track first-load state with a ref to only trigger `fitView` on initial render, not on refetches:

```tsx
const isFirstLoad = useRef(true);
// In useMemo that builds nodes/edges:
if (isFirstLoad.current && nodes.length > 0) {
  isFirstLoad.current = false;
  // fitView triggers via the fitView prop on ReactFlow
}
```

### 6.2 ELK.js Layout Migration (`TopologyGraph.tsx`)

Replace dagre with ELK.js for all layout computation.

**Install:** `pnpm --filter=@dorkos/client add elkjs`
**Remove:** `pnpm --filter=@dorkos/client remove dagre`

**New `applyElkLayout()` async function:**

```tsx
import ELK from 'elkjs/lib/elk.bundled.js';

const elk = new ELK();

async function applyElkLayout(
  nodes: Node[],
  edges: Edge[],
  namespaces: NamespaceInfo[]
): Promise<Node[]> {
  const multiNamespace = namespaces.length > 1;

  // Build ELK graph with compound nodes for namespaces
  const children = multiNamespace
    ? namespaces.map((ns, idx) => ({
        id: `group:${ns.namespace}`,
        layoutOptions: {
          'elk.padding': '[left=12, top=40, right=12, bottom=12]',
        },
        children: ns.agents.map((agent) => ({
          id: agent.id,
          width: 200,
          height: 72,
        })),
      }))
    : nodes.map((n) => ({
        id: n.id,
        width: n.type === 'agent' ? 200 : 120,
        height: n.type === 'agent' ? 72 : 36,
      }));

  const elkEdges = edges.map((e) => ({
    id: e.id,
    sources: [e.source],
    targets: [e.target],
  }));

  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.spacing.nodeNode': '60',
      'elk.spacing.edgeEdge': '20',
      'elk.layered.spacing.nodeNodeBetweenLayers': '80',
    },
    children,
    edges: elkEdges,
  };

  const layouted = await elk.layout(graph);
  // Map ELK positions back to React Flow nodes...
  return mappedNodes;
}
```

**Async layout handling** — Use `useState` + `useEffect` pattern with a loading skeleton during layout computation:

```tsx
const [layoutedNodes, setLayoutedNodes] = useState<Node[]>([]);
const [isLayouting, setIsLayouting] = useState(true);

useEffect(() => {
  if (!rawNodes.length) return;
  setIsLayouting(true);
  applyElkLayout(rawNodes, rawEdges, namespaces)
    .then(setLayoutedNodes)
    .finally(() => setIsLayouting(false));
}, [rawNodes, rawEdges, namespaces]);
```

### 6.3 Namespace Group Containers (NEW: `NamespaceGroupNode.tsx`)

Replace `NamespaceHubNode` + spoke edges with visual group containers when multiple namespaces exist.

**Component structure:**

```tsx
export interface NamespaceGroupData extends Record<string, unknown> {
  namespace: string;
  agentCount: number;
  activeCount: number;
  color: string;
  collapsed: boolean;
}

function NamespaceGroupNodeComponent({ data }: NodeProps) {
  const d = data as unknown as NamespaceGroupData;
  return (
    <div
      className="bg-card/50 rounded-xl border-2"
      style={{
        borderColor: `${d.color}40`,
        backgroundColor: `${d.color}08`,
        minWidth: 240,
        minHeight: 100,
      }}
    >
      {/* Header bar */}
      <div
        className="flex items-center gap-2 rounded-t-xl px-3 py-1.5"
        style={{ backgroundColor: `${d.color}15` }}
      >
        <span className="text-xs font-semibold" style={{ color: d.color }}>
          {d.namespace}
        </span>
        <span className="text-muted-foreground text-[10px]">
          {d.activeCount}/{d.agentCount} agents
        </span>
        {d.activeCount > 0 && (
          <span
            className="h-1.5 w-1.5 animate-pulse rounded-full"
            style={{ backgroundColor: d.color }}
          />
        )}
      </div>
      {/* Children are positioned inside by ELK + extent: 'parent' */}
    </div>
  );
}

export const NamespaceGroupNode = memo(NamespaceGroupNodeComponent);
```

**React Flow group integration** — Use `type: 'group'` with `parentId` and `extent: 'parent'` on child agent nodes:

```tsx
// Group node
{ id: `group:${ns.namespace}`, type: 'namespace-group', position, data, style: { width, height } }

// Agent node inside group
{ id: agent.id, type: 'agent', parentId: `group:${ns.namespace}`, extent: 'parent', position, data }
```

**Collapsible groups** — Click header to toggle `collapsed` state. When collapsed, hide child agents and re-trigger ELK layout with the group as a single node.

**NamespaceEdge removal** — With agents inside group containers, spoke edges are no longer needed. Remove `NamespaceEdge.tsx`. Cross-namespace edges connect directly between agent nodes or terminate at group borders.

### 6.4 Enhanced AgentNode — 3-Level Contextual Zoom LOD (`AgentNode.tsx`)

Read zoom level from React Flow's internal store and render different detail levels.

```tsx
import { useStore, NodeToolbar, Position } from '@xyflow/react';

const zoomSelector = (s: ReactFlowState) => s.transform[2];

function AgentNodeComponent({ data, selected }: NodeProps) {
  const zoom = useStore(zoomSelector);
  const d = data as unknown as AgentNodeData;

  if (zoom < 0.6) return <CompactPill d={d} />;
  if (zoom > 1.2) return <ExpandedCard d={d} selected={selected} />;
  return <DefaultCard d={d} selected={selected} />;
}
```

**Zoom < 0.6 — Compact Pill (120×28px):**

- Pill shape with rounded-full corners
- Health status dot (with `animate-ping` if active) + truncated name
- Namespace accent left border
- No badges, indicators, or handles visible

**Zoom 0.6–1.2 — Default Card (200×72px, enhanced from current 180×60):**

- Health pulse ring: outer `animate-ping` ring for active agents (green/30% opacity), gated on `prefers-reduced-motion`
- Agent name (truncated) + runtime as a 14px icon in top-right (not a badge)
- Up to 3 capability badges + `+N` overflow badge
- **Indicator row** (bottom): Relay Zap icon (if `relayAdapters.length > 0`) + Pulse Clock icon with count (if `pulseScheduleCount > 0`)
- Agent color override from spec #66 for left border (falls back to namespace color)
- Agent emoji override from spec #66 before name (when present)

**Zoom > 1.2 — Expanded Card (240×120px):**

- Everything from default card PLUS:
- Description text (1-2 lines, `line-clamp-2`)
- Last seen timestamp (relative: `2m ago`, `1h ago`)
- Budget display: `100 calls/hr · 5 max hops`
- Individual Relay adapter names (Telegram, Slack, etc.) instead of Zap icon
- Behavior mode badge (`always`/`direct-only`/`mention-only`/`silent`)

**Smooth transitions** — Use CSS `transition: all 150ms ease` on the card wrapper for smooth morphing between zoom levels.

### 6.5 NodeToolbar Quick Actions (`AgentNode.tsx`)

Add a floating toolbar that appears when an agent node is selected:

```tsx
import { NodeToolbar, Position } from '@xyflow/react';

<NodeToolbar position={Position.Top} isVisible={selected}>
  <div className="bg-card flex items-center gap-1 rounded-lg border px-1.5 py-1 shadow-md">
    <ToolbarButton icon={Settings} label="Settings" onClick={onOpenSettings} />
    <ToolbarButton icon={Heart} label="Health" onClick={onViewHealth} />
    <ToolbarButton icon={Copy} label="Copy ID" onClick={onCopyId} />
  </div>
</NodeToolbar>;
```

**Actions:**

| Button   | Icon                | Action                                                |
| -------- | ------------------- | ----------------------------------------------------- |
| Settings | `Settings` (lucide) | Opens Agent Settings Dialog (spec #66) for this agent |
| Health   | `Heart` (lucide)    | Opens/focuses AgentHealthDetail side panel            |
| Copy ID  | `Copy` (lucide)     | Copies agent ULID to clipboard, shows toast           |

The toolbar uses `bg-card border shadow-md rounded-lg` styling. Each action is a small icon button (24×24px) with a Tooltip on hover.

### 6.6 Agent Settings Dialog Integration

When [Settings] is clicked in NodeToolbar:

1. Emit `onOpenSettings(agentId)` callback up to `MeshPanel`
2. `MeshPanel` opens the Agent Settings Dialog (from spec #66) with the selected agent's data
3. Dialog shows 4 tabs: Identity, Persona, Capabilities, Connections
4. Connections tab displays: Relay adapters, Pulse schedules, Mesh access rules for this agent
5. On save, invalidate the topology query to refresh node data

**This is a hard dependency on spec #66** — the `AgentSettingsDialog` component must exist. If spec #66 is not yet implemented, the Settings toolbar button should be hidden or disabled.

### 6.7 Enhanced Edges

#### CrossNamespaceEdge — Allow Rules (`CrossNamespaceEdge.tsx`)

**Theming fix:** Replace hardcoded `#3b82f6` with `var(--color-primary)`.

**Flow particles:** Add animated SVG circle traveling along the edge path:

```tsx
<BaseEdge id={id} path={edgePath} style={{ stroke: 'var(--color-primary)', strokeWidth: 2 }} />;

{
  /* Flow particle — skipped when prefers-reduced-motion */
}
{
  !prefersReducedMotion && (
    <circle r="3" fill="var(--color-primary)" opacity="0.7">
      <animateMotion dur="3s" repeatCount="indefinite" path={edgePath} />
    </circle>
  );
}
```

**Conditional labels:** Edge label only shows when `selected` or hovered:

```tsx
{
  (selected || isHovered) && label && <EdgeLabelRenderer>...</EdgeLabelRenderer>;
}
```

**Reduced motion detection:**

```tsx
const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
```

#### DenyEdge — Deny Rules (NEW: `DenyEdge.tsx`)

New edge component for deny rules that are currently silently dropped:

```tsx
export function DenyEdge(props: EdgeProps) {
  const [edgePath] = getBezierPath({ ... });
  return (
    <BaseEdge
      id={props.id}
      path={edgePath}
      style={{
        stroke: 'var(--color-destructive)',
        strokeWidth: 1.5,
        strokeDasharray: '4 4',
        opacity: selected || isHovered ? 1 : 0.5,
      }}
    />
  );
}
```

- Red dashed line (`var(--color-destructive)`)
- 50% opacity by default, full on hover/select
- No arrowhead (deny = no flow)
- No animation, no particle

**Edge type registration:**

```tsx
const EDGE_TYPES: EdgeTypes = {
  'cross-namespace': CrossNamespaceEdge,
  'cross-namespace-deny': DenyEdge,
};
```

**Topology node/edge construction** — Include deny rules alongside allow rules:

```tsx
for (const rule of accessRules ?? []) {
  rawEdges.push({
    id: `e:${rule.sourceNamespace}-${rule.targetNamespace}-${rule.action}`,
    source: /* source agent or group */,
    target: /* target agent or group */,
    type: rule.action === 'allow' ? 'cross-namespace' : 'cross-namespace-deny',
    data: { label: `${rule.sourceNamespace} › ${rule.targetNamespace}` },
  });
}
```

### 6.8 AgentHealthDetail Slide Animation (`AgentHealthDetail.tsx`)

Wrap the side panel in a motion animation:

```tsx
import { motion, AnimatePresence } from 'motion/react';

// In MeshPanel:
<AnimatePresence>
  {selectedAgentId && (
    <motion.div
      key={selectedAgentId}
      initial={{ x: 64, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 64, opacity: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="w-64 border-l"
    >
      <AgentHealthDetail agentId={selectedAgentId} />
    </motion.div>
  )}
</AnimatePresence>;
```

Add an "Open Settings" button at the bottom of `AgentHealthDetail` that opens the Agent Settings Dialog (spec #66 dependency).

### 6.9 Fly-to Selection Animation (`TopologyGraph.tsx`)

When a node is selected, smoothly animate the viewport to center on it:

```tsx
import { useReactFlow } from '@xyflow/react';

// Inside an inner component wrapped in ReactFlowProvider:
const { setCenter, getZoom } = useReactFlow();

const handleNodeClick = useCallback(
  (_: React.MouseEvent, node: Node) => {
    if (node.type !== 'agent') return;
    onSelectAgent?.(node.id);

    const targetZoom = Math.max(getZoom(), 1.0);
    setCenter(
      node.position.x + 100, // offset to center of 200px node
      node.position.y + 36, // offset to center of 72px node
      { zoom: targetZoom, duration: 350 }
    );
  },
  [onSelectAgent, setCenter, getZoom]
);
```

**ReactFlowProvider requirement** — `useReactFlow()` requires the component to be inside a `<ReactFlowProvider>`. Either wrap `TopologyGraph` in MeshPanel, or create an inner `TopologyGraphInner` component.

### 6.10 Server-Side Data Enrichment (`GET /api/mesh/topology`)

Extend the topology endpoint response to include enriched per-agent data. This avoids N+1 client-side queries.

**Schema changes** (`packages/shared/src/mesh-schemas.ts`):

Add optional enrichment fields to `AgentManifestSchema` or create an `EnrichedAgentSchema`:

```typescript
export const TopologyAgentSchema = AgentManifestSchema.extend({
  healthStatus: AgentHealthStatusSchema.default('stale'),
  relayAdapters: z.array(z.string()).default([]),
  relaySubject: z.string().nullable().default(null),
  pulseScheduleCount: z.number().int().default(0),
  lastSeenAt: z.string().nullable().default(null),
  lastSeenEvent: z.string().nullable().default(null),
});

export type TopologyAgent = z.infer<typeof TopologyAgentSchema>;
```

Update `NamespaceInfoSchema` to use `TopologyAgentSchema`:

```typescript
export const NamespaceInfoSchema = z.object({
  namespace: z.string(),
  agentCount: z.number().int(),
  agents: z.array(TopologyAgentSchema),
});
```

**Server-side joins** (`apps/server/src/routes/mesh.ts`):

For each agent in the topology response, enrich with:

| Field                | Source                                  | Join Logic                                                 |
| -------------------- | --------------------------------------- | ---------------------------------------------------------- |
| `relayAdapters`      | RelayCore adapter list                  | Filter adapters by agent's CWD or relay subject            |
| `relaySubject`       | Agent config or Relay endpoint registry | Lookup by agent ID                                         |
| `pulseScheduleCount` | PulseStore                              | Count schedules where `cwd` matches agent's registered CWD |
| `lastSeenAt`         | AgentHealth (SQL query-time computed)   | Already available from health endpoint                     |
| `lastSeenEvent`      | AgentHealth                             | Already available from health endpoint                     |
| `healthStatus`       | AgentHealth                             | Already computed at query time per ADR-0036                |

### 6.11 Updated TopologyLegend (`TopologyLegend.tsx`)

Add entries for new visual elements:

| Element         | Visual                        | Description                               |
| --------------- | ----------------------------- | ----------------------------------------- |
| Allow edge      | Blue dashed line + moving dot | Cross-namespace allow rule with data flow |
| Deny edge       | Red dashed line               | Cross-namespace deny rule                 |
| Active agent    | Green dot + pulse ring        | Agent heartbeat within 5 minutes          |
| Inactive agent  | Amber dot                     | Agent heartbeat within 30 minutes         |
| Stale agent     | Gray dot                      | No heartbeat for 30+ minutes              |
| Relay indicator | Zap icon                      | Agent has active Relay adapters           |
| Pulse indicator | Clock icon                    | Agent has Pulse schedules                 |
| Zoom hint       | —                             | "Zoom in for more detail"                 |

## 7. User Experience

### Progressive Disclosure (4 Tiers)

**Tier 0 — At-a-glance (always on node):**
Agent name (truncated), health status dot/ring, runtime icon, Relay/Pulse indicator icons

**Tier 1 — Hover (Tooltip):**
Full agent name, last seen timestamp, capability tags (up to 5), budget summary, relay subject

**Tier 2 — Selected (NodeToolbar):**
Floating action bar: [Settings] [Health] [Copy ID]

**Tier 3 — Click (Side panel):**
AgentHealthDetail slides in from right. Full capabilities, budget, behavior config, last seen event. "Open Settings" button links to Agent Settings Dialog (spec #66).

### Fly-to Selection

Selecting an agent smoothly pans and zooms the viewport to center on the node. The zoom level is maintained or increased to at least 1.0x to ensure the node is readable.

### Namespace Groups

Multi-namespace topologies display agents inside rounded-xl group containers with namespace accent colors. Groups are collapsible via header click. Single-namespace topologies skip the group wrapper for cleaner display.

## 8. Data Model Changes

### AgentNodeData (client-side)

Extended from current:

```typescript
export interface AgentNodeData extends Record<string, unknown> {
  label: string;
  runtime: string;
  healthStatus: 'active' | 'inactive' | 'stale';
  capabilities: string[];
  namespace?: string;
  namespaceColor?: string;
  // NEW fields from server enrichment:
  description?: string;
  relayAdapters?: string[];
  relaySubject?: string | null;
  pulseScheduleCount?: number;
  lastSeenAt?: string | null;
  lastSeenEvent?: string | null;
  budget?: { maxHopsPerMessage: number; maxCallsPerHour: number };
  behavior?: { responseMode: string };
  // NEW fields from spec #66:
  color?: string | null;
  emoji?: string | null;
}
```

### TopologyView (shared schema)

The `agents` array within each namespace now uses `TopologyAgentSchema` which extends `AgentManifestSchema` with health and enrichment fields.

## 9. API Changes

### Modified: `GET /api/mesh/topology`

**Response changes:**

Each agent in `namespaces[].agents[]` now includes:

```json
{
  "id": "01JMXYZ...",
  "name": "code-reviewer",
  "runtime": "claude-code",
  "healthStatus": "active",
  "relayAdapters": ["telegram", "slack"],
  "relaySubject": "relay.agent.code-reviewer",
  "pulseScheduleCount": 2,
  "lastSeenAt": "2026-02-26T18:30:00Z",
  "lastSeenEvent": "heartbeat",
  "capabilities": ["code-review", "testing"],
  "budget": { "maxHopsPerMessage": 5, "maxCallsPerHour": 100 },
  "behavior": { "responseMode": "always" },
  "description": "Reviews PRs for code quality",
  "color": "#6366f1",
  "emoji": "🔍"
}
```

**Backward compatibility:** All new fields have defaults (empty arrays, null, 0) so existing clients won't break.

## 10. Testing Strategy

### Unit Tests

**`AgentNode.test.tsx`:**

- Renders compact pill at zoom < 0.6 (mock `useStore` to return low zoom)
- Renders default card at zoom 0.6–1.2
- Renders expanded card at zoom > 1.2 with description, budget, adapters
- Shows health pulse ring only for active agents
- Shows Relay/Pulse indicators when data present
- Hides indicators when data absent
- Applies agent color override for left border
- Prepends emoji when present

**`NamespaceGroupNode.test.tsx`:**

- Renders namespace name and agent count
- Shows active/total count correctly
- Pulse glow visible when activeCount > 0

**`DenyEdge.test.tsx`:**

- Renders red dashed line with correct CSS
- 50% opacity by default
- No animation elements present (no `<animateMotion>`)

**`CrossNamespaceEdge.test.tsx`:**

- Uses `var(--color-primary)` instead of hardcoded blue
- Flow particle present when reduced motion not preferred
- Flow particle absent when reduced motion preferred
- Label only visible when selected

**`TopologyGraph.test.tsx`:**

- ELK layout produces positioned nodes
- Background and MiniMap components rendered
- Deny rules create `cross-namespace-deny` edge type
- Auto-refresh: `useTopology` called with `refetchInterval: 15000`

### Integration Tests

**Server topology enrichment:**

- Relay adapter names included in topology response
- Pulse schedule count included per agent
- Health status computed correctly
- Empty/null defaults for agents without Relay/Pulse data

### Mocking Strategy

- Mock `useStore` to return specific zoom values for LOD tests
- Mock `useReactFlow` for fly-to animation tests
- Mock `window.matchMedia` for `prefers-reduced-motion` tests
- Mock `elkjs` layout for deterministic node positioning in snapshot tests

## 11. Performance Considerations

| Concern                         | Mitigation                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------ |
| ELK.js async layout             | `useState` + `useEffect` with loading skeleton; layout runs off main thread          |
| SVG `<animateMotion>`           | Runs on compositor thread, no JS cost; skipped with `prefers-reduced-motion`         |
| `animate-ping` on active agents | GPU-accelerated (transform + opacity only)                                           |
| 20+ nodes with animations       | `onlyRenderVisibleElements` skips off-screen rendering                               |
| MiniMap repaints                | `nodeColor` callback is pure, React.memo on nodes prevents unnecessary rerenders     |
| Auto-refresh (15s polling)      | Only refetches data; `fitView` only on first load; React Flow diffs node/edge arrays |
| ELK.js bundle size              | ~150KB; lazy-loaded with `TopologyGraph` via `React.lazy()`                          |
| `useStore(zoomSelector)`        | Selector pattern prevents re-render on non-zoom store changes                        |

**Target:** 60fps at 20 agents with all Tier 1-3 features active. For 50+ agents, consider throttling animations to visible nodes only.

## 12. Security Considerations

- No new user input surfaces (topology is read-only display)
- Agent IDs copied to clipboard are ULIDs (no sensitive data)
- Server-side topology enrichment uses existing authenticated endpoints
- Relay adapter names are metadata, not credentials
- No changes to ACL management (stays in Access tab)

## 13. Documentation

- Update `contributing/animations.md` with flow particle pattern and `prefers-reduced-motion` gating
- Update `docs/mesh/topology.mdx` with new visual features and zoom LOD behavior
- No new developer guides needed (implementation follows existing React Flow patterns from ADR-0035)

## 14. Implementation Phases

### Phase 1: Visual Foundation

- Add `<Background>`, `<MiniMap>`, `colorMode="system"`, `onlyRenderVisibleElements`, `nodesConnectable={false}`
- CSS variable theming (replace hardcoded colors)
- `fitView` with `duration: 400, padding: 0.15`
- Auto-refresh polling (`refetchInterval: 15_000`)
- DenyEdge component (red dashed, no animation)
- Register deny edges in topology construction

### Phase 2: ELK.js Layout Migration

- Install `elkjs`, remove `dagre`
- Implement `applyElkLayout()` async function
- Add async layout state management (loading skeleton)
- NamespaceGroupNode component
- Agent nodes as children of groups (`parentId`, `extent: 'parent'`)
- Remove NamespaceHubNode and NamespaceEdge
- Cross-namespace edges connect agents/groups directly

### Phase 3: Node Enhancement

- Contextual zoom LOD (3 detail levels via `useStore`)
- Health pulse ring animation
- Indicator row (Relay Zap + Pulse Clock)
- Agent color/emoji overrides (spec #66 integration)
- Smooth CSS transitions between zoom levels

### Phase 4: Interactions & Animations

- NodeToolbar with Settings/Health/Copy actions
- Agent Settings Dialog integration (spec #66 dependency)
- Fly-to selection animation (`useReactFlow().setCenter()`)
- AgentHealthDetail slide-in/out with `motion`
- Edge label show-on-hover/selected
- Animated SVG flow particles on allow edges
- `prefers-reduced-motion` gating on all animations

### Phase 5: Server Enrichment

- Extend `TopologyView` schema with enrichment fields
- Server-side joins for Relay adapters, Pulse counts, health data
- Updated TopologyLegend with new visual elements
- Client-side AgentNodeData interface update

## 15. Open Questions

1. ~~**ELK.js bundle variant**~~ (RESOLVED)
   **Answer:** Use `elkjs/lib/elk.bundled.js` (synchronous variant). The web-worker variant adds complexity without meaningful benefit at 3-50 node scale. Can switch to worker variant later if layout computation exceeds 100ms.

2. **Group collapse persistence** — Should collapsed/expanded state persist across page refreshes (localStorage) or reset each time?

3. **Tooltip implementation** — Use React Flow's built-in tooltip pattern or the existing shared `<Tooltip>` component from shadcn? The shared Tooltip is consistent with the rest of the app, but may conflict with React Flow's coordinate system.

## 16. File Manifest

### Modified Files

| File                                                             | Changes                                                                                  |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx`      | ELK.js migration, Background, MiniMap, CSS vars, fly-to, auto-refresh, ReactFlowProvider |
| `apps/client/src/layers/features/mesh/ui/AgentNode.tsx`          | 3-level zoom LOD, health pulse, indicator row, NodeToolbar, emoji/color                  |
| `apps/client/src/layers/features/mesh/ui/CrossNamespaceEdge.tsx` | Flow particles, theme colors, conditional labels, reduced-motion                         |
| `apps/client/src/layers/features/mesh/ui/AgentHealthDetail.tsx`  | Slide animation wrapper, "Open Settings" button                                          |
| `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`          | ReactFlowProvider wrap, AnimatePresence, Agent Dialog state                              |
| `apps/client/src/layers/features/mesh/ui/TopologyLegend.tsx`     | New legend entries for deny, particles, indicators                                       |
| `apps/server/src/routes/mesh.ts`                                 | Topology endpoint enrichment (Relay/Pulse/health joins)                                  |
| `packages/shared/src/mesh-schemas.ts`                            | TopologyAgentSchema, updated NamespaceInfoSchema                                         |

### New Files

| File                                                             | Purpose                        |
| ---------------------------------------------------------------- | ------------------------------ |
| `apps/client/src/layers/features/mesh/ui/DenyEdge.tsx`           | Deny rule edge component       |
| `apps/client/src/layers/features/mesh/ui/NamespaceGroupNode.tsx` | Namespace group container node |

### Removed Files

| File                                                           | Reason                                             |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `apps/client/src/layers/features/mesh/ui/NamespaceHubNode.tsx` | Replaced by NamespaceGroupNode                     |
| `apps/client/src/layers/features/mesh/ui/NamespaceEdge.tsx`    | Spoke edges no longer needed with group containers |

## 17. Acceptance Criteria

- [ ] Background dot grid visible on canvas with proper dark/light theming
- [ ] MiniMap renders in corner with namespace-colored nodes
- [ ] Deny rules visible as red dashed edges on topology
- [ ] Animated flow particles travel along allow-rule cross-namespace edges
- [ ] Agents show health pulse ring (animated ping) when active
- [ ] Relay adapter icons and Pulse schedule count visible on agent nodes
- [ ] NodeToolbar appears on agent selection with Settings/Health/Copy actions
- [ ] Agent Settings Dialog opens from NodeToolbar (spec #66 integration)
- [ ] Contextual zoom: compact pill at zoom-out, full card at default, expanded at zoom-in
- [ ] Fly-to animation smoothly centers viewport on selected node
- [ ] AgentHealthDetail slides in/out with motion animation
- [ ] ELK.js layout positions agents inside namespace group containers
- [ ] Namespace groups show active/total count with accent color
- [ ] All animations respect `prefers-reduced-motion`
- [ ] Auto-refresh keeps topology current (15s polling) without re-triggering fitView
- [ ] Performance: smooth 60fps at 20+ agents with all animations
- [ ] No regressions in existing topology functionality
- [ ] Cross-namespace edges connect agents/groups directly (no spoke edges)

## 18. References

- [React Flow v12 — NodeToolbar API](https://reactflow.dev/api-reference/components/node-toolbar)
- [React Flow v12 — Sub-flows / Group Nodes](https://reactflow.dev/examples/grouping/sub-flows)
- [React Flow v12 — MiniMap](https://reactflow.dev/api-reference/components/minimap)
- [React Flow v12 — Theming / Color Mode](https://reactflow.dev/learn/customization/theming)
- [ELK.js — Layout API](https://github.com/kieler/elkjs)
- [Spec #66 — Agents as First-Class Entity](../agents-first-class-entity/02-specification.md)
- [ADR-0035 — Use @xyflow/react for Mesh Topology](../../decisions/0035-use-xyflow-react-for-mesh-topology.md)
- [Design System — Calm Tech](../../contributing/design-system.md)
- [Animations Guide](../../contributing/animations.md)
