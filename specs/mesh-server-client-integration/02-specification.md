---
slug: mesh-server-client-integration
number: 56
created: 2026-02-25
status: specified
---

# Specification: Mesh Server & Client Integration

**Status:** Specified
**Author:** Claude Code
**Date:** 2026-02-25
**Spec Number:** 56
**Related Ideation:** [01-ideation.md](./01-ideation.md)

---

## 1. Overview

Integrate the `@dorkos/mesh` core library into the DorkOS server and client stack. This adds HTTP routes for agent discovery and registration, MCP tools for agent-to-agent discovery, server lifecycle management with feature flag gating, and a client-side Mesh panel with discovery, registration, and management workflows.

The `@dorkos/mesh` package already exists at `packages/mesh/` with 87 passing tests. This spec is purely about wiring that library into the existing DorkOS stack following the established subsystem integration pattern (ADR-17).

## 2. Background / Problem Statement

DorkOS currently provides agent scheduling (Pulse) and inter-agent messaging (Relay) as subsystem integrations. The Mesh module — responsible for discovering and registering agents in the local filesystem — exists as a standalone library but is not yet accessible through the DorkOS server API, MCP tools, or client UI.

Without this integration, users must interact with Mesh programmatically. The integration will make agent discovery and registration available through the same HTTP/MCP/UI channels as Pulse and Relay.

## 3. Goals

- Expose Mesh discovery, registration, denial, and management through REST API endpoints
- Add MCP tools so Claude agents can discover and register other agents autonomously
- Feature-flag gate the subsystem (`DORKOS_MESH_ENABLED`) with disabled-by-default behavior
- Provide a client-side Mesh panel with Discovery, Agents, and Denied tabs
- Follow the Relay integration pattern 1:1 for consistency (ADR-17)

## 4. Non-Goals

- Changes to the `@dorkos/mesh` core library itself
- Network topology or ACL configuration UI
- Topology visualization
- Lazy activation / auto-enable
- CLI commands for mesh
- SSE streaming for discovery results (synchronous collection is sufficient)

## 5. Technical Dependencies

- `@dorkos/mesh` — Core library (already built, 87 tests passing)
- `@dorkos/shared` — Zod schemas, Transport interface, types
- `@dorkos/relay` — Optional RelayCore for endpoint auto-registration
- `@tanstack/react-query` — Client data fetching
- `better-sqlite3` — Used by MeshCore internally (no new dep)
- `ulidx` — Used by MeshCore internally (no new dep)

## 6. Detailed Design

### 6.1 Server Feature Flag

**File:** `apps/server/src/services/mesh/mesh-state.ts` (NEW)

Follows the exact pattern of `services/relay/relay-state.ts`:

```typescript
const state = { enabled: false };

export function setMeshEnabled(enabled: boolean): void {
  state.enabled = enabled;
}

export function isMeshEnabled(): boolean {
  return state.enabled;
}
```

**Config route update** (`apps/server/src/routes/config.ts`):

Add `isMeshEnabled` import and include `mesh: { enabled: isMeshEnabled() }` in the GET response alongside existing `pulse` and `relay` fields.

**Turbo config** (`turbo.json`):

Add `"DORKOS_MESH_ENABLED"` to the `globalPassThroughEnv` array.

### 6.2 Server Routes

**File:** `apps/server/src/routes/mesh.ts` (NEW)

Export: `createMeshRouter(meshCore: MeshCore): Router`

All routes use Zod `safeParse()` for request validation, returning 400 with `{ error: 'Validation failed', details: result.error.flatten() }` on failure. Error responses follow the same patterns as `routes/relay.ts`.

| Method | Path                   | Description            | Request                                                                   | Response                               |
| ------ | ---------------------- | ---------------------- | ------------------------------------------------------------------------- | -------------------------------------- |
| POST   | `/discover`            | Trigger discovery scan | `{ roots: string[], maxDepth?: number }`                                  | `{ candidates: DiscoveryCandidate[] }` |
| POST   | `/agents`              | Register an agent      | `{ path: string, overrides?: Partial<AgentManifest>, approver?: string }` | AgentManifest (201)                    |
| GET    | `/agents`              | List registered agents | Query: `runtime?`, `capability?`                                          | `{ agents: AgentManifest[] }`          |
| GET    | `/agents/:id`          | Get agent detail       | —                                                                         | AgentManifest                          |
| PATCH  | `/agents/:id`          | Update agent fields    | `{ name?, description?, capabilities? }`                                  | AgentManifest                          |
| DELETE | `/agents/:id`          | Unregister an agent    | —                                                                         | `{ success: true }`                    |
| POST   | `/deny`                | Deny a candidate       | `{ path: string, reason?: string, denier?: string }`                      | `{ success: true }`                    |
| GET    | `/denied`              | List denied paths      | —                                                                         | `{ denied: DenialRecord[] }`           |
| DELETE | `/denied/:encodedPath` | Clear a denial         | —                                                                         | `{ success: true }`                    |

**Discovery route implementation note:** The `MeshCore.discover()` method returns an `AsyncGenerator`. The route handler collects all candidates into an array before returning the JSON response. This is appropriate because local filesystem scans complete in under 2 seconds for typical directory structures.

**Delete denied path:** The path parameter uses `encodeURIComponent` encoding since paths contain slashes. The route decodes via `decodeURIComponent(req.params.encodedPath)`.

### 6.3 Server Lifecycle

**File:** `apps/server/src/index.ts` (MODIFY)

Add Mesh initialization following the Relay block pattern:

```typescript
import { MeshCore } from '@dorkos/mesh';
import { createMeshRouter } from './routes/mesh.js';
import { setMeshEnabled } from './services/mesh/mesh-state.js';

// Global reference for graceful shutdown
let meshCore: MeshCore | undefined;

// Inside start():
const meshEnabled = process.env.DORKOS_MESH_ENABLED === 'true';

if (meshEnabled) {
  const dorkHome = process.env.DORK_HOME || path.join(os.homedir(), '.dork');
  meshCore = new MeshCore({
    dataDir: path.join(dorkHome, 'mesh'),
    relayCore, // undefined when Relay is disabled — MeshCore handles this gracefully
  });
  logger.info('[Mesh] MeshCore initialized');
}

// Add meshCore to MCP deps:
const mcpToolServer = createDorkOsToolServer({
  ...existingDeps,
  ...(meshCore && { meshCore }),
});

// Mount routes after Relay routes:
if (meshEnabled && meshCore) {
  app.use('/api/mesh', createMeshRouter(meshCore));
  setMeshEnabled(true);
  logger.info('[Mesh] Routes mounted');
}

// In shutdown():
if (meshCore) {
  meshCore.close();
}
```

**Shutdown ordering:** MeshCore closes after Relay (since Mesh may reference RelayCore for endpoint deregistration). The `close()` method on MeshCore closes its SQLite database.

### 6.4 MCP Tools

**File:** `apps/server/src/services/core/mcp-tool-server.ts` (MODIFY)

Add `meshCore?: MeshCore` to `McpToolDeps` interface. Add guard function and tool handlers following the Relay pattern:

```typescript
import type { MeshCore } from '@dorkos/mesh';

// In McpToolDeps:
meshCore?: MeshCore;

// Guard:
function requireMesh(deps: McpToolDeps) {
  if (!deps.meshCore) {
    return jsonContent({ error: 'Mesh is not enabled', code: 'MESH_DISABLED' }, true);
  }
  return null;
}
```

**Tools to register:**

| Tool Name         | Description                           | Arguments                                                                                          |
| ----------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `mesh_discover`   | Scan directories for agent candidates | `{ roots: string[], maxDepth?: number }`                                                           |
| `mesh_register`   | Register an agent from a path         | `{ path: string, name?: string, description?: string, runtime?: string, capabilities?: string[] }` |
| `mesh_list`       | List registered agents                | `{ runtime?: string, capability?: string }`                                                        |
| `mesh_deny`       | Deny a candidate path                 | `{ path: string, reason?: string }`                                                                |
| `mesh_unregister` | Unregister an agent by ID             | `{ agentId: string }`                                                                              |

Tool handlers follow the same factory pattern as Relay tools (e.g., `createMeshDiscoverHandler(deps)`). The `mesh_discover` handler collects the `AsyncGenerator` into an array server-side.

### 6.5 Shared Schemas

**File:** `packages/shared/src/mesh-schemas.ts` (MODIFY)

Add HTTP request/response schemas alongside existing schemas:

```typescript
// Discovery request
export const DiscoverRequestSchema = z
  .object({
    roots: z.array(z.string().min(1)).min(1),
    maxDepth: z.number().int().min(1).optional(),
  })
  .openapi('DiscoverRequest');

// Registration request
export const RegisterAgentRequestSchema = z
  .object({
    path: z.string().min(1),
    overrides: AgentManifestSchema.partial().optional(),
    approver: z.string().optional(),
  })
  .openapi('RegisterAgentRequest');

// Deny request
export const DenyRequestSchema = z
  .object({
    path: z.string().min(1),
    reason: z.string().optional(),
    denier: z.string().optional(),
  })
  .openapi('DenyRequest');

// Update agent request (pick specific fields)
export const UpdateAgentRequestSchema = z
  .object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
  })
  .openapi('UpdateAgentRequest');

// Agent list query params
export const AgentListQuerySchema = z
  .object({
    runtime: AgentRuntimeSchema.optional(),
    capability: z.string().optional(),
  })
  .openapi('AgentListQuery');
```

### 6.6 Transport Interface

**File:** `packages/shared/src/transport.ts` (MODIFY)

Add Mesh section after Relay Adapters:

```typescript
import type {
  AgentManifest,
  DiscoveryCandidate,
  DenialRecord,
} from './mesh-schemas.js';

// --- Mesh Agent Discovery ---

/** Discover agents by scanning directories. */
discoverMeshAgents(roots: string[], maxDepth?: number): Promise<{ candidates: DiscoveryCandidate[] }>;
/** List registered agents with optional filters. */
listMeshAgents(filters?: { runtime?: string; capability?: string }): Promise<{ agents: AgentManifest[] }>;
/** Get a single registered agent by ID. */
getMeshAgent(id: string): Promise<AgentManifest>;
/** Register an agent from a path with optional overrides. */
registerMeshAgent(path: string, overrides?: Partial<AgentManifest>, approver?: string): Promise<AgentManifest>;
/** Update a registered agent's mutable fields. */
updateMeshAgent(id: string, updates: { name?: string; description?: string; capabilities?: string[] }): Promise<AgentManifest>;
/** Unregister an agent by ID. */
unregisterMeshAgent(id: string): Promise<{ success: boolean }>;
/** Deny a candidate path from future discovery. */
denyMeshAgent(path: string, reason?: string, denier?: string): Promise<{ success: boolean }>;
/** List all denied paths. */
listDeniedMeshAgents(): Promise<{ denied: DenialRecord[] }>;
/** Clear a denial to re-allow discovery of a path. */
clearMeshDenial(path: string): Promise<{ success: boolean }>;
```

**HttpTransport implementation** (`apps/client/src/layers/shared/lib/transports/http-transport.ts`):

Each method maps to the corresponding HTTP endpoint:

```typescript
async discoverMeshAgents(roots: string[], maxDepth?: number) {
  const res = await this.post('/api/mesh/discover', { roots, maxDepth });
  return res.json();
}
async listMeshAgents(filters?: { runtime?: string; capability?: string }) {
  const params = new URLSearchParams();
  if (filters?.runtime) params.set('runtime', filters.runtime);
  if (filters?.capability) params.set('capability', filters.capability);
  const res = await this.get(`/api/mesh/agents?${params}`);
  return res.json();
}
// ... similar for all methods
```

**Mock Transport** (`packages/test-utils/src/mock-factories.ts`):

Add mock implementations in `createMockTransport()`:

```typescript
// Mesh
discoverMeshAgents: vi.fn().mockResolvedValue({ candidates: [] }),
listMeshAgents: vi.fn().mockResolvedValue({ agents: [] }),
getMeshAgent: vi.fn(),
registerMeshAgent: vi.fn(),
updateMeshAgent: vi.fn(),
unregisterMeshAgent: vi.fn().mockResolvedValue({ success: true }),
denyMeshAgent: vi.fn().mockResolvedValue({ success: true }),
listDeniedMeshAgents: vi.fn().mockResolvedValue({ denied: [] }),
clearMeshDenial: vi.fn().mockResolvedValue({ success: true }),
```

### 6.7 Client Entity Layer

**Directory:** `apps/client/src/layers/entities/mesh/` (NEW)

All hooks follow the TanStack Query patterns from `entities/relay/`.

**`model/use-mesh-config.ts`** — Feature flag hook:

```typescript
export function useMeshEnabled(): boolean {
  const transport = useTransport();
  const { data } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
    staleTime: 5 * 60 * 1000,
  });
  return data?.mesh?.enabled ?? false;
}
```

**`model/use-mesh-agents.ts`** — List registered agents:

```typescript
export function useRegisteredAgents(enabled: boolean) {
  const transport = useTransport();
  return useQuery({
    queryKey: ['mesh', 'agents'],
    queryFn: () => transport.listMeshAgents(),
    enabled,
    staleTime: 30_000,
  });
}
```

**`model/use-mesh-discover.ts`** — Discovery mutation:

```typescript
export function useDiscoverAgents() {
  const transport = useTransport();
  return useMutation({
    mutationFn: ({ roots, maxDepth }: { roots: string[]; maxDepth?: number }) =>
      transport.discoverMeshAgents(roots, maxDepth),
  });
}
```

**`model/use-mesh-register.ts`** — Register mutation with cache invalidation:

```typescript
export function useRegisterAgent() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      path,
      overrides,
      approver,
    }: {
      path: string;
      overrides?: Partial<AgentManifest>;
      approver?: string;
    }) => transport.registerMeshAgent(path, overrides, approver),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'agents'] });
    },
  });
}
```

**`model/use-mesh-deny.ts`** — Deny mutation.

**`model/use-mesh-unregister.ts`** — Unregister mutation with cache invalidation.

**`model/use-mesh-update.ts`** — Update mutation with cache invalidation.

**`model/use-mesh-denied.ts`** — List denied paths query.

**`index.ts`** — Barrel exports:

```typescript
/**
 * Mesh entity — domain hooks for agent discovery and registry.
 *
 * @module entities/mesh
 */
export { useMeshEnabled } from './model/use-mesh-config';
export { useRegisteredAgents } from './model/use-mesh-agents';
export { useDiscoverAgents } from './model/use-mesh-discover';
export { useRegisterAgent } from './model/use-mesh-register';
export { useDenyAgent } from './model/use-mesh-deny';
export { useUnregisterAgent } from './model/use-mesh-unregister';
export { useUpdateAgent } from './model/use-mesh-update';
export { useDeniedAgents } from './model/use-mesh-denied';
```

### 6.8 Client Feature Layer

**Directory:** `apps/client/src/layers/features/mesh/` (NEW)

#### MeshPanel.tsx

Main panel with 3 tabs: Discovery, Agents, Denied. Feature flag guard renders a disabled state when mesh is off (same pattern as `RelayPanel.tsx`):

```typescript
export function MeshPanel() {
  const meshEnabled = useMeshEnabled();

  if (!meshEnabled) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
        <Network className="size-8 text-muted-foreground/50" />
        <div>
          <p className="font-medium">Mesh is not enabled</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Mesh provides agent discovery and registration. Start DorkOS with mesh enabled.
          </p>
        </div>
        <code className="mt-2 rounded-md bg-muted px-3 py-1.5 font-mono text-sm">
          DORKOS_MESH_ENABLED=true dorkos
        </code>
      </div>
    );
  }

  return (
    <Tabs defaultValue="agents" className="flex h-full flex-col">
      <TabsList className="mx-4 mt-3 shrink-0">
        <TabsTrigger value="discovery">Discovery</TabsTrigger>
        <TabsTrigger value="agents">Agents</TabsTrigger>
        <TabsTrigger value="denied">Denied</TabsTrigger>
      </TabsList>
      {/* TabsContent for each tab */}
    </Tabs>
  );
}
```

#### CandidateCard.tsx

Card for a discovered candidate showing: directory path, runtime badge, strategy badge, suggested name, and capabilities. Actions: Approve (register) and Deny (with optional reason input).

#### AgentCard.tsx

Card for a registered agent showing: name, runtime badge, capabilities as Badge chips, description, and path. Expandable for detail. Actions: Edit and Unregister.

#### RegisterAgentDialog.tsx

Manual registration form using `ResponsiveDialog` wrapper (from Pulse `CreateScheduleDialog` pattern):

- `DirectoryPicker` for path selection (reuse from `shared/ui/`)
- Text inputs for name and description
- `Select` dropdown for runtime (`claude-code`, `cursor`, `codex`, `other`)
- Chip/tag input for capabilities using controlled `Input` + `Badge` pattern (no new dependencies)
- Submit calls `registerMeshAgent`

#### DiscoveryTab.tsx

Contains the scan button (with `DirectoryPicker` for root selection), loading state, and renders `CandidateCard` for each result. Includes batch approve/deny toolbar when multiple candidates exist.

### 6.9 App Integration

**Mount MeshPanel** as a sidebar tab alongside Relay and Pulse panels. Update the panel mounting point (likely `App.tsx` or the sidebar layout) to include the Mesh tab, gated behind the feature flag read from server config.

### 6.10 ServerConfig Type Update

**File:** `packages/shared/src/schemas.ts` (MODIFY)

Add `mesh: { enabled: boolean }` to `ServerConfigSchema` alongside existing `pulse` and `relay` fields.

## 7. User Experience

### Discovery Flow

1. User opens Mesh panel, navigates to Discovery tab
2. Clicks "Scan" button, selects root directories via DirectoryPicker
3. System scans directories and returns candidate cards
4. User reviews each candidate — sees name, runtime, strategy, capabilities
5. User clicks Approve (registers agent) or Deny (blocks future discovery)
6. Approved agents appear in the Agents tab

### Manual Registration Flow

1. User clicks "Register Agent" button in Agents tab
2. Dialog opens with DirectoryPicker for path selection
3. User fills in name, description, runtime, capabilities
4. Submit registers the agent and closes the dialog

### Agent Management

1. Agents tab shows all registered agents as cards
2. User can expand a card for details
3. Edit action allows modifying name, description, capabilities
4. Unregister action removes the agent (with confirmation)

## 8. Testing Strategy

### Server Route Tests

**File:** `apps/server/src/routes/__tests__/mesh.test.ts`

Test each route handler with mock MeshCore:

- POST /discover: Valid request returns candidates, invalid request returns 400
- POST /agents: Valid registration returns 201, invalid returns 400
- GET /agents: Returns list, filters by runtime/capability query params
- GET /agents/:id: Returns agent, 404 for unknown ID
- PATCH /agents/:id: Updates mutable fields, 404 for unknown ID
- DELETE /agents/:id: Unregisters agent, 404 for unknown ID
- POST /deny: Denies path, invalid request returns 400
- GET /denied: Returns denial list
- DELETE /denied/:path: Clears denial, 404 for unknown path

### MCP Tool Tests

Test mesh tools in `mcp-tool-server.test.ts`:

- `mesh_discover` returns candidates when Mesh is enabled
- `mesh_register` creates an agent
- `mesh_list` returns agents with optional filters
- `mesh_deny` denies a path
- `mesh_unregister` removes an agent
- All tools return error when Mesh is disabled (guard pattern)

### Client Entity Hook Tests

**Directory:** `apps/client/src/layers/entities/mesh/__tests__/`

Test each hook with mock transport:

- `useMeshEnabled` returns false when config has no mesh, true when enabled
- `useRegisteredAgents` calls transport.listMeshAgents when enabled
- `useDiscoverAgents` mutation calls transport.discoverMeshAgents
- `useRegisterAgent` mutation invalidates agents query on success
- `useUnregisterAgent` mutation invalidates agents query on success

### Client Feature Tests

**File:** `apps/client/src/layers/features/mesh/__tests__/MeshPanel.test.tsx`

- Renders disabled state when mesh is not enabled
- Renders tabs when mesh is enabled
- Discovery tab shows scan button
- Agents tab shows registered agents

## 9. Performance Considerations

- **Discovery scan:** Synchronous collection is bounded by filesystem I/O. The BFS engine has `maxDepth` (default 3) and `excludedDirs` to limit scan scope. Typical scans complete in <2 seconds for local directories.
- **SQLite queries:** MeshCore uses `better-sqlite3` with WAL mode. Agent listing is a simple SELECT — sub-millisecond for hundreds of agents.
- **TanStack Query caching:** Agent list has `staleTime: 30_000` (30 seconds) to avoid unnecessary refetches.

## 10. Security Considerations

- **Directory boundary:** The discovery scan accepts user-provided root paths. The route handler should validate these paths against the server's directory boundary (`lib/boundary.ts`) to prevent scanning outside allowed directories.
- **Feature flag gating:** Mesh routes are only mounted when `DORKOS_MESH_ENABLED=true`. When disabled, the endpoints don't exist (404), and MCP tools return error responses.
- **Path traversal:** The `DELETE /denied/:encodedPath` route uses `decodeURIComponent` — validate the decoded path doesn't contain `../` sequences.

## 11. Documentation

- Update `CLAUDE.md`: Add Mesh to server services list, route groups, client FSD layers
- Update `contributing/api-reference.md`: Document Mesh endpoints
- Register Mesh endpoints in `openapi-registry.ts` for Scalar API docs
- Add Mesh Transport methods to architecture docs

## 12. Implementation Phases

### Phase 1: Server Foundation

- Feature flag module (`mesh-state.ts`)
- HTTP request/response schemas in `mesh-schemas.ts`
- Route factory (`routes/mesh.ts`)
- Server lifecycle integration in `index.ts`
- Config route update
- Turbo env var passthrough
- Server route tests

### Phase 2: MCP Tools & Transport

- Add `meshCore` to `McpToolDeps`
- Implement 5 MCP tool handlers with guard
- Register tools in `createDorkOsToolServer`
- Add Mesh methods to Transport interface
- Implement in HttpTransport
- Add mock methods to `createMockTransport`
- MCP tool tests

### Phase 3: Client Entity Layer

- All 8 entity hooks
- Barrel exports
- Entity hook tests

### Phase 4: Client Feature Layer

- MeshPanel with tabs and disabled state
- CandidateCard component
- AgentCard component
- RegisterAgentDialog
- DiscoveryTab with scan flow
- Mount in app sidebar
- Feature component tests

### Phase 5: Documentation & Polish

- Update CLAUDE.md
- Update API reference
- Register OpenAPI endpoints
- ServerConfig type update

## 13. Open Questions

All questions were resolved during ideation (see Section 6 of ideation document):

1. ~~**Discovery API style**~~ (RESOLVED) — Synchronous collection (POST returns JSON array)
2. ~~**Panel access pattern**~~ (RESOLVED) — Sidebar tab alongside Relay and Pulse
3. ~~**Graceful shutdown**~~ (RESOLVED) — Add close() to MeshCore, include in shutdown sequence

## 14. Related ADRs

- **ADR-17:** Standardize Subsystem Integration Pattern — This spec follows the pattern exactly
- **ADR-23:** Custom Async BFS for Agent Discovery — Discovery engine design
- **ADR-24:** DorkOS-Native Agent Manifest Format — `.dork/agent.json` format
- **ADR-25:** Simple JSON Columns for Agent Registry SQLite Schema

## 15. Verification Criteria

- [ ] POST /api/mesh/discover triggers a scan and returns candidates
- [ ] POST /api/mesh/agents registers a candidate (writes .dork/agent.json, creates Relay endpoint)
- [ ] POST /api/mesh/agents with a path registers manually (no prior discovery)
- [ ] POST /api/mesh/deny denies a candidate (persists, filters from future scans)
- [ ] GET /api/mesh/agents returns registered agents
- [ ] GET /api/mesh/agents/:id returns agent detail
- [ ] DELETE /api/mesh/agents/:id unregisters an agent
- [ ] MCP tools mesh_discover, mesh_register, mesh_deny, mesh_list work from agent session
- [ ] Mesh is disabled by default — server starts without it
- [ ] DORKOS_MESH_ENABLED=true enables Mesh routes and MCP tools
- [ ] Client Mesh panel shows discovered candidates with approve/deny
- [ ] Client Mesh panel shows registered agents list
- [ ] Client Mesh panel supports manual registration via directory picker
- [ ] npm run build passes (all workspaces)
- [ ] npm run typecheck passes
- [ ] CLAUDE.md and API docs are updated

## 16. References

- Relay integration (1:1 template): `apps/server/src/routes/relay.ts`, `services/relay/relay-state.ts`
- MCP tool server: `apps/server/src/services/core/mcp-tool-server.ts`
- Server lifecycle: `apps/server/src/index.ts` (Relay initialization block)
- Entity hooks: `apps/client/src/layers/entities/relay/`
- Feature panel: `apps/client/src/layers/features/relay/ui/RelayPanel.tsx`
- Form dialog: `apps/client/src/layers/features/pulse/ui/CreateScheduleDialog.tsx`
- Directory picker: `apps/client/src/layers/shared/ui/DirectoryPicker.tsx`
- Mock transport: `packages/test-utils/src/mock-factories.ts`
- Zod schemas: `packages/shared/src/mesh-schemas.ts`
