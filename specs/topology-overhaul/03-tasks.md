# Task Breakdown: Topology Visualization Overhaul

Generated: 2026-03-11
Source: specs/topology-overhaul/02-specification.md
Last Decompose: 2026-03-11

## Overview

Six targeted improvements to the React Flow topology visualization:

1. Remove the Claude Code Adapter (CCA) as a graph node
2. Always render namespace containers (even single-namespace)
3. Add ghost adapter placeholder for progressive disclosure
4. Refine MiniMap and Background configuration
5. Surface adapter labels on adapter nodes
6. Surface chatId/channelType filter badges on binding edges

The underlying architecture (React Flow, ELK.js layout, LOD bands, `buildTopologyElements` pure function) is unchanged. All changes are in the client-side mesh feature layer.

---

## Phase 1: Core Graph Changes

### Task 1.1: Filter CCA from adapter nodes and add runtime badge to AgentNode

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3

**Technical Requirements**:

- Filter out adapters with `config.type === 'claude-code'` before creating adapter nodes in `build-topology-elements.ts`
- Binding edges referencing CCA adapters are automatically excluded by the existing source-node existence check
- The runtime badge on AgentNode already exists in `CardHeader` -- no changes needed to `AgentNode.tsx`

**Implementation Steps**:

1. In `build-topology-elements.ts`, create an `externalAdapters` variable that filters out `claude-code` type adapters
2. Replace the `adapters?.length` guard with `externalAdapters.length > 0`
3. Iterate `externalAdapters` instead of `adapters` in the adapter node creation loop
4. Verify binding edge validation already handles missing source nodes (it does)

**Files Changed**:

- `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts`
- `apps/client/src/layers/features/mesh/lib/__tests__/build-topology-elements.test.ts`

**Acceptance Criteria**:

- [ ] CCA adapter (type `'claude-code'`) is never rendered as a graph node
- [ ] Binding edges referencing CCA adapters are automatically excluded
- [ ] External adapters (telegram, webhook, plugin) still render as nodes
- [ ] Three new CCA filtering tests pass
- [ ] All existing tests pass

---

### Task 1.2: Always show namespace containers for single-namespace topologies

**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3

**Technical Requirements**:

- Change `const multiNamespace = namespaces.length > 1` to `const useGroups = namespaces.length >= 1`
- Rename `multiNamespace` variable to `useGroups` throughout the function (5 occurrences)
- No changes needed to `elk-layout.ts` -- the `useGroups` parameter already handles this correctly

**Implementation Steps**:

1. Change the condition on line 98 of `build-topology-elements.ts`
2. Rename the variable at all usage sites (lines 98, 111, 164, 200-205, 220)
3. Update single-namespace tests to expect group nodes and parentId
4. Update TopologyGraph integration tests for the new behavior

**Files Changed**:

- `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts`
- `apps/client/src/layers/features/mesh/lib/__tests__/build-topology-elements.test.ts`
- `apps/client/src/layers/features/mesh/ui/__tests__/TopologyGraph.test.tsx`

**Acceptance Criteria**:

- [ ] Single-namespace topologies show a namespace container group node
- [ ] Agent nodes in single-namespace topologies have `parentId` set
- [ ] Multi-namespace behavior is unchanged
- [ ] Variable renamed from `multiNamespace` to `useGroups`
- [ ] All updated tests pass

---

### Task 1.3: Add ghost adapter placeholder node for empty adapter state

**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 1.2

**Technical Requirements**:

- When relay is enabled but `externalAdapters.length === 0` (after CCA filtering), create a ghost node
- Ghost node is type `'adapter'`, id `'ghost-adapter'`, with `isGhost: true` in data
- Ghost node renders with dashed border, 40% opacity, Plus icon, "Add Adapter" text
- Ghost node has no output Handle (cannot drag-to-connect)
- Ghost node click fires `onGhostClick` callback to open adapter setup wizard
- `isValidConnection` in `use-topology-handlers.ts` rejects connections from ghost nodes

**Implementation Steps**:

1. Add `isGhost`, `label`, and `onGhostClick` to `AdapterNodeData` interface
2. Add ghost rendering branch to `AdapterNodeInner` (before LOD band check)
3. Add `Plus` to lucide-react imports
4. Create ghost node in `buildTopologyElements` when conditions are met
5. Add `onGhostClick` to `AgentNodeCallbacks` interface
6. Update `isValidConnection` to reject ghost source nodes
7. Wire `onGhostClick` callback in `TopologyGraph.tsx`

**Files Changed**:

- `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx`
- `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts`
- `apps/client/src/layers/features/mesh/ui/use-topology-handlers.ts`
- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx`
- `apps/client/src/layers/features/mesh/lib/__tests__/build-topology-elements.test.ts`
- `apps/client/src/layers/features/mesh/ui/__tests__/AdapterNode.test.tsx`

**Acceptance Criteria**:

- [ ] Ghost node appears when relay enabled and no external adapters exist
- [ ] Ghost node appears when only CCA adapters exist
- [ ] Ghost node does NOT appear when external adapters exist
- [ ] Ghost node does NOT appear when relay is disabled
- [ ] Ghost renders with dashed border, reduced opacity, Plus icon
- [ ] Ghost has no output Handle
- [ ] Ghost click fires callback
- [ ] Ghost nodes rejected as connection sources
- [ ] All new tests pass

---

## Phase 2: React Flow Built-ins

### Task 2.1: Refine MiniMap and Background component configuration

**Size**: Small
**Priority**: Medium
**Dependencies**: None
**Can run parallel with**: (independent)

**Technical Requirements**:

- MiniMap and Background are already rendered in `TopologyGraph.tsx`
- Update Background `gap` from 20 to 16 (8pt grid convention)
- Update Background `color` to `hsl(var(--muted-foreground) / 0.15)`
- Update MiniMap `nodeColor` to use namespace colors for agents, transparent for groups, neutral for adapters
- Update MiniMap `maskColor` to theme-aware `hsl(var(--background) / 0.8)`
- Update MiniMap `className` to `!bottom-2 !right-2`

**Implementation Steps**:

1. Change Background gap to 16 and color to theme-aware value
2. Update MiniMap nodeColor function for three node types
3. Update MiniMap maskColor and positioning

**Files Changed**:

- `apps/client/src/layers/features/mesh/ui/TopologyGraph.tsx`

**Acceptance Criteria**:

- [ ] Background dots use 16px gap matching 8pt grid
- [ ] Background dot color uses theme-aware value
- [ ] MiniMap shows namespace-colored agent nodes
- [ ] MiniMap namespace group containers are transparent
- [ ] MiniMap adapter nodes use neutral muted color
- [ ] Existing TopologyGraph tests pass

---

## Phase 3: Spec 120 Alignment

### Task 3.1: Surface adapter labels on adapter nodes with two-line display

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.3
**Can run parallel with**: Task 3.2

**Technical Requirements**:

- When `label` exists: show label as primary text (text-sm font-medium), adapter display name as secondary text (text-xs text-muted-foreground)
- When no label: show adapter display name as primary text, no secondary text (current behavior)
- Compact pills show label or adapter name -- no secondary text
- Pass `adapter.config.label` through `buildTopologyElements` to `AdapterNodeData.label`

**Implementation Steps**:

1. Verify `label` field exists on `AdapterNodeData` (added in Task 1.3)
2. Replace single-line adapter name with two-line display in `AdapterNodeInner`
3. Update `AdapterCompactPill` to use label if available
4. Pass `adapter.config.label` in `buildTopologyElements`

**Files Changed**:

- `apps/client/src/layers/features/mesh/ui/AdapterNode.tsx`
- `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts`
- `apps/client/src/layers/features/mesh/ui/__tests__/AdapterNode.test.tsx`
- `apps/client/src/layers/features/mesh/lib/__tests__/build-topology-elements.test.ts`

**Acceptance Criteria**:

- [ ] Labeled adapters show label primary, name secondary
- [ ] Unlabeled adapters show name primary, no secondary
- [ ] Compact pills show label (or name)
- [ ] Label passes through buildTopologyElements
- [ ] All new and existing tests pass

---

### Task 3.2: Add chatId and channelType filter badges to binding edges

**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 1.1
**Can run parallel with**: Task 3.1

**Technical Requirements**:

- Add `chatId` and `channelType` to `BindingEdgeData` interface
- Render filter badges below the edge label text in the `EdgeLabelRenderer`
- Badges use `text-[9px]`, `bg-muted`, `rounded` pills
- Badges follow same visibility rules as label (hovered/selected AND zoom >= 0.7)
- Pass `binding.chatId` and `binding.channelType` through `buildTopologyElements`

**Implementation Steps**:

1. Add `chatId` and `channelType` to `BindingEdgeData`
2. Update edge label renderer layout to stack label + badges vertically
3. Add filter badge rendering below the label/delete button row
4. Increase max-width from 100px to 160px for badge content
5. Pass filter fields in `buildTopologyElements`

**Files Changed**:

- `apps/client/src/layers/features/mesh/ui/BindingEdge.tsx`
- `apps/client/src/layers/features/mesh/lib/build-topology-elements.ts`
- `apps/client/src/layers/features/mesh/ui/__tests__/BindingEdge.test.tsx`
- `apps/client/src/layers/features/mesh/lib/__tests__/build-topology-elements.test.ts`

**Acceptance Criteria**:

- [ ] chatId badge renders when present and visible
- [ ] channelType badge renders when present and visible
- [ ] Both badges render together when both present
- [ ] No badges when neither present
- [ ] Badges hidden when edge not hovered/selected
- [ ] Filter fields pass through buildTopologyElements
- [ ] All new and existing tests pass

---

## Phase 4: Integration Testing & Cleanup

### Task 4.1: Update TopologyGraph integration tests for all topology overhaul changes

**Size**: Large
**Priority**: High
**Dependencies**: Tasks 1.1, 1.2, 1.3, 3.1, 3.2
**Can run parallel with**: None

**Technical Requirements**:

- Update `mockAdapters` to include CCA adapter
- Add CCA filtering integration tests
- Add ghost adapter placeholder integration tests
- Update single-namespace tests (expect group nodes)
- Add adapter label data verification tests
- Add binding filter data verification tests
- Run full mesh test suite for regression verification

**Implementation Steps**:

1. Add CCA adapter to mock data in TopologyGraph.test.tsx
2. Write CCA filtering tests (node exclusion, edge exclusion)
3. Write ghost adapter tests (present when only CCA, absent when externals exist)
4. Update single-namespace group node expectations
5. Write adapter label data pass-through test
6. Write binding filter data pass-through test
7. Run `pnpm vitest run apps/client/src/layers/features/mesh/`
8. Run `pnpm typecheck` to verify no TypeScript errors

**Files Changed**:

- `apps/client/src/layers/features/mesh/ui/__tests__/TopologyGraph.test.tsx`

**Acceptance Criteria**:

- [ ] All CCA filtering integration tests pass
- [ ] All ghost adapter integration tests pass
- [ ] Updated single-namespace tests pass
- [ ] Adapter label data flows through to nodes
- [ ] Binding filter data flows through to edges
- [ ] Full mesh test suite passes: `pnpm vitest run apps/client/src/layers/features/mesh/`
- [ ] TypeScript compiles cleanly: `pnpm typecheck`

---

## Dependency Graph

```
Phase 1 (Core):
  1.1 (CCA filter) ─────┬──> 1.3 (Ghost adapter)
  1.2 (Namespaces) ──────┤
                         │
Phase 2 (Built-ins):     │
  2.1 (MiniMap/BG) ──────┤  (independent)
                         │
Phase 3 (Spec 120):      │
  3.1 (Labels) ──────────┤  (depends on 1.3)
  3.2 (Badges) ──────────┤  (depends on 1.1)
                         │
Phase 4 (Integration):   │
  4.1 (Tests) ───────────┘  (depends on all above)
```

## Parallel Opportunities

- Tasks 1.1, 1.2 can run fully in parallel (no file conflicts)
- Tasks 3.1, 3.2 can run in parallel (different files)
- Task 2.1 is fully independent and can run at any time
- Task 1.3 depends on 1.1 (needs `externalAdapters` variable)
- Task 4.1 is the convergence point requiring all other tasks to complete

## Critical Path

1.1 -> 1.3 -> 3.1 -> 4.1

The longest dependency chain runs through CCA filtering, ghost adapter, adapter labels, and then the integration test sweep.
