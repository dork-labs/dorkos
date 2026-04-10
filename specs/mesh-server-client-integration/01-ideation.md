---
slug: mesh-server-client-integration
number: 56
created: 2026-02-25
status: ideation
---

# Mesh Server & Client Integration

**Slug:** mesh-server-client-integration
**Author:** Claude Code
**Date:** 2026-02-25
**Branch:** preflight/mesh-server-client-integration
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Integrate the `@dorkos/mesh` core library into the DorkOS server and client — adding HTTP routes for agent discovery/registration, MCP tools for agent-to-agent discovery, server lifecycle management with feature flag gating, and a client-side Mesh panel with discovery, registration, and management workflows.
- **Assumptions:**
  - `packages/mesh/` is a complete, tested library (87 passing tests, built in Spec 1)
  - The Relay integration (`routes/relay.ts`, `relay-state.ts`, `features/relay/`, `entities/relay/`) is the 1:1 reference pattern for this work
  - Mesh is an opt-in subsystem, disabled by default, enabled via `DORKOS_MESH_ENABLED=true`
  - `MeshCore` accepts an optional `RelayCore` instance — Mesh works standalone but gains Relay endpoint registration when both are enabled
  - Existing Zod schemas in `packages/shared/src/mesh-schemas.ts` are sufficient; additional HTTP request/response schemas will be added
- **Out of scope:**
  - Changes to the `@dorkos/mesh` core library itself (already built)
  - Network topology and ACL configuration UI (Spec 3)
  - Topology visualization (Spec 4)
  - Lazy activation (Spec 4)
  - CLI commands for mesh (Spec 4)

## 2) Pre-reading Log

- `apps/server/src/routes/relay.ts`: Route factory pattern with `createRelayRouter(relayCore, adapterManager): Router`. Zod validation via `schema.safeParse(req.body)`, 400 on failure. Cursor pagination for message lists.
- `apps/server/src/services/relay/relay-state.ts`: 15-line feature flag pattern with `setRelayEnabled(bool)` / `isRelayEnabled(): bool`. Imported by `routes/config.ts` to populate server config response.
- `apps/server/src/services/core/mcp-tool-server.ts`: Factory `createDorkOsToolServer(deps: McpToolDeps)` with optional `relayCore`, `pulseStore`. Tools guarded by `requireRelay(deps)` / `requirePulse(deps)` helpers that return error if feature not injected.
- `apps/server/src/index.ts`: Conditional initialization sequence — check env/config → create service → inject into MCP deps → mount routes → set feature flag. Graceful shutdown in reverse order.
- `apps/server/src/routes/config.ts`: Returns `ServerConfig` with `pulse: { enabled }`, `relay: { enabled }`, `tunnel: { ... }`. Mesh will add `mesh: { enabled }`.
- `apps/client/src/layers/entities/relay/`: Entity hooks — `use-relay-config.ts` (useRelayEnabled), `use-relay-messages.ts`, `use-relay-endpoints.ts`, `use-relay-metrics.ts`, `use-relay-adapters.ts`, `use-relay-event-stream.ts`. All use TanStack Query with Transport context.
- `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`: Panel with Tabs (Activity, Endpoints, Adapters). Feature-flag guard renders `DisabledState` when relay is off.
- `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`: Form pattern using `ResponsiveDialog`, `useState` for multi-field state, `DirectoryPicker` for path selection, mutation on submit.
- `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`: Reusable directory picker with `open`, `onOpenChange`, `onSelect`, `initialPath` props. Shows browse view and recent directories.
- `packages/mesh/src/index.ts`: Exports MeshCore, strategies, AgentRegistry, DenialList, readManifest, writeManifest, RelayBridge.
- `packages/mesh/src/mesh-core.ts`: MeshCore class composing all modules. Methods: discover(), register(), registerByPath(), deny(), undeny(), unregister(), list(), get(), getByPath(). Constructor: `MeshOptions { dataDir, relayCore?, strategies? }`.
- `packages/shared/src/mesh-schemas.ts`: Zod schemas with `.openapi()` metadata — AgentManifestSchema, DiscoveryCandidateSchema, AgentHintsSchema, DenialRecordSchema, AgentRuntimeSchema, AgentBehaviorSchema, AgentBudgetSchema.
- `packages/shared/src/transport.ts`: Transport interface. Relay methods at bottom (listRelayMessages, sendRelayMessage, etc.). Mesh methods not yet added.
- `contributing/data-fetching.md`: TanStack Query patterns — useQuery for reads, useMutation for writes, queryClient.invalidateQueries on mutation success.
- `contributing/api-reference.md`: OpenAPI documentation patterns, Zod-to-OpenAPI generation via openapi-registry.ts.
- `decisions/0017-standardize-subsystem-integration-pattern.md`: ADR documenting the standardized pattern for subsystem integration (feature flag, conditional mount, MCP tools, FSD modules).
- `decisions/0023-custom-async-bfs-for-agent-discovery.md`: ADR for the BFS discovery engine approach.
- `decisions/0024-dorkos-native-agent-manifest-format.md`: ADR for .dork/agent.json manifest format.
- `decisions/0025-simple-json-columns-for-agent-registry.md`: ADR for SQLite schema with JSON columns.

## 3) Codebase Map

- **Primary components/modules:**
  - `apps/server/src/routes/mesh.ts` (NEW) — Route factory with CRUD endpoints
  - `apps/server/src/services/mesh/mesh-state.ts` (NEW) — Feature flag holder
  - `apps/server/src/services/core/mcp-tool-server.ts` — Add mesh tools (mesh_discover, mesh_register, mesh_deny, mesh_list, mesh_unregister)
  - `apps/server/src/index.ts` — Add MeshCore initialization and lifecycle
  - `apps/server/src/routes/config.ts` — Add `mesh.enabled` to ServerConfig
  - `packages/shared/src/transport.ts` — Add Mesh methods to Transport interface
  - `packages/shared/src/mesh-schemas.ts` — Add HTTP request/response schemas
  - `apps/client/src/layers/entities/mesh/` (NEW) — Entity hooks
  - `apps/client/src/layers/features/mesh/` (NEW) — MeshPanel with tabs

- **Shared dependencies:**
  - `packages/mesh/` — Core library (no changes)
  - `packages/shared/src/mesh-schemas.ts` — Zod schemas (additions)
  - `@tanstack/react-query` — Data fetching hooks
  - `apps/client/src/layers/shared/ui/` — DirectoryPicker, Badge, Tabs, Button, Dialog, Input, Select
  - `apps/client/src/layers/shared/model/` — TransportContext, useTransport()

- **Data flow:**
  - Discovery: Client Button → Transport.discoverAgents(paths) → POST /api/mesh/discover → MeshCore.discover() → collect candidates → JSON response → Client renders CandidateCards
  - Registration: Client Approve → Transport.registerAgent(candidate) → POST /api/mesh/agents → MeshCore.register() → writes .dork/agent.json + SQLite + optional Relay endpoint → JSON response → invalidate agents query
  - Manual Registration: Client Form → Transport.registerAgent({path, ...overrides}) → POST /api/mesh/agents → MeshCore.registerByPath() → same as above

- **Feature flags/config:**
  - `DORKOS_MESH_ENABLED` env var → `mesh-state.ts` → `routes/config.ts` → client `useMeshEnabled()`
  - Added to `turbo.json` `globalPassThroughEnv`

- **Potential blast radius:**
  - Direct: ~15 files (7 server, 6 client, 2 shared)
  - Indirect: `packages/test-utils/src/mock-factories.ts` (add mesh mock methods to Transport), App.tsx (mount MeshPanel)
  - Tests: New test files for routes, MCP tools, entity hooks, feature components
  - Config: `turbo.json` (env var), AGENTS.md (docs)

## 4) Root Cause Analysis

N/A — This is a feature, not a bug fix.

## 5) Research

- **Potential solutions:**
  1. **Follow Relay Integration Pattern 1:1** — Use the exact same patterns: route factory, feature flag module, MCP tool guards, FSD entity/feature layers, TanStack Query hooks, Transport interface extension.
     - Pros: Proven patterns, consistent codebase, fast to implement, ADR-17 mandates this
     - Cons: None significant — this is the established path
     - Complexity: Medium (wide blast radius but low conceptual novelty)

  2. **Standalone Mesh Server** — Run Mesh as a separate microservice with its own Express instance.
     - Pros: Complete isolation, independent deployment
     - Cons: Over-engineered for a single-user tool, breaks monolith architecture, complicates MCP integration
     - Complexity: High

  3. **GraphQL API for Mesh** — Use GraphQL for the rich query patterns (filter by runtime, capability).
     - Pros: Flexible querying, type-safe schema
     - Cons: Introduces new paradigm, no existing GraphQL infrastructure, unnecessary for simple CRUD
     - Complexity: High

- **Recommendation:** Approach 1 — Follow the Relay integration pattern exactly. ADR-17 already standardizes this pattern, and all the tooling is in place.

- **Discovery UI insights from research:**
  - Card-based review interface with per-candidate approve/deny (like AdapterCard toggle pattern)
  - Batch operations toolbar for approve-all/deny-all when multiple candidates
  - Strategy badge (ClaudeCode, Cursor, Codex) and runtime indicator per candidate
  - Candidate cards should show: directory path, detected runtime, suggested name, strategy used, detected capabilities

- **Registry dashboard insights:**
  - Expandable agent cards (like ScheduleRow) showing summary + detail on expand
  - Capability chips as shadcn Badge components
  - Runtime badge with color coding
  - Edit and unregister actions per agent

- **Form design insights:**
  - Tag/chip input for capabilities using controlled Input + Badge (no new dependencies)
  - DirectoryPicker already exists in shared/ui/ — reuse directly
  - CreateScheduleDialog is the direct template for the registration form
  - Runtime dropdown with Select component

## 6) Decisions

| #   | Decision             | Choice                                                   | Rationale                                                                                                                                                                           |
| --- | -------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Discovery API style  | Synchronous collection (POST returns JSON array)         | Simpler client integration, matches Relay patterns. MeshCore.discover() AsyncGenerator is collected server-side. Scans typically complete in <2 seconds for local directories.      |
| 2   | Panel access pattern | Sidebar tab alongside Relay and Pulse                    | Follows established pattern — RelayPanel and PulsePanel are both sidebar panel tabs. Consistent UX for all subsystem panels.                                                        |
| 3   | Graceful shutdown    | Add close() to MeshCore and include in shutdown sequence | MeshCore.close() will close the SQLite database (AgentRegistry + DenialList). Added to graceful shutdown in index.ts after RelayCore.close(). Follows PulseStore/RelayCore pattern. |
