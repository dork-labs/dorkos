# Task Breakdown: Mesh Network Topology
Generated: 2026-02-25
Source: specs/mesh-network-topology/02-specification.md

## Overview

This breakdown covers the implementation of namespace-based network topology and access control for the `@dorkos/mesh` package. The work adds project namespace isolation, default-allow same-project / default-deny cross-project access rules, per-agent budget enforcement via sliding window counters, invisible boundary filtering, and a client UI for topology visualization and ACL management.

The implementation spans 4 phases with 11 tasks total. Phase 1 (Core Policy Layer) establishes the foundation with namespace resolution, schema migration, and access rule authoring. Phase 2 (Topology & Budget) builds the TopologyManager and budget enforcement. Phase 3 (HTTP API & MCP) exposes topology via HTTP routes and MCP tools. Phase 4 (Client UI) adds the TopologyPanel component.

---

## Phase 1: Core Policy Layer

### Task 1.1: Create namespace-resolver module with derivation and validation
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.2, 1.3, 1.4

Create `packages/mesh/src/namespace-resolver.ts` with three pure functions:
- `resolveNamespace(projectPath, scanRoot, manifestNamespace?)` — derives namespace from filesystem position or manifest override
- `normalizeNamespace(raw)` — lowercase, replace non-alphanumeric with hyphens, trim
- `validateNamespace(ns)` — non-empty, max 64 chars

Export from `packages/mesh/src/index.ts`. Unit tests cover derivation from paths, manifest overrides, normalization edge cases, and validation boundaries.

---

### Task 1.2: Add namespace and scan_root columns to agent registry
**Size**: Medium
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.3, 1.4

Add SQLite migration version 2 to `packages/mesh/src/agent-registry.ts`:
- `ALTER TABLE agents ADD COLUMN namespace TEXT NOT NULL DEFAULT ''`
- `ALTER TABLE agents ADD COLUMN scan_root TEXT NOT NULL DEFAULT ''`
- `CREATE INDEX idx_agents_namespace ON agents(namespace)`

Update `AgentRegistryEntry` interface, `AgentRow` interface, `insert()` prepared statement, and `rowToEntry()` mapping. Add `listByNamespace(namespace)` method for fast lookup.

---

### Task 1.3: Expose access rule management on RelayCore
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.4

Add three public delegate methods to `RelayCore` in `packages/relay/src/relay-core.ts`:
- `addAccessRule(rule)` — delegates to `this.accessControl.addRule()`
- `removeAccessRule(from, to)` — delegates to `this.accessControl.removeRule()`
- `listAccessRules()` — delegates to `this.accessControl.listRules()`

All methods call `assertOpen()` first. Minimal, non-breaking addition to the Relay public API.

---

### Task 1.4: Add namespace field to mesh Zod schemas
**Size**: Small
**Priority**: High
**Dependencies**: None
**Can run parallel with**: Task 1.1, 1.2, 1.3

Extend `packages/shared/src/mesh-schemas.ts`:
- Add optional `namespace: z.string().max(64).optional()` to `AgentManifestSchema`
- Add `NamespaceInfoSchema`, `CrossNamespaceRuleSchema`, `TopologyViewSchema` with `.openapi()` metadata
- Add `UpdateAccessRuleRequestSchema` for HTTP request validation
- Extend `AgentListQuerySchema` with optional `callerNamespace`

---

### Task 1.5: Extend RelayBridge to write access rules on registration
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.3, 1.4
**Can run parallel with**: None

Extend `RelayBridge.registerAgent()` in `packages/mesh/src/relay-bridge.ts` to:
- Accept optional `namespace` and `scanRoot` parameters
- Use namespace in subject pattern (`relay.agent.{namespace}.{agentId}`)
- Write same-namespace allow rule (priority 100)
- Write cross-namespace deny rule (priority 10)
- Add `cleanupNamespaceRules(namespace)` method for unregistration cleanup

---

### Task 1.6: Wire namespace through MeshCore registration flow
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.1, 1.2, 1.4, 1.5
**Can run parallel with**: None

Update `MeshCore` in `packages/mesh/src/mesh-core.ts`:
- Accept `defaultScanRoot` in `MeshOptions`
- `register()` and `registerByPath()` resolve namespace via `resolveNamespace()`, pass through to registry and relay bridge
- `list()` supports `callerNamespace` filtering (stub for full topology integration in Phase 2)
- `unregister()` cleans up namespace rules when last agent in namespace removed
- `upsertAutoImported()` includes namespace

---

## Phase 2: Topology & Budget

### Task 2.1: Create TopologyManager with invisible boundary filtering
**Size**: Large
**Priority**: High
**Dependencies**: Task 1.2, 1.3, 1.5
**Can run parallel with**: Task 2.2

Create `packages/mesh/src/topology.ts` with `TopologyManager` class:
- `getTopology(callerNamespace)` — returns namespace-grouped agents filtered by access (invisible boundaries)
- `getAgentAccess(agentId)` — returns agents reachable from a specific agent
- `allowCrossNamespace(source, target)` — writes Relay allow rule at priority 50
- `denyCrossNamespace(source, target)` — removes the allow rule
- `listCrossNamespaceRules()` — extracts cross-namespace rules from Relay access rules

Admin view (`*`) returns all namespaces. Normal callers only see own namespace plus explicitly allowed namespaces.

---

### Task 2.2: Implement budget counter table with sliding window enforcement
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.2
**Can run parallel with**: Task 2.1

Add migration version 3 to agent-registry for `budget_counters` table. Create `packages/mesh/src/budget-mapper.ts` with `BudgetMapper` class:
- `checkBudget(agentId, maxCallsPerHour)` — sums calls in last 60 1-minute buckets
- `recordCall(agentId)` — increments current minute bucket via SQLite UPSERT
- Lazy pruning of buckets older than 120 minutes (ADR 0014 pattern)

---

### Task 2.3: Integrate TopologyManager into MeshCore with topology query methods
**Size**: Medium
**Priority**: High
**Dependencies**: Task 1.6, 2.1, 2.2
**Can run parallel with**: None

Wire `TopologyManager` into `MeshCore`:
- Create `TopologyManager` in constructor
- Add delegate methods: `getTopology()`, `getAgentAccess()`, `allowCrossNamespace()`, `denyCrossNamespace()`, `listCrossNamespaceRules()`
- Replace `list()` stub with proper topology-based namespace filtering
- Create integration test file `relay-integration.test.ts` testing full flow

---

## Phase 3: HTTP API & MCP

### Task 3.1: Add topology HTTP routes to mesh router
**Size**: Medium
**Priority**: High
**Dependencies**: Task 2.3
**Can run parallel with**: Task 3.2

Add three routes to `apps/server/src/routes/mesh.ts`:
- `GET /topology` — returns topology view, optional `?namespace=` query param
- `PUT /topology/access` — create/remove cross-namespace access rules (Zod validated)
- `GET /agents/:id/access` — which agents a specific agent can reach

Update existing `GET /agents` to pass `callerNamespace` query param through to `meshCore.list()`.

---

### Task 3.2: Add mesh_query_topology MCP tool and update mesh_list filtering
**Size**: Medium
**Priority**: Medium
**Dependencies**: Task 2.3
**Can run parallel with**: Task 3.1

Add `mesh_query_topology` tool to `mcp-tool-server.ts`:
- Parameters: `namespace` (optional, omit for admin view)
- Handler calls `meshCore.getTopology(namespace ?? '*')`

Update existing `mesh_list` tool with optional `callerNamespace` parameter for invisible boundary filtering.

---

## Phase 4: Client UI

### Task 4.1: Create use-mesh-topology and use-mesh-access entity hooks
**Size**: Small
**Priority**: Medium
**Dependencies**: Task 3.1
**Can run parallel with**: Task 4.2

Create two new hooks in `apps/client/src/layers/entities/mesh/model/`:
- `useTopology(namespace?, enabled?)` — TanStack Query hook for `GET /api/mesh/topology`
- `useUpdateAccessRule()` — TanStack Mutation for `PUT /api/mesh/topology/access`, invalidates topology queries on success
- `useAgentAccess(agentId)` — TanStack Query hook for `GET /api/mesh/agents/:id/access`

Export from entities/mesh barrel.

---

### Task 4.2: Create TopologyPanel component and integrate as fourth MeshPanel tab
**Size**: Large
**Priority**: Medium
**Dependencies**: Task 4.1
**Can run parallel with**: None

Create `TopologyPanel.tsx` in `apps/client/src/layers/features/mesh/ui/`:
- **Namespace Groups** — Collapsible groups showing agents per namespace with budget info
- **Cross-Project Rules** — Table of current rules with add/remove buttons
- **Add Rule Form** — Source/target namespace dropdowns with allow button

Add "Topology" as the fourth tab in `MeshPanel.tsx`. Follow Calm Tech design system (rounded-xl cards, consistent spacing). Component tests with mocked hooks.

---

## Summary

| Phase | Tasks | Size Range |
|---|---|---|
| Phase 1: Core Policy Layer | 6 tasks (1.1-1.6) | 2 small, 2 medium, 0 large, 1 large |
| Phase 2: Topology & Budget | 3 tasks (2.1-2.3) | 0 small, 2 medium, 1 large |
| Phase 3: HTTP API & MCP | 2 tasks (3.1-3.2) | 0 small, 2 medium, 0 large |
| Phase 4: Client UI | 2 tasks (4.1-4.2) | 1 small, 0 medium, 1 large |

**Critical path**: 1.1 → 1.6 → 2.3 → 3.1 → 4.1 → 4.2

**Maximum parallelism**: Tasks 1.1, 1.2, 1.3, 1.4 can all run in parallel (4-way). Tasks 2.1 and 2.2 can run in parallel. Tasks 3.1 and 3.2 can run in parallel.
