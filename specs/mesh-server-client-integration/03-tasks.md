# Task Breakdown: Mesh Server & Client Integration

**Spec:** [02-specification.md](./02-specification.md)
**Generated:** 2026-02-25
**Mode:** Full decomposition

---

## Phase 1: Server Foundation (4 tasks)

### 1.1 Create mesh feature flag module and update config route

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.2

Create `apps/server/src/services/mesh/mesh-state.ts` following the relay-state.ts pattern. Update config route to include `mesh: { enabled }` in GET response. Add `mesh` field to `ServerConfigSchema` in shared schemas. Add `DORKOS_MESH_ENABLED` to `turbo.json` globalPassThroughEnv.

**Files:** `services/mesh/mesh-state.ts` (new), `routes/config.ts`, `packages/shared/src/schemas.ts`, `turbo.json`

---

### 1.2 Add HTTP request/response schemas to mesh-schemas.ts

**Size:** Small | **Priority:** High | **Dependencies:** None | **Parallel with:** 1.1

Add 5 Zod schemas for HTTP validation: `DiscoverRequestSchema`, `RegisterAgentRequestSchema`, `DenyRequestSchema`, `UpdateAgentRequestSchema`, `AgentListQuerySchema`. All with `.openapi()` metadata and exported TypeScript types.

**Files:** `packages/shared/src/mesh-schemas.ts`

---

### 1.3 Create mesh route factory with all HTTP endpoints

**Size:** Medium | **Priority:** High | **Dependencies:** 1.2

Create `apps/server/src/routes/mesh.ts` with `createMeshRouter(meshCore)` factory. 9 endpoints: POST /discover, POST /agents, GET /agents, GET /agents/:id, PATCH /agents/:id, DELETE /agents/:id, POST /deny, GET /denied, DELETE /denied/:encodedPath. Uses boundary validation, Zod safeParse, and path traversal protection.

**Files:** `routes/mesh.ts` (new)

---

### 1.4 Integrate MeshCore into server lifecycle in index.ts

**Size:** Medium | **Priority:** High | **Dependencies:** 1.1, 1.3

Wire MeshCore initialization (data dir at `~/.dork/mesh/`), route mounting, MCP dep injection, and graceful shutdown into `index.ts`. Feature-flagged via `DORKOS_MESH_ENABLED=true`.

**Files:** `apps/server/src/index.ts`

---

### 1.5 Add server route tests for mesh endpoints

**Size:** Medium | **Priority:** High | **Dependencies:** 1.3

Comprehensive route handler tests with mock MeshCore. Tests all 9 endpoints including happy paths, validation errors (400), not found (404), and path traversal rejection.

**Files:** `routes/__tests__/mesh.test.ts` (new)

---

## Phase 2: MCP Tools & Transport (3 tasks)

### 2.1 Add MCP tool handlers for mesh operations

**Size:** Medium | **Priority:** High | **Dependencies:** 1.4 | **Parallel with:** 2.2

Add `meshCore` to `McpToolDeps`, `requireMesh` guard, and 5 tool handlers: `mesh_discover`, `mesh_register`, `mesh_list`, `mesh_deny`, `mesh_unregister`. Register tools conditionally when meshCore is provided.

**Files:** `services/core/mcp-tool-server.ts`

---

### 2.2 Add Mesh methods to Transport interface, HttpTransport, and mock transport

**Size:** Medium | **Priority:** High | **Dependencies:** 1.2 | **Parallel with:** 2.1

Add 9 Mesh methods to Transport interface. Implement in HttpTransport mapping to `/api/mesh/*` endpoints. Add mock stubs to `createMockTransport()` in test-utils.

**Files:** `packages/shared/src/transport.ts`, `apps/client/src/layers/shared/lib/http-transport.ts`, `packages/test-utils/src/mock-factories.ts`

---

### 2.3 Add MCP tool tests for mesh tools

**Size:** Small | **Priority:** Medium | **Dependencies:** 2.1

Test all 5 mesh tools in both disabled (MESH_DISABLED error) and enabled (happy path) modes. Verify async generator collection, override building, and not-found handling.

**Files:** `services/core/__tests__/mesh-tools.test.ts` (new)

---

## Phase 3: Client Entity Layer (2 tasks)

### 3.1 Create client entity hooks for mesh data fetching

**Size:** Medium | **Priority:** High | **Dependencies:** 2.2 | **Parallel with:** 3.2

Create 8 TanStack Query hooks: `useMeshEnabled`, `useRegisteredAgents`, `useDiscoverAgents`, `useRegisterAgent`, `useDenyAgent`, `useUnregisterAgent`, `useUpdateAgent`, `useDeniedAgents`. Barrel exports from `entities/mesh/index.ts`.

**Files:** `apps/client/src/layers/entities/mesh/` (new directory with 9 files)

---

### 3.2 Add client entity hook tests for mesh

**Size:** Small | **Priority:** Medium | **Dependencies:** 3.1

Test hooks with mock transport: feature flag detection, conditional fetching, mutation calls, and query invalidation.

**Files:** `entities/mesh/__tests__/mesh-hooks.test.ts` (new)

---

## Phase 4: Client Feature Layer (5 tasks)

### 4.1 Create MeshPanel with tabs and disabled state

**Size:** Large | **Priority:** High | **Dependencies:** 3.1

Main panel with 3 tabs (Discovery, Agents, Denied). Disabled state shows enable instruction. Includes DiscoveryTab (scan button + DirectoryPicker + candidate cards), AgentsTab (list + register button), DeniedTab (list + clear buttons). Barrel exports from `features/mesh/index.ts`.

**Files:** `apps/client/src/layers/features/mesh/` (new directory: MeshPanel.tsx, DiscoveryTab.tsx, AgentsTab.tsx, DeniedTab.tsx, index.ts)

---

### 4.2 Create CandidateCard and AgentCard components

**Size:** Medium | **Priority:** High | **Dependencies:** 3.1 | **Parallel with:** 4.1

CandidateCard: shows path, runtime badge, strategy badge, capabilities, approve/deny actions with optional reason input. AgentCard: expand/collapse detail, inline edit, unregister with confirm.

**Files:** `features/mesh/ui/CandidateCard.tsx` (new), `features/mesh/ui/AgentCard.tsx` (new)

---

### 4.3 Create RegisterAgentDialog for manual registration

**Size:** Medium | **Priority:** Medium | **Dependencies:** 3.1 | **Parallel with:** 4.1, 4.2

Dialog with DirectoryPicker for path, text inputs for name/description, select for runtime (4 options), chip/tag input for capabilities. Uses ResponsiveDialog wrapper pattern.

**Files:** `features/mesh/ui/RegisterAgentDialog.tsx` (new)

---

### 4.4 Mount MeshPanel in sidebar alongside Pulse and Relay

**Size:** Small | **Priority:** High | **Dependencies:** 4.1

Add Network icon button to sidebar toolbar with dimmed/active styling based on feature flag. Open MeshPanel in ResponsiveDialog. Follow exact Relay/Pulse panel mounting pattern.

**Files:** `features/session-list/ui/SessionSidebar.tsx`

---

### 4.5 Add MeshPanel component tests

**Size:** Small | **Priority:** Medium | **Dependencies:** 4.1 | **Parallel with:** 4.4

Test disabled state rendering, tab rendering when enabled, and default tab selection.

**Files:** `features/mesh/__tests__/MeshPanel.test.tsx` (new)

---

## Phase 5: Documentation & Polish (2 tasks)

### 5.1 Update CLAUDE.md with Mesh subsystem documentation

**Size:** Small | **Priority:** Medium | **Dependencies:** 4.4 | **Parallel with:** 5.2

Add Mesh to: route groups, services list, MCP tools, client FSD layers table, Transport interface section, shared package description.

**Files:** `CLAUDE.md`

---

### 5.2 Register Mesh endpoints in OpenAPI registry

**Size:** Small | **Priority:** Low | **Dependencies:** 1.3 | **Parallel with:** 5.1

Register all 9 Mesh endpoints in the OpenAPI registry for Scalar docs. Tag as "Mesh". Reference Zod schemas for request/response documentation.

**Files:** `services/core/openapi-registry.ts`

---

## Summary

| Phase                      | Tasks  | Size Breakdown                 |
| -------------------------- | ------ | ------------------------------ |
| P1: Server Foundation      | 5      | 2 small, 3 medium              |
| P2: MCP Tools & Transport  | 3      | 1 small, 2 medium              |
| P3: Client Entity Layer    | 2      | 1 small, 1 medium              |
| P4: Client Feature Layer   | 5      | 2 small, 2 medium, 1 large     |
| P5: Documentation & Polish | 2      | 2 small                        |
| **Total**                  | **17** | **7 small, 8 medium, 1 large** |

### Dependency Graph

```
1.1 ──┐
      ├── 1.4 ── 2.1 ── 2.3
1.2 ──┤
      ├── 1.3 ── 1.5
      │         └── 5.2
      └── 2.2 ── 3.1 ── 3.2
                  │
                  ├── 4.1 ── 4.4 ── 5.1
                  │    │     └── 4.5
                  ├── 4.2
                  └── 4.3
```

### Parallelism Opportunities

- **1.1 + 1.2**: Feature flag and schemas can be built simultaneously
- **2.1 + 2.2**: MCP tools and Transport can be built simultaneously
- **4.1 + 4.2 + 4.3**: Panel, cards, and dialog can be built simultaneously
- **5.1 + 5.2**: Documentation updates can be done simultaneously
