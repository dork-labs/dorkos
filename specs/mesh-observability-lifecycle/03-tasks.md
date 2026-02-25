# Task Breakdown: Mesh Observability & Lifecycle Events

Generated: 2026-02-25
Source: specs/mesh-observability-lifecycle/02-specification.md
Last Decompose: 2026-02-25

## Overview

Add observability and diagnostic tooling to the Mesh subsystem: topology visualization via React Flow, agent health tracking via computed 3-state model (active/inactive/stale), lifecycle events via Relay signals, diagnostic MCP tools (mesh_status, mesh_inspect), and new HTTP routes (GET /status, GET /agents/:id/health, POST /agents/:id/heartbeat). This makes the agent mesh visible and inspectable.

## Phase 1: Foundation — Shared Schemas & Core Health Tracking

### Task 1.1: Add health, status, inspect, and lifecycle schemas to mesh-schemas.ts
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: None

**Technical Requirements**:
- Add 6 new Zod schemas to `packages/shared/src/mesh-schemas.ts`: `AgentHealthStatusSchema`, `AgentHealthSchema`, `MeshStatusSchema`, `MeshInspectSchema`, `MeshLifecycleEventSchema`, `HeartbeatRequestSchema`
- All schemas must have `.openapi()` metadata
- Export corresponding TypeScript types

**Implementation Steps**:
1. Add schemas after existing `AgentListQuerySchema`
2. Reference existing `AgentRuntimeSchema` and `AgentManifestSchema`
3. Run `npm run typecheck`

**Acceptance Criteria**:
- [ ] All 6 schemas and types exported
- [ ] All schemas have `.openapi()` metadata
- [ ] `npm run typecheck` passes
- [ ] Existing mesh schema exports unchanged

---

### Task 1.2: Add v2 migration and health-tracking methods to AgentRegistry
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: None

**Technical Requirements**:
- v2 schema migration: `ALTER TABLE agents ADD COLUMN last_seen_at TEXT; ALTER TABLE agents ADD COLUMN last_seen_event TEXT;`
- 4 new prepared statements: `updateHealth`, `getWithHealth`, `listWithHealth`, `getAggregateStats`
- Health status computed at query time via SQL CASE expression (active < 5 min, inactive 5-30 min, stale > 30 min)
- 4 new public methods + `healthRowToEntry` private helper
- New types: `AgentHealthEntry`, `AggregateStats`

**Implementation Steps**:
1. Add v2 migration SQL to `MIGRATIONS` array
2. Add `AgentHealthRow`, `AgentHealthEntry`, `AggregateStats` types
3. Add 4 prepared statements with computed `health_status` CASE expression
4. Implement `updateHealth()`, `getWithHealth()`, `listWithHealth()`, `getAggregateStats()`
5. Add `healthRowToEntry()` private method
6. Write 8 unit tests

**Acceptance Criteria**:
- [ ] v2 migration adds columns without breaking v1 data
- [ ] Health status computed correctly for all threshold boundaries
- [ ] All 8 new tests pass
- [ ] Existing tests still pass

---

### Task 1.3: Add health and diagnostic methods to MeshCore
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.1, Task 1.2
**Can run parallel with**: None

**Technical Requirements**:
- Add `signalEmitter` to `MeshOptions` interface
- 4 new public methods: `updateLastSeen()`, `getAgentHealth()`, `getStatus()`, `inspect()`
- `updateLastSeen()` emits `health_changed` signal on status transitions
- `getStatus()` computes `byRuntime` and `byProject` groupings
- `inspect()` derives relay subject from project path

**Implementation Steps**:
1. Import `SignalEmitter` from `@dorkos/relay` and new types
2. Add `signalEmitter` to `MeshOptions` and store as private field
3. Implement 4 methods with full business logic
4. Export new types from `packages/mesh/src/index.ts`
5. Write 5 unit tests with mock `SignalEmitter`

**Acceptance Criteria**:
- [ ] `updateLastSeen()` emits signal only on transitions
- [ ] `getAgentHealth()` returns correct `AgentHealth` shape
- [ ] `getStatus()` returns `MeshStatus` with groupings
- [ ] `inspect()` returns `MeshInspect` with relay subject
- [ ] All 5 tests pass

---

## Phase 2: Lifecycle Signals & Server Routes

### Task 2.1: Extend RelayBridge with SignalEmitter for lifecycle signal emission
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.2

**Technical Requirements**:
- Accept optional `SignalEmitter` in `RelayBridge` constructor
- Emit `mesh.agent.lifecycle.registered` on registration
- Emit `mesh.agent.lifecycle.unregistered` on unregistration
- Add `emitHealthChanged()` public helper
- Update `MeshCore.unregister()` to pass agent manifest

**Implementation Steps**:
1. Update `RelayBridge` constructor signature
2. Add signal emission to `registerAgent()` and `unregisterAgent()`
3. Add `emitHealthChanged()` method
4. Update `MeshCore.unregister()` to pass agent to bridge
5. Update `MeshCore` constructor to pass `signalEmitter` to `RelayBridge`
6. Write 3 tests

**Acceptance Criteria**:
- [ ] Lifecycle signals emitted on register/unregister
- [ ] No signals when `SignalEmitter` is undefined
- [ ] All 3 tests pass

---

### Task 2.2: Add mesh observability HTTP routes (status, health, heartbeat)
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.1

**Technical Requirements**:
- `GET /api/mesh/status` — returns `MeshStatus` from `meshCore.getStatus()`
- `GET /api/mesh/agents/:id/health` — returns `AgentHealth` or 404
- `POST /api/mesh/agents/:id/heartbeat` — updates last-seen, validates agent exists first
- Route ordering: `/agents/:id/health` must come before `/agents/:id`

**Implementation Steps**:
1. Import `HeartbeatRequestSchema`
2. Add 3 routes inside `createMeshRouter()`
3. Write 5 route tests

**Acceptance Criteria**:
- [ ] All 3 endpoints return correct shapes
- [ ] 404 for unknown agents on health and heartbeat
- [ ] Heartbeat defaults to 'heartbeat' event
- [ ] All 5 tests pass

---

### Task 2.3: Add mesh_status and mesh_inspect MCP diagnostic tools
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.3
**Can run parallel with**: Task 2.1, Task 2.2

**Technical Requirements**:
- `mesh_status` tool: returns aggregate stats from `meshCore.getStatus()`
- `mesh_inspect` tool: returns agent detail from `meshCore.inspect(agentId)`, error for unknown
- Both guarded by `requireMesh()`

**Implementation Steps**:
1. Add 2 tool registrations in `registerMeshTools()` section
2. Write 4 tests

**Acceptance Criteria**:
- [ ] Both tools registered and callable
- [ ] Error handling for unknown agents and disabled mesh
- [ ] All 4 tests pass

---

### Task 2.4: Wire SignalEmitter through server index.ts
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 2.1
**Can run parallel with**: None

**Technical Requirements**:
- Create adapter from RelayCore's public `signal()`/`onSignal()` to SignalEmitter interface
- Pass adapter to `MeshCore` constructor when both mesh and relay are enabled
- Subscribe to `mesh.agent.lifecycle.>` for diagnostics logging

**Implementation Steps**:
1. Create `createRelaySignalAdapter()` function in index.ts
2. Pass adapter to `MeshCore` options
3. Subscribe for diagnostic logging

**Acceptance Criteria**:
- [ ] MeshCore receives SignalEmitter when both mesh + relay enabled
- [ ] Server starts with mesh only (no relay) without error
- [ ] Lifecycle events logged to console

---

## Phase 3: Client UI

### Task 3.1: Install React Flow dependencies and add CSS import
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, Task 1.2

**Technical Requirements**:
- `@xyflow/react@^12` and `dagre@^0.8` as dependencies
- `@types/dagre@^0.7` as devDependency
- CSS import in `apps/client/src/index.css`

**Implementation Steps**:
1. `npm install @xyflow/react@^12 dagre@^0.8 -w apps/client`
2. `npm install -D @types/dagre@^0.7 -w apps/client`
3. Add `@import '@xyflow/react/dist/style.css';` to index.css
4. Verify client build succeeds

**Acceptance Criteria**:
- [ ] Packages in package.json
- [ ] CSS import at top level of index.css
- [ ] Client build succeeds

---

### Task 3.2: Add Transport interface methods and HttpTransport implementation
**Size**: Small
**Priority**: High
**Dependencies**: Task 1.1
**Can run parallel with**: Task 3.1

**Technical Requirements**:
- 3 new methods on `Transport` interface: `getMeshStatus()`, `getMeshAgentHealth()`, `sendMeshHeartbeat()`
- `HttpTransport` implementation using `fetchJSON()`
- `DirectTransport` stubs
- Mock transport factory update in `test-utils`

**Implementation Steps**:
1. Add type imports and interface methods
2. Implement in HttpTransport
3. Add stubs to DirectTransport
4. Update mock factory

**Acceptance Criteria**:
- [ ] Transport interface extended
- [ ] HttpTransport implemented
- [ ] Mock transport updated
- [ ] `npm run typecheck` passes

---

### Task 3.3: Create mesh observability entity hooks
**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.2
**Can run parallel with**: None

**Technical Requirements**:
- `useMeshStatus(enabled?)` — TanStack Query with 30s polling
- `useMeshAgentHealth(agentId | null)` — single agent health, disabled when null
- `useMeshHeartbeat()` — mutation that invalidates status/health queries
- Barrel export updates

**Implementation Steps**:
1. Create 3 hook files in `entities/mesh/model/`
2. Update barrel at `entities/mesh/index.ts`
3. Write 3 tests for `useMeshStatus`

**Acceptance Criteria**:
- [ ] All 3 hooks work correctly
- [ ] Barrel exports updated
- [ ] 3 tests pass

---

### Task 3.4: Create TopologyGraph, AgentNode, and dagre layout
**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.1, Task 3.3
**Can run parallel with**: Task 3.5

**Technical Requirements**:
- `AgentNode` — custom React Flow node with health dot, runtime badge, capability badges, `React.memo`
- `TopologyGraph` — React Flow canvas with dagre LTR layout, click-to-select, empty state
- `nodeTypes` defined outside component (React Flow requirement)
- Handles invisible for v1 (no edges)

**Implementation Steps**:
1. Create `AgentNode.tsx` with health indicator colors
2. Create `TopologyGraph.tsx` with dagre layout function
3. Verify React Flow renders correctly

**Acceptance Criteria**:
- [ ] Nodes display with correct health colors
- [ ] Dagre positions nodes in LTR layout
- [ ] Empty state shown when no agents
- [ ] Click opens AgentHealthDetail

---

### Task 3.5: Create MeshStatsHeader and AgentHealthDetail components
**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.3
**Can run parallel with**: Task 3.4

**Technical Requirements**:
- `MeshStatsHeader` — compact stats bar with green/amber colored counts, null render when disabled/loading
- `AgentHealthDetail` — absolute-positioned detail panel with health, runtime, capabilities, relative times
- `formatRelative()` helper for ISO timestamps

**Implementation Steps**:
1. Create `MeshStatsHeader.tsx`
2. Create `AgentHealthDetail.tsx` with `formatRelative()` helper
3. Write 4 tests for `MeshStatsHeader`

**Acceptance Criteria**:
- [ ] Stats header renders correct counts with colors
- [ ] Health detail shows all agent health fields
- [ ] 4 tests pass

---

### Task 3.6: Update MeshPanel with Topology tab and lazy-loaded graph
**Size**: Medium
**Priority**: High
**Dependencies**: Task 3.4, Task 3.5
**Can run parallel with**: None

**Technical Requirements**:
- Default tab changes from `"discovery"` to `"topology"`
- `TopologyGraph` lazy-loaded via `React.lazy()` with Suspense fallback
- Stats header above tab list
- All 4 tabs: Topology, Discovery, Agents, Denied

**Implementation Steps**:
1. Add lazy import and Suspense
2. Add MeshStatsHeader
3. Add Topology tab trigger and content
4. Change default tab
5. Update/add 3 tests

**Acceptance Criteria**:
- [ ] Topology is default tab
- [ ] TopologyGraph is lazy-loaded
- [ ] Stats header visible
- [ ] All 4 tabs present
- [ ] Tests pass

---

### Task 3.7: Update feature barrel exports
**Size**: Small
**Priority**: Low
**Dependencies**: Task 3.6
**Can run parallel with**: None

**Technical Requirements**:
- Verify `MeshPanel` is exported from mesh feature barrel
- Internal components (TopologyGraph, AgentNode, etc.) should NOT be in barrel exports

**Acceptance Criteria**:
- [ ] MeshPanel exported
- [ ] Internal components encapsulated
- [ ] No FSD layer violations

---

## Phase 4: Documentation

### Task 4.1: Update CLAUDE.md with mesh observability endpoints and tools
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 3.6
**Can run parallel with**: None

**Technical Requirements**:
- Update routes/mesh.ts description with new endpoints
- Update MCP tools list with mesh_status and mesh_inspect
- Update entities/mesh hook list
- Update features/mesh component list

**Acceptance Criteria**:
- [ ] All new routes documented
- [ ] All new MCP tools documented
- [ ] All new hooks and components documented
- [ ] No other CLAUDE.md content modified

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| 1 — Foundation | 1.1, 1.2, 1.3 | Shared schemas, DB migration, core health methods |
| 2 — Server | 2.1, 2.2, 2.3, 2.4 | Lifecycle signals, HTTP routes, MCP tools, wiring |
| 3 — Client UI | 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7 | React Flow, transport, hooks, components, panel update |
| 4 — Documentation | 4.1 | CLAUDE.md updates |

**Total tasks**: 15

**Parallel opportunities**:
- Tasks 2.1, 2.2, 2.3 can all run in parallel (all depend only on 1.3)
- Tasks 3.1 and 3.2 can run in parallel with Phase 1 tasks
- Tasks 3.4 and 3.5 can run in parallel (both depend on 3.3)

**Critical path**: 1.1 -> 1.2 -> 1.3 -> 2.2 (server routes) + 3.2 -> 3.3 -> 3.4/3.5 -> 3.6 -> 4.1
