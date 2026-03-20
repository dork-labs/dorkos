# Task Breakdown: Mesh Topology Chart Elevation

Generated: 2026-02-26
Source: specs/mesh-topology-elevation/02-specification.md
Last Decompose: 2026-02-26

## Overview

Elevate the Mesh topology chart from a functional React Flow visualization to a world-class, living system map. The work covers six phases: visual foundation (Background, MiniMap, DenyEdge, CSS theming, auto-refresh), ELK.js layout migration (replacing dagre with compound group containers), node enhancement (3-level contextual zoom LOD, health pulse rings, Relay/Pulse indicators), interactions and animations (NodeToolbar, fly-to, slide animations, flow particles), server-side data enrichment (schema changes, cross-subsystem joins), and accessibility/performance (reduced-motion gating).

---

## Phase 1: Visual Foundation

### Task 1.1: Add React Flow Background, MiniMap, and canvas configuration

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3

**Technical Requirements**:

- Add `<Background variant="dots">`, `<MiniMap>` to React Flow canvas
- Configure `fitView` with `duration: 400, padding: 0.15`
- Set `colorMode="system"`, `onlyRenderVisibleElements`, `nodesConnectable={false}`
- CSS variable scoping with `.topology-container` class for design system compliance
- All React Flow CSS variables mapped to `var(--color-*)` design tokens

**Implementation Steps**:

1. Import Background, MiniMap from `@xyflow/react`
2. Add components inside `<ReactFlow>` with specified props
3. Create CSS variable overrides in topology-container class
4. Update outer div class to include `topology-container`

**Acceptance Criteria**:

- [ ] Background dot grid visible in light and dark mode
- [ ] MiniMap renders with namespace-colored nodes, pannable and zoomable
- [ ] fitView animates on initial load
- [ ] CSS variables use design system tokens
- [ ] Tests written and passing

---

### Task 1.2: Add auto-refresh polling to topology query

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3

**Technical Requirements**:

- Add `refetchInterval: 15_000` to `useTopology()` query options
- Ensure fitView only triggers on initial mount, not on polling refetches
- Node positions remain stable during auto-refresh

**Implementation Steps**:

1. Update `use-mesh-topology.ts` with refetchInterval
2. Verify React Flow's fitView prop is mount-time only

**Acceptance Criteria**:

- [ ] Topology data refetches every 15 seconds
- [ ] fitView only on initial mount
- [ ] Node positions stable during refresh
- [ ] Tests written and passing

---

### Task 1.3: Create DenyEdge component and register deny rules in topology

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2

**Technical Requirements**:

- New `DenyEdge.tsx` component with red dashed line, 50% default opacity
- Uses `var(--color-destructive)` CSS variable
- No arrowhead, no animation
- Update topology construction to include deny rules (currently silently dropped)

**Implementation Steps**:

1. Create `DenyEdge.tsx` with BaseEdge and hover state
2. Register `cross-namespace-deny` in EDGE_TYPES
3. Update access rules loop to include deny rules with action-qualified IDs

**Acceptance Criteria**:

- [ ] DenyEdge renders red dashed line with design token color
- [ ] 50% opacity default, full on hover/select
- [ ] Deny rules from accessRules create deny edges
- [ ] Tests written and passing

---

## Phase 2: ELK.js Layout Migration

### Task 2.1: Install elkjs, remove dagre, implement applyElkLayout

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, 1.3
**Can run parallel with**: None

**Technical Requirements**:

- Remove dagre dependency, add elkjs
- Implement async `applyElkLayout()` with layered left-to-right layout
- Handle async layout with useState + useEffect pattern
- Show loading skeleton during layout computation
- Support compound nodes for namespace groups

**Implementation Steps**:

1. Package changes: add elkjs, remove dagre and @types/dagre
2. Remove applyDagreLayout function
3. Implement applyElkLayout with ELK graph construction and position mapping
4. Replace synchronous layout with async state management
5. Split useMemo into node/edge construction + useEffect for layout

**Acceptance Criteria**:

- [ ] dagre fully removed from dependencies
- [ ] elkjs added and producing positioned nodes
- [ ] Loading skeleton during layout computation
- [ ] Layout re-runs on topology data changes
- [ ] Tests written and passing

---

### Task 2.2: Create NamespaceGroupNode and replace hub-spoke layout

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.1
**Can run parallel with**: None

**Technical Requirements**:

- New `NamespaceGroupNode.tsx` with rounded-xl container and namespace header
- Replace NamespaceHubNode + spoke edges
- Agent nodes as children of groups (`parentId`, `extent: 'parent'`)
- Cross-namespace edges connect groups directly
- Single-namespace topologies skip group wrapper

**Implementation Steps**:

1. Create NamespaceGroupNode component
2. Delete NamespaceHubNode.tsx and NamespaceEdge.tsx
3. Update NODE_TYPES and EDGE_TYPES registrations
4. Rewrite node/edge construction for group containers
5. Set group node dimensions from ELK layout output

**Acceptance Criteria**:

- [ ] NamespaceHubNode and NamespaceEdge deleted
- [ ] Agents nested inside group containers with parentId
- [ ] No spoke edges
- [ ] Single-namespace skips group wrapper
- [ ] Tests written and passing

---

## Phase 3: Node Enhancement

### Task 3.1: Implement 3-level contextual zoom LOD for AgentNode

**Size**: Large
**Priority**: High
**Dependencies**: Task 2.2
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- Read zoom level via `useStore(zoomSelector)` from React Flow store
- Compact pill at zoom < 0.6 (120x28px): health dot + truncated name
- Default card at zoom 0.6-1.2 (200x72px): pulse ring, capabilities (3 max), indicator row
- Expanded card at zoom > 1.2 (240x120px): description, budget, adapter names, last seen, behavior mode
- Health pulse ring (animate-ping) for active agents, gated on prefers-reduced-motion
- Agent color/emoji overrides from spec #66
- Smooth CSS transitions between levels

**Implementation Steps**:

1. Update AgentNodeData interface with enrichment fields
2. Add zoom selector and useStore
3. Create CompactPill, DefaultCard, ExpandedCard sub-components
4. Add Relay Zap and Pulse Clock indicator row
5. Add relativeTime helper and RUNTIME_ICONS constant

**Acceptance Criteria**:

- [ ] Three zoom levels render correctly
- [ ] Health pulse ring for active agents
- [ ] Relay/Pulse indicators when data present
- [ ] Agent color/emoji applied
- [ ] Tests written and passing

---

### Task 3.2: Update TopologyGraph node construction with enrichment data

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 2.2
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- Pass enrichment fields from server response into AgentNodeData
- Safe defaults for backward compatibility
- Map `icon` field from server to `emoji` field in client

**Implementation Steps**:

1. Update agent node data construction in useMemo
2. Extract enrichment fields with safe type assertions and defaults

**Acceptance Criteria**:

- [ ] All enrichment fields passed to AgentNodeData
- [ ] Missing fields default safely
- [ ] Works with both enriched and non-enriched responses
- [ ] Tests written and passing

---

## Phase 4: Interactions & Animations

### Task 4.1: Add NodeToolbar quick actions to AgentNode

**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1
**Can run parallel with**: Task 4.3, 4.4

**Technical Requirements**:

- NodeToolbar with Settings, Health, Copy ID buttons
- 24x24px icon buttons with Tooltip on hover
- Copy ID copies ULID to clipboard with toast notification
- Settings button conditional on spec #66 availability
- Callbacks propagated through node data

**Implementation Steps**:

1. Import NodeToolbar, add callback props to AgentNodeData
2. Create ToolbarButton sub-component with Tooltip
3. Add toolbar to AgentNodeComponent
4. Pass callbacks through TopologyGraph props

**Acceptance Criteria**:

- [ ] NodeToolbar appears on selection with 3 actions
- [ ] Copy ID works with clipboard API + toast
- [ ] Settings button hidden when spec #66 unavailable
- [ ] Tests written and passing

---

### Task 4.2: Integrate Agent Settings Dialog with topology

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 4.1
**Can run parallel with**: None

**Technical Requirements**:

- Settings button opens Agent Settings Dialog (spec #66 dependency)
- MeshPanel manages settingsAgentId state
- Dialog close invalidates topology query for data refresh
- Graceful fallback when spec #66 not implemented

**Implementation Steps**:

1. Add settingsAgentId state to MeshPanel
2. Pass onOpenSettings to LazyTopologyGraph
3. Conditionally render AgentDialog
4. Invalidate topology query on dialog close

**Acceptance Criteria**:

- [ ] Settings opens dialog with correct agent
- [ ] Dialog close refreshes topology
- [ ] No errors when AgentDialog unavailable
- [ ] Tests written and passing

---

### Task 4.3: Add fly-to selection animation and ReactFlowProvider

**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.2
**Can run parallel with**: Task 4.1, 4.4

**Technical Requirements**:

- Split TopologyGraph into outer (ReactFlowProvider) and inner (useReactFlow)
- Fly-to animation via `setCenter()` with 350ms duration
- Target zoom at least 1.0x
- Handle absolute position for nodes inside groups

**Implementation Steps**:

1. Create TopologyGraphInner component
2. Wrap in ReactFlowProvider
3. Implement handleNodeClick with setCenter
4. Compute absolute position for grouped nodes

**Acceptance Criteria**:

- [ ] Selecting agent smoothly pans and zooms to center
- [ ] Zoom maintained or increased to 1.0x
- [ ] Works for nodes inside groups
- [ ] Tests written and passing

---

### Task 4.4: Add AgentHealthDetail slide animation and CrossNamespaceEdge enhancements

**Size**: Large
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 4.1, 4.3

**Technical Requirements**:

- AgentHealthDetail wrapped in motion AnimatePresence for slide-in/out
- CrossNamespaceEdge: replace hardcoded #3b82f6 with var(--color-primary)
- Add SVG flow particles with animateMotion, gated on prefers-reduced-motion
- Edge labels conditional on hover/select
- "Open Settings" button at bottom of AgentHealthDetail

**Implementation Steps**:

1. Wrap AgentHealthDetail in motion.div with slide animation in MeshPanel
2. Rewrite CrossNamespaceEdge with theme colors, particles, conditional labels
3. Add onOpenSettings prop and button to AgentHealthDetail

**Acceptance Criteria**:

- [ ] AgentHealthDetail slides in/out with motion
- [ ] CrossNamespaceEdge uses CSS variables
- [ ] Flow particles present (gated on reduced motion)
- [ ] Labels only on hover/select
- [ ] Tests written and passing

---

## Phase 5: Server Enrichment & Schema

### Task 5.1: Extend TopologyView schema with enrichment fields

**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 5.2

**Technical Requirements**:

- Create TopologyAgentSchema extending AgentManifestSchema
- Add healthStatus, relayAdapters, relaySubject, pulseScheduleCount, lastSeenAt, lastSeenEvent
- Update NamespaceInfoSchema to use TopologyAgentSchema
- All new fields have defaults for backward compatibility

**Implementation Steps**:

1. Add AgentHealthStatusSchema enum
2. Create TopologyAgentSchema with .extend()
3. Update NamespaceInfoSchema.agents to use TopologyAgentSchema
4. Export new types

**Acceptance Criteria**:

- [ ] TopologyAgentSchema extends AgentManifestSchema correctly
- [ ] All fields have sensible defaults
- [ ] OpenAPI metadata present
- [ ] Existing code compiles
- [ ] Tests written and passing

---

### Task 5.2: Add server-side topology enrichment with Relay/Pulse/health joins

**Size**: Large
**Priority**: High
**Dependencies**: Task 5.1
**Can run parallel with**: None

**Technical Requirements**:

- Extend createMeshRouter to accept optional PulseStore and RelayCore dependencies
- Enrich each agent with health status, relay adapters, pulse schedule count
- Each enrichment wrapped in try/catch for graceful degradation
- Relay/Pulse dependencies optional

**Implementation Steps**:

1. Update createMeshRouter factory signature with MeshRouterDeps interface
2. Add async enrichment loop in topology endpoint
3. Update call site to pass dependencies
4. Add error handling per enrichment step

**Acceptance Criteria**:

- [ ] Topology includes health, relay, pulse data per agent
- [ ] Safe defaults when subsystems unavailable
- [ ] Enrichment failures don't break endpoint
- [ ] Tests written and passing

---

### Task 5.3: Update TopologyLegend with new visual elements

**Size**: Small
**Priority**: Medium
**Dependencies**: Task 1.3
**Can run parallel with**: Task 5.1, 5.2

**Technical Requirements**:

- Replace "Same namespace" entry (no more spoke edges)
- Add allow rule with dot indicator, deny rule entry
- Add health status entries (active/inactive/stale)
- Add Relay and Pulse indicator entries
- Add "Zoom in for more detail" hint
- Use CSS variables throughout

**Implementation Steps**:

1. Rewrite TopologyLegend with expanded entries
2. Import Zap, Clock icons from lucide-react
3. Add all legend entries with proper visual elements

**Acceptance Criteria**:

- [ ] All legend entries present and correctly styled
- [ ] Uses CSS variables, no hardcoded colors
- [ ] Tests written and passing

---

## Phase 6: Accessibility & Performance

### Task 6.1: Ensure all animations respect prefers-reduced-motion

**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1, 4.4, 5.3
**Can run parallel with**: None

**Technical Requirements**:

- Create `usePrefersReducedMotion` hook for reactive detection
- Gate animate-ping, animateMotion, animate-pulse on reduced motion
- Verify motion.div animations handled by MotionConfig
- Audit all animation-bearing components

**Implementation Steps**:

1. Create usePrefersReducedMotion hook with matchMedia listener
2. Apply hook in AgentNode, NamespaceGroupNode, TopologyLegend
3. Verify CrossNamespaceEdge already gated
4. Verify motion animations handled by MotionConfig reducedMotion="user"

**Acceptance Criteria**:

- [ ] All CSS animations gated on reduced motion
- [ ] SVG animations gated on reduced motion
- [ ] Hook reacts to runtime preference changes
- [ ] Tests written and passing
