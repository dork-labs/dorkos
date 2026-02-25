---
title: "Mesh Server & Client Integration"
spec: 2
order: 2
status: done
blockedBy: [1]
blocks: [3, 4]
parallelWith: []
litepaperPhase: "Phase 1 — Discovery, Registration, and Registry"
complexity: medium
risk: medium
estimatedFiles: 15-22
newPackages: []
primaryWorkspaces: ["apps/server", "apps/client", "packages/shared"]
touchesServer: true
touchesClient: true
verification:
  - "POST /api/mesh/discover triggers a scan and returns candidates"
  - "POST /api/mesh/agents registers a candidate (writes .dork/agent.json, creates Relay endpoint)"
  - "POST /api/mesh/agents with a path registers manually (no prior discovery)"
  - "POST /api/mesh/deny denies a candidate (persists, filters from future scans)"
  - "GET /api/mesh/agents returns registered agents"
  - "GET /api/mesh/agents/:id returns agent detail"
  - "DELETE /api/mesh/agents/:id unregisters an agent"
  - "MCP tools mesh_discover, mesh_register, mesh_deny, mesh_list work from agent session"
  - "Mesh is disabled by default — server starts without it"
  - "DORKOS_MESH_ENABLED=true enables Mesh routes and MCP tools"
  - "Client Mesh panel shows discovered candidates with approve/deny"
  - "Client Mesh panel shows registered agents list"
  - "Client Mesh panel supports manual registration via directory picker"
  - "npm run build passes (all workspaces)"
  - "CLAUDE.md and API docs are updated"
notes: >
  This is integration work — lower conceptual risk than Spec 1, but wider
  blast radius (server + client + shared + docs + turbo.json). Follow the
  Relay integration as a 1:1 pattern reference: routes/relay.ts, relay-state.ts,
  mcp-tool-server.ts Relay tools, features/relay/ client module. The discovery
  panel UI is the key differentiator from Relay — it needs a review workflow
  (approve/deny/ignore) that Relay doesn't have. Study how Pulse's
  CreateScheduleDialog handles form input for the manual registration flow.
---

# Spec 2: Mesh Server & Client Integration

## Prompt

```
Integrate the @dorkos/mesh core library into the DorkOS server and client — adding HTTP routes, MCP tools for agents, server lifecycle management, and a client-side Mesh panel with discovery and registration workflows.

This spec assumes packages/mesh/ already exists as a working library (built in Spec 1). The work here is wiring that library into the existing DorkOS stack following established patterns.

GOALS:
- Create apps/server/src/routes/mesh.ts with HTTP routes for Mesh:
  - POST /api/mesh/discover — trigger a discovery scan, return candidates
  - GET /api/mesh/candidates — list current unreviewed candidates (from last scan)
  - POST /api/mesh/agents — register an agent (from candidate approval OR manual path)
  - GET /api/mesh/agents — list registered agents (with optional capability/runtime filters)
  - GET /api/mesh/agents/:id — get agent detail
  - PATCH /api/mesh/agents/:id — update agent (name, capabilities, description, etc.)
  - DELETE /api/mesh/agents/:id — unregister an agent
  - POST /api/mesh/deny — deny a candidate
  - GET /api/mesh/denied — list denied candidates
  - DELETE /api/mesh/denied/:path — clear a denial (re-allows discovery)
- Add Mesh MCP tools to apps/server/src/services/mcp-tool-server.ts so agents can discover and register other agents:
  - mesh_discover — run discovery scan, return candidates
  - mesh_register — register a candidate or manual path (args: candidatePath OR agentDetails)
  - mesh_deny — deny a candidate (args: path, reason?)
  - mesh_list — list registered agents (args: capability?, runtime?)
  - mesh_unregister — unregister an agent (args: agentId)
- Add MeshCore initialization to apps/server/src/index.ts with feature flag support (DORKOS_MESH_ENABLED), dependency injection (pass RelayCore if available), and graceful shutdown
- Create apps/server/src/services/mesh-state.ts for mesh enabled status (same pattern as relay-state.ts)
- Add DORKOS_MESH_ENABLED to turbo.json globalPassThroughEnv
- Build a client-side Mesh panel in apps/client/ with three views:
  1. Discovery view — show candidates from last scan with approve/deny buttons, run new scan
  2. Registered agents view — list registered agents with detail expansion, edit, unregister
  3. Manual registration — directory picker + form for name, description, runtime, capabilities
- Add entity layer hooks in apps/client/src/layers/entities/mesh/:
  - useMeshEnabled — feature gate check
  - useDiscoverAgents — mutation to trigger scan
  - useCandidates — query for unreviewed candidates
  - useRegisteredAgents — query for registered agents list
  - useRegisterAgent — mutation to approve/register
  - useDenyAgent — mutation to deny
  - useUnregisterAgent — mutation to unregister
  - useUpdateAgent — mutation to edit agent details
- Update packages/shared/src/mesh-schemas.ts with any additional request/response schemas for the HTTP API
- Add API documentation for Mesh endpoints
- Update CLAUDE.md with Mesh architecture information
- Integration tests for routes and MCP tools

INTENDED OUTCOMES:
- Agents can discover and register other agents through MCP tools (mesh_discover, mesh_register)
- Developers can interact with Mesh through REST API
- The client has a full discovery and registration workflow — scan, review candidates, approve/deny, manage registered agents
- Mesh is feature-flagged and disabled by default (opt-in, like Relay and Pulse)
- Documentation is updated to reflect the new module

KEY INTEGRATION PATTERNS (already established — follow these):
- Route factory: createMeshRouter(meshCore): Router — see apps/server/src/routes/relay.ts
- MCP tools: factory handler pattern with McpToolDeps injection — see apps/server/src/services/mcp-tool-server.ts
- Feature flag: DORKOS_MESH_ENABLED env var + config manager — see how DORKOS_RELAY_ENABLED works
- Server startup: instantiate MeshCore → inject RelayCore → inject into MCP deps → conditionally mount routes → graceful shutdown
- Client FSD: new feature module at apps/client/src/layers/features/mesh/ and entity hooks at entities/mesh/ — see features/relay/ and entities/relay/ for reference
- Request validation: Zod safeParse in route handlers, 400 on failure
- Directory picker: see apps/client/src/layers/shared/ui/DirectoryPicker — reuse for manual registration

REFERENCE DOCUMENTS:
- meta/modules/mesh-litepaper.md — "Registration: Intentional Admission" section describes the three approval interfaces
- meta/modules/relay-litepaper.md — Relay architecture that Mesh integrates with

CODEBASE PATTERNS TO STUDY:
- apps/server/src/routes/relay.ts — route factory pattern with Zod validation, cursor pagination
- apps/server/src/services/mcp-tool-server.ts — tool registration with McpToolDeps, Relay tools as reference
- apps/server/src/index.ts — service initialization, feature flags, dependency injection, graceful shutdown
- apps/server/src/services/relay-state.ts — feature flag state pattern
- apps/client/src/layers/features/relay/ — FSD feature module (RelayPanel, ActivityFeed, EndpointList, InboxView)
- apps/client/src/layers/entities/relay/ — entity layer hooks (useRelayEndpoints, useSendRelayMessage, etc.)
- apps/client/src/layers/features/pulse/ — Pulse UI (CreateScheduleDialog for form patterns, ScheduleRow for list items)
- apps/client/src/layers/shared/ui/DirectoryPicker — directory selection component (reuse for manual registration)
- contributing/data-fetching.md — TanStack Query patterns
- contributing/api-reference.md — API documentation patterns

CLIENT UI SCOPE:
The client Mesh panel needs three distinct workflows:
1. Discovery — "Scan" button triggers POST /api/mesh/discover, results shown as candidate cards with strategy badge, approve button, deny button with optional reason
2. Registered agents — list view with agent cards showing name, runtime badge, capabilities tags, description. Expand for detail. Edit and unregister actions.
3. Manual registration — form with DirectoryPicker for path, text inputs for name/description, dropdown for runtime, tag input for capabilities. Submit calls POST /api/mesh/agents with the path.

Consider using tabs (like RelayPanel) to switch between Discovery / Agents / Denied views.

OUT OF SCOPE:
- Changes to the @dorkos/mesh library itself (already built in Spec 1)
- Network topology and ACL configuration UI (Spec 3)
- Topology visualization (Spec 4)
- Lazy activation (Spec 4)
- CLI commands (Spec 4)
```

## Context for Review

This is the integration spec. The /ideate exploration agent should focus on:
- The exact patterns used by Relay for routes, MCP tools, feature flags, and client UI
- The FSD layer structure in `apps/client/` — how features/relay/ and entities/relay/ are organized
- The DirectoryPicker component — how it works and how to reuse it for manual registration
- How Pulse's CreateScheduleDialog handles form input (reference for manual registration form)
- The TanStack Query mutation patterns for actions (register, deny, unregister)

The /ideate research agent should investigate:
- Discovery/approval UI patterns (candidate cards, batch approve, filtering)
- Agent registry dashboard patterns (agent cards, capability badges, status indicators)
- Form design for agent registration (tag inputs for capabilities, runtime selectors)
- REST API design for discovery/registry systems (filtering, pagination, CRUD)
- MCP tool design patterns for discovery and management operations
