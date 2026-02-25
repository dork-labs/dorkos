---
slug: mesh-observability-lifecycle
number: 59
created: 2026-02-25
status: ideation
---

# Mesh Observability & Lifecycle Events

**Slug:** mesh-observability-lifecycle
**Author:** Claude Code
**Date:** 2026-02-25
**Branch:** preflight/mesh-observability-lifecycle
**Related:** [Mesh Spec 4](../../docs/plans/mesh-specs/04-mesh-observability-lifecycle.md)

---

## 1) Intent & Assumptions

- **Task brief:** Add observability and diagnostic tooling to @dorkos/mesh — topology visualization (network graph showing agents as nodes), agent health tracking (last-seen timestamps, active/inactive/stale status), lifecycle events (via Relay ephemeral signals), and diagnostic MCP tools + HTTP routes. This builds on the existing Mesh core library (Spec 1, commit `370cabd`) and server/client integration (Spec 2, commit `60c4879`).
- **Assumptions:**
  - Mesh core library (`packages/mesh/`) and server integration (`apps/server/src/routes/mesh.ts`, MCP tools) are fully operational
  - Relay is integrated and `SignalEmitter` exists for ephemeral lifecycle signals
  - Network is small — 10-50 agents max (single-machine DorkOS)
  - The topology visualization should work with or without Spec 3 (Network Topology ACLs)
  - Health status is derived from Relay message activity, not explicit heartbeats
- **Out of scope:**
  - Network topology ACL rules (Spec 3 — additive if present)
  - Agent activation / session management (handled by Relay runtime adapters)
  - Supervision / restart policies (handled by Relay runtime adapters)
  - CLI commands (MCP tools and HTTP routes are sufficient for now)
  - Multi-machine mesh (DorkOS is single-machine)
  - Agent versioning or rollback
  - Configurable health thresholds (hardcode initially, configurable later if needed)

## 2) Pre-reading Log

- `packages/mesh/src/agent-registry.ts`: SQLite-backed registry with better-sqlite3, WAL mode, PRAGMA user_version migrations. Current schema has `agents` table with id, name, description, project_path, runtime, capabilities_json, manifest_json, registered_at, registered_by. No health columns yet — need migration to add `last_seen_at` and `last_seen_event`.
- `packages/mesh/src/mesh-core.ts`: Unified API facade — discover(), register(), deny(), query(). Orchestrates AgentRegistry, DenialList, DiscoveryEngine, RelayBridge. Health methods need to be added here.
- `packages/mesh/src/relay-bridge.ts`: Optional Relay integration — registers/unregisters Relay endpoints per agent using subject pattern `relay.agent.{projectName}.{agentId}`. This is where lifecycle signal emission should be added.
- `packages/relay/src/signal-emitter.ts`: SignalEmitter for ephemeral signals using NATS-style pattern matching. Emits to subscribers matching wildcard subjects. This is the mechanism for lifecycle events.
- `apps/server/src/routes/mesh.ts`: HTTP endpoints — POST /discover, POST/GET/PATCH/DELETE /agents, POST /deny, GET/DELETE /denied. Factory: `createMeshRouter(meshCore)`. New health/status routes go here.
- `apps/server/src/services/core/mcp-tool-server.ts`: MCP tool handlers — mesh_discover, mesh_register, mesh_deny, mesh_list, mesh_unregister. New mesh_status and mesh_inspect tools go here.
- `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`: Main panel with 3 tabs (Discovery, Agents, Denied). Uses Tabs from shared/ui. Need to add 4th Topology tab and stats header.
- `apps/client/src/layers/entities/mesh/model/`: 8 existing hooks. Need new hooks for health, status, and lifecycle events.
- `apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx`: Reference for status badges, timeline UI, duration formatting patterns.
- `apps/client/src/layers/features/relay/ui/ActivityFeed.tsx`: Reference for real-time event display.
- `apps/client/src/layers/features/relay/ui/DeliveryMetricsDashboard.tsx`: Reference for aggregate stats display.
- `apps/server/src/services/relay/trace-store.ts`: Reference for SQLite trace storage pattern (WAL mode, migrations, aggregates). Health tracking follows same pattern.
- `packages/shared/src/mesh-schemas.ts`: Zod schemas for AgentManifest, DiscoveryCandidate, DenialRecord. Need to add AgentHealth, MeshStatus, MeshInspect schemas.

## 3) Codebase Map

**Primary Components/Modules:**

| File | Role |
|------|------|
| `packages/mesh/src/agent-registry.ts` | SQLite storage — needs health columns migration |
| `packages/mesh/src/mesh-core.ts` | Unified API — needs health query methods |
| `packages/mesh/src/relay-bridge.ts` | Relay integration — needs lifecycle signal emission |
| `apps/server/src/routes/mesh.ts` | HTTP endpoints — needs GET /status and GET /agents/:id/health |
| `apps/server/src/services/core/mcp-tool-server.ts` | MCP tools — needs mesh_status and mesh_inspect |
| `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx` | Main panel — needs Topology tab + stats header |
| `apps/client/src/layers/entities/mesh/model/` | Domain hooks — needs health, status, lifecycle hooks |
| `packages/shared/src/mesh-schemas.ts` | Zod schemas — needs health/status/inspect schemas |

**Shared Dependencies:**

- `packages/relay/src/signal-emitter.ts` — SignalEmitter for lifecycle events
- `@dorkos/shared/relay-schemas` — Signal types
- `@dorkos/shared/mesh-schemas` — Agent types (extended with health)
- `better-sqlite3` — SQLite storage (already a dependency)
- `@xyflow/react` — **NEW** dependency for topology graph

**Data Flow:**

```
Agent Relay activity → RelayBridge observes → updates last_seen_at in AgentRegistry
                     → emits lifecycle signal on mesh.agent.lifecycle.{event}
                     → SSE fan-out to connected clients
                     → client TanStack Query invalidation → UI re-render

GET /api/mesh/status → MeshCore.getStatus() → AgentRegistry.getHealthAggregates() → SQL query
GET /api/mesh/agents/:id/health → MeshCore.getAgentHealth(id) → computed from last_seen_at
mesh_status MCP tool → same path as HTTP
mesh_inspect MCP tool → MeshCore.inspect(id) → manifest + health + relay endpoint
```

**Feature Flags/Config:**

| Flag | Env Var | Impact |
|------|---------|--------|
| Mesh | `DORKOS_MESH_ENABLED` | Guards all mesh routes, MCP tools, and UI |
| Relay | `DORKOS_RELAY_ENABLED` | Required for lifecycle signal emission |

**Potential Blast Radius:**

- **Direct changes:** ~12-15 files (mesh core, server routes, MCP tools, schemas, client hooks, client UI)
- **Indirect:** MeshPanel.tsx consumers, mesh entity barrel exports
- **Tests:** ~5-7 new test files + updates to existing mesh tests
- **New dependency:** `@xyflow/react` (lazy-loaded in Topology tab)

## 4) Root Cause Analysis

N/A — this is a new feature, not a bug fix.

## 5) Research

### Potential Solutions (Graph Library)

**1. @xyflow/react (React Flow v12)** — SELECTED
- Description: Dominant React node-graph library; nodes are plain React components
- Pros: Confirmed React 19 + Tailwind 4 compat; custom nodes embed shadcn Badge/status dots; first-party dagre + ELK layout adapters; 2.9M weekly npm downloads; excellent DX
- Cons: ~150-200 KB min+gz (lazy-load the Topology tab); `nodeTypes` must be defined outside parent component
- Complexity: Low
- Maintenance: High (active, well-funded)

**2. Cytoscape.js + react-cytoscapejs**
- Description: Graph theory library with canvas/SVG rendering
- Pros: Strong algorithm support
- Cons: 365 KB min / 112 KB gzip; canvas-rendered (can't embed React components as nodes); uncertain React 19 compat
- Complexity: High
- Maintenance: Medium

**3. Custom SVG + d3-force**
- Description: Roll-your-own with React SVG + d3-force physics
- Pros: ~10 KB, maximum control, full React 19 compat
- Cons: Must implement drag, zoom/pan, edges, tooltips from scratch
- Complexity: Very High
- Maintenance: N/A

### Health Monitoring Patterns

- **Recommended:** Computed 3-state model from `last_seen_at` timestamp
  - **Active:** last seen < 5 minutes ago
  - **Inactive:** last seen 5-30 minutes ago
  - **Stale:** last seen > 30 minutes ago (or never seen)
- Status computed at query time via SQL `CASE WHEN` — no background jobs, no stored status column
- `last_seen_at` updated on any Relay activity involving the agent (message sent/received)
- Optional explicit heartbeat endpoint for idle agents: `POST /api/mesh/agents/:id/heartbeat`

### Graph Layout Recommendations

- **Default: Dagre (left-to-right)** — deterministic, fast, zero config, copy-paste example on reactflow.dev
- **Optional future: ELK with grouping** — clusters agents by runtime attribute
- **Avoid force-directed as default** — non-deterministic layout causes visual churn on refresh
- Always call `fitView()` on initial load; include React Flow's built-in `<Controls />` for zoom

### Dashboard Design Patterns (from Kiali, Consul, Grafana)

- Green = active, yellow/amber = inactive, red/grey = stale — universal service mesh convention
- Show aggregate summary counts above the graph (X active, Y inactive, Z stale)
- Click node → detail panel with last-seen, registered-at, capabilities, recent lifecycle events
- Position topology as "overview, not comprehensive monitoring"

### Security & Performance

- Topology endpoint returns project paths — apply `lib/boundary.ts` validation
- Heartbeat endpoint must validate agent ID exists
- React Flow + 10-50 nodes: no optimization needed; `React.memo` on node component as good practice
- Poll health summary every 30s with TanStack Query `refetchInterval`
- Lazy-load Topology tab with `React.lazy()` to avoid @xyflow/react in initial bundle

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Graph library for topology visualization | `@xyflow/react` (React Flow v12) | Confirmed React 19 + Tailwind 4 compat, custom nodes as real React components (embed shadcn patterns), first-party dagre layout adapter, 2.9M weekly downloads. Only library that doesn't require canvas rendering workarounds. |
| 2 | Health status threshold model | Computed 3-state at query time | Active (<5m), Inactive (5-30m), Stale (>30m) computed from `last_seen_at` via SQL CASE WHEN. No background jobs, no stored status column. Hardcode thresholds initially — configurable later only if needed. |
| 3 | UI layout for observability | New "Topology" tab + stats header in MeshPanel | 4th tab alongside Discovery/Agents/Denied. Compact stats bar above tabs for total/active/inactive counts. Purely additive — no changes to existing tabs. |
| 4 | Lifecycle event mechanism | Relay signals + SSE fan-out | Emit on `mesh.agent.lifecycle.{event}` via SignalEmitter. Server SSE streams fan to client for real-time updates. Consistent with existing Relay patterns; allows other subsystems to subscribe to mesh events. |
