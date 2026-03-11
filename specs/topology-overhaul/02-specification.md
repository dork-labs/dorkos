# Topology Visualization Overhaul — Specification

**Status:** Draft
**Authors:** Claude Code, 2026-03-11
**Spec Number:** 122
**Ideation:** `specs/topology-overhaul/01-ideation.md`
**Branch:** `preflight/topology-overhaul`

---

## Overview

Six targeted improvements to the React Flow topology visualization. Remove the Claude Code Adapter (CCA) as a graph node and show runtime as a badge on agent nodes. Always render namespace containers. Add a ghost adapter placeholder for progressive disclosure. Add MiniMap and Background built-in components. Surface adapter labels and binding filter badges from spec 120.

The underlying architecture — React Flow, ELK.js layout, LOD bands, `buildTopologyElements` pure function — is unchanged.

## Background / Problem Statement

The topology visualization has several UX issues:

1. **CCA noise**: The Claude Code Adapter appears as a graph node with binding edges to every agent. Since all agents use CCA by default, this conveys zero information and clutters the graph.
2. **Missing namespace containers**: `NamespaceGroupNode` containers only render when `namespaces.length > 1` (line 98 of `build-topology-elements.ts`). Single-namespace topologies — the common case — show agents floating without grouping context.
3. **No empty state guidance**: When no external relay adapters are configured, the graph lacks any hint about the relay capability.
4. **No spatial reference**: No MiniMap or Background dots. Panning/zooming feels disorienting, especially in larger topologies.
5. **Adapter identity gap**: Adapter nodes show type name only. With spec 120 adding multi-instance and labeling, topology needs to surface labels.
6. **Binding specificity hidden**: Bindings with `chatId`/`channelType` filters look identical to wildcard bindings. Users can't see routing specificity at a glance.

## Goals

- Remove CCA adapter node and its binding edges from the topology graph
- Show agent runtime (e.g., "Claude Code") as a styled badge on AgentNode
- Always render namespace containers, even with a single namespace
- Show a ghost adapter placeholder when no external adapters exist
- Add MiniMap and Background built-in React Flow components
- Surface adapter labels on adapter nodes
- Surface chatId/channelType filter badges on binding edges

## Non-Goals

- Health indicator upgrade (dot → arc ring SVG)
- NodeToolbar for secondary agent actions
- Animated SVG particles on edges (Kiali-style)
- Real-time message throughput counters on edges/nodes
- Click-to-expand/collapse namespace containers
- Dark mode `colorMode="system"` sync
- `onlyRenderVisibleElements` performance optimization
- Changes to ELK layout algorithm or direction
- Changes to the LOD band thresholds

## Technical Dependencies

- **@xyflow/react** v12 — React Flow library (already installed)
- **elkjs** — ELK.js layout engine (already installed)
- **lucide-react** — icons (already installed)
- No new external dependencies required.

## Detailed Design

### Area 1: Remove CCA as Graph Node

**File:** `build-topology-elements.ts`

**Current behavior (lines 76-95):** All adapters from `useRelayAdapters()` get adapter nodes. CCA is type `'claude-code'` (defined in `AdapterTypeSchema`, line 16 of `relay-adapter-schemas.ts`).

**Change:** Filter out CCA before creating adapter nodes:

```typescript
// Line 76 area — filter before iterating
const externalAdapters = adapters?.filter(
  (a) => a.config.type !== 'claude-code',
) ?? [];

if (relayEnabled && externalAdapters.length > 0) {
  for (const adapter of externalAdapters) {
    // ... existing adapter node creation (lines 78-94)
  }
}
```

**Binding edge filtering (lines 173-196):** Binding edges reference adapter nodes by ID pattern `adapter:${binding.adapterId}`. Since CCA adapter nodes no longer exist, the existing validation at lines 179-181 (`if (!allNodeIds.has(sourceId) || !allNodeIds.has(targetId))`) already skips orphaned edges. No additional change needed — CCA binding edges are automatically excluded because their source nodes don't exist.

**Runtime badge on AgentNode:** See Area 1b below.

### Area 1b: Runtime Badge on AgentNode

**File:** `AgentNode.tsx`

The `AgentNodeData` interface (lines 20-42) already has a `runtime` field (line 22). Currently rendered as small text. Replace with a styled badge.

**DefaultCard (line 139):** Add runtime badge below the agent name, above capability badges:

```tsx
{/* Runtime badge — visible at default and expanded LOD */}
{d.runtime && (
  <span className="inline-flex items-center rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
    {d.runtime}
  </span>
)}
```

**ExpandedCard (line 186):** Same badge, rendered in the expanded layout.

**CompactPill (line 115):** No runtime badge at compact LOD — only dot + truncated name, keeping pills small.

### Area 2: Always Show Namespace Containers

**File:** `build-topology-elements.ts`

**Current behavior (line 98):**

```typescript
const multiNamespace = namespaces.length > 1;
```

**Change:**

```typescript
const useGroups = namespaces.length >= 1;
```

The downstream code already handles this correctly:
- Lines 111-123: Group node creation iterates `namespaces` — works with 1 or more
- Lines 164-167: Agent nodes get `parentId` and `extent: 'parent'` when groups are used
- `elk-layout.ts` lines 56-76: ELK compound layout nesting works with any number of groups

**Variable rename:** Change `multiNamespace` to `useGroups` throughout the function to reflect the new semantics. The `TopologyElements` interface already exports `useGroups: boolean` (line 25).

**File:** `elk-layout.ts`

The `useGroups` parameter (line 34) already flows through. When `useGroups` is true, agents are nested inside group containers. When false, agents are standalone. No changes needed — the flag just gets set to `true` more often now.

### Area 3: Ghost Adapter Placeholder

**File:** `build-topology-elements.ts`

When relay is enabled but `externalAdapters` is empty (after filtering CCA), create a ghost node:

```typescript
if (relayEnabled && externalAdapters.length === 0) {
  rawNodes.push({
    id: 'ghost-adapter',
    type: 'adapter',
    position: { x: 0, y: 0 },
    data: {
      adapterName: 'Add Adapter',
      adapterType: 'ghost',
      adapterStatus: 'stopped',
      bindingCount: 0,
      isGhost: true,
    } satisfies AdapterNodeData,
  });
}
```

**File:** `AdapterNode.tsx`

**AdapterNodeData (lines 12-17):** Add `isGhost` flag:

```typescript
export interface AdapterNodeData {
  adapterName: string;
  adapterType: string;
  adapterStatus: 'running' | 'stopped' | 'error';
  bindingCount: number;
  label?: string;      // Area 5
  isGhost?: boolean;    // NEW
}
```

**AdapterNodeInner (line 76):** Ghost rendering:

```tsx
if (d.isGhost) {
  return (
    <div
      className="flex items-center gap-2 rounded-lg border border-dashed border-muted-foreground/30 bg-card/40 px-3 py-2 opacity-40 transition-opacity hover:opacity-70"
      style={{ width: ADAPTER_NODE_WIDTH, height: ADAPTER_NODE_HEIGHT }}
      onClick={onGhostClick}
    >
      <Plus className="size-4 text-muted-foreground" />
      <span className="text-sm text-muted-foreground">Add Adapter</span>
    </div>
  );
}
```

Ghost nodes have:
- Dashed border (`border-dashed`) with low-contrast color
- Reduced opacity (40%, rising to 70% on hover)
- `Plus` icon instead of platform icon
- No status dot
- No output handle (cannot drag-to-connect from ghost)
- Click handler opens adapter catalog

**Ghost click handler:** The `onGhostClick` callback is passed via `AdapterNodeData` or via a new callback in `AgentNodeCallbacks`. The `TopologyGraph` component provides this callback, which triggers the same action as clicking "Add" in the Adapters tab — opening the `AdapterSetupWizard`.

**File:** `use-topology-handlers.ts`

**Connection validation (line 149):** The existing `isValidConnection` check validates `sourceNode?.type === 'adapter'`. Ghost nodes are also type `'adapter'`, so add an additional check:

```typescript
const isValidConnection = useCallback((connection: Connection) => {
  const sourceNode = layoutedNodesRef.current.find((n) => n.id === connection.source);
  const targetNode = layoutedNodesRef.current.find((n) => n.id === connection.target);
  if (sourceNode?.data?.isGhost) return false; // Cannot connect from ghost
  return sourceNode?.type === 'adapter' && targetNode?.type === 'agent';
}, []);
```

**File:** `elk-layout.ts`

No changes needed. The ghost node is type `'adapter'` and gets the same `FIRST` layer constraint. It positions on the left side like real adapters.

### Area 4: MiniMap and Background

**File:** `TopologyGraph.tsx`

**Imports:** `Background` and `BackgroundVariant` are already imported (line 15-16). Add `MiniMap` to the import:

```typescript
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  MiniMap,
  Controls,
  // ...existing imports
} from '@xyflow/react';
```

**Inside the `<ReactFlow>` component (around line 240):** Add both components:

```tsx
<ReactFlow
  nodes={layoutedNodes}
  edges={layoutedEdges}
  // ...existing props
>
  <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="hsl(var(--muted-foreground) / 0.15)" />
  <MiniMap
    nodeColor={(node) => {
      if (node.type === 'adapter') return 'hsl(var(--muted-foreground) / 0.4)';
      if (node.type === 'namespace-group') return 'transparent';
      // Agent nodes: use namespace color if available
      const data = node.data as AgentNodeData;
      return data.namespaceColor ?? 'hsl(var(--primary))';
    }}
    maskColor="hsl(var(--background) / 0.8)"
    className="!bottom-2 !right-2"
  />
</ReactFlow>
```

**MiniMap node coloring:**
- Adapter nodes: neutral muted gray
- Namespace group nodes: transparent (they're containers, not meaningful in the minimap)
- Agent nodes: namespace accent color (falls back to primary)

**Background dots:** Subtle, using muted-foreground at 15% opacity. 16px gap matches the 8pt grid spacing convention.

### Area 5: Adapter Node Labels

**File:** `AdapterNode.tsx`

**AdapterNodeData (lines 12-17):** Add `label` field (shown above in Area 3 type definition).

**AdapterNodeInner rendering (line 85 area):** Two-line display:

```tsx
<div className="flex flex-col">
  <span className="text-sm font-medium">
    {d.label || d.adapterName}
  </span>
  <span className="text-xs text-muted-foreground">
    {d.label ? d.adapterName : ''}
  </span>
</div>
```

When `label` exists: label is primary text, adapter type name is secondary.
When no label: adapter name is primary, no secondary text (same as current behavior).

**File:** `build-topology-elements.ts`

When constructing adapter node data (lines 82-92), pass the label:

```typescript
data: {
  adapterName: adapter.config.displayName ?? adapter.config.type,
  adapterType: adapter.config.type,
  adapterStatus: adapter.status,
  bindingCount: bindingCountByAdapter.get(adapter.config.id) ?? 0,
  label: adapter.config.label, // NEW — from AdapterConfig
} satisfies AdapterNodeData,
```

The `AdapterListItem.config` (from `transport.ts` line 51) contains the full `AdapterConfig`, which includes `label?: string` (line 90 of `relay-adapter-schemas.ts`).

### Area 6: Binding Edge Filter Badges

**File:** `BindingEdge.tsx`

**BindingEdgeData (lines 19-26):** Add filter fields:

```typescript
export interface BindingEdgeData {
  label?: string;
  sessionStrategy?: string;
  chatId?: string;        // NEW
  channelType?: string;   // NEW
  onDelete?: (edgeId: string) => void;
}
```

**Label display (lines 87-111 area):** When `chatId` or `channelType` are present, render badges below the label text:

```tsx
{/* Filter badges — only shown when chatId or channelType present */}
{(d.chatId || d.channelType) && (
  <div className="mt-0.5 flex items-center gap-1">
    {d.chatId && (
      <span className="rounded bg-muted px-1 py-px text-[9px] text-muted-foreground">
        {d.chatId}
      </span>
    )}
    {d.channelType && (
      <span className="rounded bg-muted px-1 py-px text-[9px] text-muted-foreground">
        {d.channelType}
      </span>
    )}
  </div>
)}
```

Badges use the same visibility rules as the label: only shown when hovered/selected AND zoom >= 0.7 (line 60-61 condition).

**File:** `build-topology-elements.ts`

When constructing binding edge data (lines 189-193), pass filter fields:

```typescript
data: {
  label: binding.label || undefined,
  sessionStrategy: binding.sessionStrategy,
  chatId: binding.chatId || undefined,       // NEW
  channelType: binding.channelType || undefined, // NEW
  onDelete: handleDeleteBinding,
} satisfies BindingEdgeData,
```

The `AdapterBinding` type (lines 243-258 of `relay-adapter-schemas.ts`) already has `chatId` and `channelType` as optional fields. They're just not passed to the edge data today.

## User Experience

### Scenario 1: New User with No Relay Adapters

1. User opens Mesh panel → Topology tab
2. Sees namespace container(s) with agent nodes inside
3. On the left, a dimmed ghost "Add Adapter" placeholder with dashed border
4. Background dots provide spatial reference
5. MiniMap in bottom-right shows the overview
6. User clicks ghost node → adapter catalog opens

### Scenario 2: User with Telegram Adapter

1. Topology shows namespace container(s) with agents
2. Telegram adapter node on the left with label "@my_bot" and type "Telegram"
3. Binding edges connect adapter to agents, with chatId/channelType badges where applicable
4. Agent nodes show "Claude Code" runtime badge
5. No CCA node cluttering the graph

### Scenario 3: Multi-Instance Adapters

1. Two Telegram adapters, each with different labels ("@support_bot", "@dev_bot")
2. Each has its own node on the left with distinct labels
3. Binding edges from each show which agents they route to
4. Edges with specific chatId filters show the filter as a badge

### Scenario 4: Zooming Through LOD Bands

1. **Zoomed out (< 0.6):** Compact pills — agent dots + names, adapter pills, no badges, no edge labels
2. **Default (0.6-1.2):** Agent cards with runtime badge and capability badges. Adapter cards with label/type. Edge labels appear on hover.
3. **Zoomed in (> 1.2):** Expanded agent cards with full details. Binding edge filter badges visible on hover.

## Testing Strategy

### Unit Tests

**build-topology-elements.test.ts:**
- CCA adapter filtered out: pass adapters including `type: 'claude-code'` → no adapter node created for it
- CCA binding edges excluded: binding referencing CCA adapter → no edge created (source node doesn't exist)
- External adapters still create nodes: Telegram adapter → node created
- Ghost node created when relay enabled + no external adapters
- Ghost node NOT created when relay disabled
- Ghost node NOT created when external adapters exist
- Namespace container created with single namespace (`namespaces.length === 1`)
- Namespace container created with multiple namespaces (existing test, should still pass)
- Adapter label passed through to node data
- Binding chatId/channelType passed through to edge data

**AdapterNode.test.tsx:**
- Ghost node renders with dashed border and Plus icon
- Ghost node has no output handle
- Ghost node click fires callback
- Adapter label shown as primary text when present
- Adapter name shown as primary text when no label
- Type name shown as secondary text when label present

**AgentNode.test.tsx:**
- Runtime badge renders at default LOD
- Runtime badge renders at expanded LOD
- Runtime badge hidden at compact LOD
- Runtime badge hidden when `runtime` is undefined

**BindingEdge.test.tsx (new tests):**
- chatId badge rendered when present
- channelType badge rendered when present
- Both badges rendered when both present
- No badges when both absent (current behavior)
- Badges follow same visibility rules as label (zoom >= 0.7)

**TopologyGraph.test.tsx:**
- MiniMap component renders
- Background component renders

### Mocking Strategy

- Use `createMockTransport()` from `@dorkos/test-utils` for all component tests
- Mock `useRelayAdapters()` to return adapters with/without CCA
- Mock `useBindings()` to return bindings with chatId/channelType
- Mock `useLodBand()` to test LOD-specific rendering
- Use `vi.mock()` for entity hooks

## Performance Considerations

- **CCA filtering:** `Array.filter()` on a small array (typically 1-3 adapters). Negligible.
- **Ghost node:** Single additional node when no adapters exist. Negligible.
- **Always-on namespace containers:** Adds 1+ group node(s) to ELK layout. ELK compound layout handles this efficiently — the layout is already async.
- **MiniMap:** React Flow's built-in MiniMap re-renders on viewport change. For topologies with < 50 nodes (typical), performance impact is negligible.
- **Background:** SVG pattern rendering. Negligible cost.
- **Binding badges:** Additional DOM elements on edges, but only rendered when hovered/selected AND zoom >= 0.7. No cost at rest.

## Security Considerations

- **Adapter labels:** User-provided strings rendered as React text content (not raw HTML). XSS safe by default.
- **ChatId display:** Could contain user-provided chat identifiers. Rendered as React text content — safe.
- No new API endpoints or data mutations.

## Documentation

No external documentation changes needed. These are visual improvements to an existing feature. The contributing guides for mesh/topology are internal and can be updated if needed after implementation.

## Implementation Phases

### Phase 1: Core Changes

1. Filter CCA from adapter nodes in `build-topology-elements.ts`
2. Change namespace container condition from `> 1` to `>= 1`
3. Add runtime badge to AgentNode (default + expanded LOD)
4. Add ghost adapter placeholder node

### Phase 2: React Flow Built-ins

5. Add `<Background>` with dots
6. Add `<MiniMap>` with namespace-colored nodes

### Phase 3: Spec 120 Alignment

7. Add `label` field to `AdapterNodeData` and render two-line display
8. Add `chatId`/`channelType` to `BindingEdgeData` and render filter badges
9. Pass label and filter fields through `buildTopologyElements`

### Phase 4: Tests

10. Update `build-topology-elements.test.ts` for CCA filtering, ghost node, namespace changes
11. Update `AdapterNode.test.tsx` for ghost rendering and labels
12. Update `AgentNode.test.tsx` for runtime badge
13. Add `BindingEdge` tests for filter badges
14. Update `TopologyGraph.test.tsx` for MiniMap/Background

## Open Questions

1. ~~**CCA adapter type identifier**~~ (RESOLVED)
**Answer:** `'claude-code'` — defined in `AdapterTypeSchema` at line 16 of `relay-adapter-schemas.ts`.

2. ~~**Ghost node click target**~~ (RESOLVED)
**Answer:** Opens the `AdapterSetupWizard` / adapter catalog. The callback is provided by `TopologyGraph` via props on the adapter node data.

## Related ADRs

- **ADR-0035**: Use xyflow/react for mesh topology visualization
- **ADR-0052**: Replace dagre with ELK.js for topology layout
- **ADR-0053**: Server-side topology enrichment (agent health, capabilities)
- **ADR-0038**: Progressive disclosure Mode A/B for feature panels (MeshPanel uses this)
- **ADR-0045**: Adapter manifest self-declaration (defines adapter types including `claude-code`)

## References

- Ideation document: `specs/topology-overhaul/01-ideation.md`
- Research: `research/20260228_graph_topology_visualization_ux.md`
- Research: `research/20260226_mesh_topology_elevation.md`
- Related spec 120: `specs/adapter-binding-ux-overhaul/02-specification.md`
- React Flow docs: https://reactflow.dev/
- ELK.js docs: https://www.eclipse.org/elk/

## Changelog

### 2026-03-11 — Initial Draft
- Full specification covering 6 areas of topology improvement
- Based on brainstorming session decisions and existing research reports
