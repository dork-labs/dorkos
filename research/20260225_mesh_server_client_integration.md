# Research: Mesh Server/Client Integration Best Practices

**Date**: 2026-02-25
**Feature Slug**: mesh-server-client-integration
**Research Mode**: Deep Research
**Searches Performed**: 12
**Sources Analyzed**: 25+

---

## Research Summary

This report covers six topic areas for integrating an agent discovery/registry library (`@dorkos/mesh`) into the DorkOS Express server and React client. The codebase already has two nearly identical integration precedents — Pulse (scheduler) and Relay (message bus) — that establish the exact patterns to follow. The Relay integration is the most complete and modern reference. Mesh should mirror Relay's architecture with domain-specific adaptations for discovery and approval workflows.

---

## Key Findings

### 1. Discovery/Approval UI Patterns

**Finding**: The approval workflow is the most novel UI challenge — no existing DorkOS panel handles a `discovered -> pending -> registered | denied` state machine.

**Option A: Card-based review (Recommended)**
- Each discovered agent renders as a `CandidateCard` with metadata (name, capabilities, runtime, cwd, discoveredAt)
- Per-row approve/deny buttons with confirmation for deny (destructive)
- Status badge on each card (dot + label: "Discovered", "Registered", "Denied")
- Batch toolbar appears above the list when candidates exist, with "Approve All" and "Deny All" buttons
- Pros: High information density per candidate, familiar to DorkOS `AdapterCard` pattern, easy to extend with metadata
- Cons: Slightly more vertical space than a table row
- Complexity: Low — follows existing `AdapterCard.tsx` shape exactly

**Option B: Table-based review**
- TanStack Table with checkbox column for multi-select and a bulk-action toolbar
- Pros: Maximum density for large lists, better for power users with 20+ candidates
- Cons: Adds TanStack Table dependency to this feature (Roadmap app uses it, client does not currently), overkill for typical discovery result sets (<10 agents per scan)
- Complexity: Medium

**Option C: Inline approval in main registry table**
- Discovered candidates appear in the main registry with pending status badges and inline action buttons
- Pros: Single unified view, no separate "review" step
- Cons: Blurs the distinction between the approval workflow and the ongoing registry, makes it harder to do batch operations
- Complexity: Low but UX is confusing for first-time users

**Recommendation**: Option A. The card approach matches the AdapterCard precedent perfectly and handles the reality that discovery usually returns <10 candidates at a time.

**Batch Operation Design**:
- Show batch toolbar only when there are items in `discovered` or `pending` states
- "Approve All" → optimistic updates, single API call `POST /api/mesh/candidates/batch-approve`
- "Deny All" → requires a confirmation dialog (destructive, bulk)
- Undo is not feasible (deny writes to persistent deny-list); use a confirmation modal instead
- Reference: [SaaS Bulk Actions UI examples](https://saasinterface.com/components/bulk-actions/)

**Status Badge Design** (matching AdapterCard dot pattern):
```
discovered  → yellow dot + "Discovered" badge (outline)
pending     → blue pulsing dot + "Pending" badge (outline)
registered  → green dot + "Registered" badge (secondary)
denied      → gray dot + "Denied" badge (destructive, outline)
error       → red dot + "Error" badge (destructive)
```

**Filtering/Sorting**:
- Filter by status (tabs: All | Pending Review | Registered | Denied)
- Sort by: discoveredAt (default, newest first), name, runtime
- Use tab-based filtering over a dropdown — matches the RelayPanel `Tabs` pattern

---

### 2. Agent Registry Dashboard Patterns

**Finding**: The registry view (registered agents) is a straightforward list-with-detail pattern. DorkOS already has the right primitives.

**Option A: Expandable row cards (Recommended)**
- Each registered agent renders as an `AgentCard` (similar to `ScheduleRow` expand/collapse pattern in PulsePanel)
- Collapsed: name, runtime badge, capability count badge, health dot, enable/disable toggle
- Expanded: full capability list as badge chips, cwd path, description, last-seen timestamp, edit/remove actions
- Pros: Low visual noise in collapsed state; edit-in-place via expansion avoids modal overhead for simple edits; matches PulsePanel `ScheduleRow` pattern precisely
- Cons: Not great for editing multiple agents simultaneously
- Complexity: Low

**Option B: Edit modal**
- Clicking an agent opens a modal form for editing metadata
- Pros: More space for complex forms (many capabilities, long descriptions)
- Cons: Extra interaction step, adds another modal to manage; better reserved for the registration flow
- Complexity: Medium

**Option C: Dedicated detail route**
- Each agent has its own URL (`/mesh/agents/:id`)
- Pros: Deep-linkable, unlimited space
- Cons: DorkOS is a SPA panel, not a multi-page app; route-based navigation is heavy for a side panel
- Complexity: High

**Recommendation**: Option A for the list view. Use a modal (CreateAgentDialog equivalent) for the initial registration form, and expandable rows for quick edits.

**Capability Badges Display**:
- Render capabilities as `Badge` chips in a flex-wrap container
- Max 3 visible in collapsed view, "+ N more" overflow indicator
- In expanded view: full list, grouped by capability category if categories exist
- Runtime environment: colored badge (e.g., "node" = green, "python" = blue, "deno" = purple)

**Health/Status Monitoring**:
- Health dot (colored circle, same STATUS_COLORS pattern as AdapterCard)
- Last-seen timestamp ("2 minutes ago" via relative formatting)
- Do NOT poll health in real-time unless `@dorkos/mesh` provides a health check API; use the registry's `updatedAt` field

---

### 3. Form Design for Registration

**Finding**: The `CreateScheduleDialog.tsx` is the closest precedent for a registration form. Agent registration has more fields but follows the same patterns.

**Tag/Chip Input for Capabilities**:
- shadcn/ui does not ship a chip input natively (open issue #3647)
- Recommended approach: Controlled input with `onKeyDown` that fires on Enter/comma, adds to a Set, renders as Badge chips with an X button
- Alternatively: `cmdk`-based combobox with freeform input — already in the project as the Command primitive
- Do NOT add a new dependency (react-select, downshift) for this
- Pattern:
  ```tsx
  // Input → Enter → push to capabilities[] → render as Badge chips
  <div className="flex flex-wrap gap-1 rounded-md border p-2">
    {capabilities.map((cap) => (
      <Badge key={cap} variant="secondary" className="gap-1">
        {cap}
        <button onClick={() => removeCapability(cap)}><X className="size-3" /></button>
      </Badge>
    ))}
    <input placeholder="Add capability..." onKeyDown={handleCapabilityInput} className="flex-1 outline-none text-sm" />
  </div>
  ```

**Directory/Path Picker**:
- The project already has `DirectoryPicker` in `shared/ui/` — use it directly
- This is a first-class pattern; do not reinvent

**Runtime Selector**:
- Use shadcn `Select` with a list of known runtimes + descriptions
- Include "custom" option that reveals a text input field (progressive disclosure)
- Example options: node, python, deno, bun, custom

**Progressive Disclosure for Advanced Fields**:
- Required fields: name, cwd, runtime
- Advanced (behind "Advanced options" disclosure): description, capabilities, tags, maxConcurrentRuns, healthCheckUrl
- Use `<details>/<summary>` or a shadcn `Collapsible` — the project uses `Collapsible` in the sidebar already

**Form Validation**:
- Use `react-hook-form` + zod resolver — consistent with the rest of the project (CreateScheduleDialog)
- Real-time validation on blur (not on every keystroke) to avoid distracting errors
- Show inline error messages below each field

---

### 4. REST API Design for Discovery/Registry

**Finding**: The Relay router (`routes/relay.ts`) is the direct template. Mesh routes follow identical structure.

**Discovery Endpoints**:
```
POST /api/mesh/scan          — Trigger a scan (async, returns jobId or immediate results)
GET  /api/mesh/candidates    — List discovered candidates (status: discovered | pending | denied)
POST /api/mesh/candidates/:id/approve   — Approve a candidate → becomes registered
POST /api/mesh/candidates/:id/deny      — Deny a candidate → added to deny-list
POST /api/mesh/candidates/batch-approve — Approve all pending candidates
POST /api/mesh/candidates/batch-deny    — Deny all pending candidates
```

**Registry Endpoints**:
```
GET    /api/mesh/agents          — List registered agents (?status=&runtime=&cursor=&limit=)
POST   /api/mesh/agents          — Manually register an agent
GET    /api/mesh/agents/:id      — Get single agent
PATCH  /api/mesh/agents/:id      — Update agent metadata
DELETE /api/mesh/agents/:id      — Remove agent from registry
POST   /api/mesh/agents/:id/enable   — Enable agent
POST   /api/mesh/agents/:id/disable  — Disable agent
GET    /api/mesh/metrics         — Registry metrics
```

**Filtering and Pagination**:
- Query params: `?status=registered&runtime=node&cursor=abc123&limit=20`
- Cursor-based pagination (consistent with Relay's pattern): `{ agents: [...], nextCursor: string | null }`
- Filter by status (comma-separated for multi-select): `?status=registered,denied`
- Default sort: `registeredAt` descending

**Idempotency**:
- `POST /api/mesh/agents` should upsert by `(name + cwd)` composite key — re-registering the same agent is a no-op that returns the existing record
- `POST /api/mesh/candidates/:id/approve` is idempotent: approving an already-registered candidate returns the existing registration
- `POST /api/mesh/candidates/:id/deny` is idempotent: re-denying returns the existing deny record
- Trigger scan (`POST /api/mesh/scan`) is NOT idempotent — prevents running concurrent scans by returning 409 if a scan is in progress

**Discovery Trigger Design** (POST /api/mesh/scan):
- Option A (Synchronous): Scan completes in-request, returns `{ candidates: [...] }` directly
  - Simple, no polling needed, but blocks the request for the scan duration
  - Good for local filesystem scans (<1s typical)
- Option B (Async with SSE): Returns immediately with jobId, SSE stream pushes updates
  - Necessary if scan may take >5s (e.g., network-based discovery)
- Recommendation: Start with Option A (synchronous). Add async + SSE only if scan latency becomes a problem.

**Error Responses** (consistent with existing routes):
```typescript
// Scan in progress
res.status(409).json({ error: 'Scan already in progress', code: 'SCAN_IN_PROGRESS' })
// Agent not found
res.status(404).json({ error: 'Agent not found' })
// Validation failed
res.status(400).json({ error: 'Validation failed', details: result.error.flatten() })
// Discovery error
res.status(422).json({ error: message, code: 'DISCOVERY_FAILED' })
```

---

### 5. MCP Tool Design for Management

**Finding**: The existing MCP tools in `mcp-tool-server.ts` define exactly the right patterns. Mesh tools follow identical structure.

**Tool Naming Conventions** (from existing codebase + MCP official docs):
- Prefix: `mesh_` (analogous to `relay_`, consistent with no-collision requirement)
- snake_case, verb-first: `mesh_scan`, `mesh_list_agents`, `mesh_register_agent`, `mesh_approve_candidate`, `mesh_deny_candidate`, `mesh_get_metrics`

**Proposed Mesh MCP Tools**:
```typescript
mesh_scan           // Trigger discovery scan, return candidates
mesh_list_agents    // List registered agents (optional: status filter)
mesh_register_agent // Manually register an agent
mesh_approve_candidate  // Approve a discovered candidate
mesh_deny_candidate     // Deny a discovered candidate
mesh_get_agent      // Get single agent by ID
mesh_update_agent   // Update agent metadata
mesh_remove_agent   // Remove agent from registry
```

**Argument Schema Pattern** (from `mcp-tool-server.ts` style):
```typescript
tool(
  'mesh_approve_candidate',
  'Approve a discovered candidate agent and register it. The candidate must be in discovered or pending state.',
  {
    candidate_id: z.string().describe('ID of the candidate to approve'),
    note: z.string().optional().describe('Optional approval note recorded in the audit log'),
  },
  createMeshApproveCandidateHandler(deps)
)
```

**Feature Guard Pattern** (from `requirePulse`/`requireRelay`):
```typescript
function requireMesh(deps: McpToolDeps) {
  if (!deps.meshCore) {
    return jsonContent({ error: 'Mesh is not enabled', code: 'MESH_DISABLED' }, true);
  }
  return null;
}
```

**Return Value Design**:
- Always use `jsonContent()` helper (already in `mcp-tool-server.ts`)
- Success: `{ agent: AgentRecord }` or `{ candidates: [...], count: N }`
- Error: `{ error: string, code: 'MESH_SPECIFIC_CODE' }` with `isError: true`
- List operations: always include `count` alongside array

**Error Handling**:
- Use `isError: true` in content block — never throw (LLMs can handle and retry)
- Include machine-readable `code` strings for common errors: `MESH_DISABLED`, `CANDIDATE_NOT_FOUND`, `AGENT_NOT_FOUND`, `SCAN_IN_PROGRESS`, `ALREADY_REGISTERED`

---

### 6. Feature Flag Patterns

**Finding**: DorkOS has a battle-tested, minimal feature flag pattern in `relay-state.ts` and `pulse-state.ts`. Mesh should follow it exactly — no additional dependencies needed.

**Option A: DorkOS native state module (Recommended)**
- Create `services/mesh/mesh-state.ts` with `setMeshEnabled()`/`isMeshEnabled()` — 15 lines, zero dependencies
- Conditional router mounting in `index.ts`: `if (meshEnabled && meshCore) { app.use('/api/mesh', createMeshRouter(meshCore)); setMeshEnabled(true); }`
- MCP tools: conditional tool registration using `deps.meshCore ? [tool(...), ...] : []` — same as `adapterTools` pattern
- Client: `useMeshEnabled` hook reads from `GET /api/config` response, guards panel rendering with the "Mesh is not enabled" empty state
- Pros: Zero new dependencies, perfectly consistent with existing codebase, trivially testable, no circular deps
- Cons: No runtime toggling (requires restart to enable/disable) — acceptable for an optional subsystem

**Option B: Third-party feature flag service (Flagsmith, PostHog, Statsig)**
- Pros: Dynamic toggling without restart, A/B testing, user-level flags
- Cons: External dependency, network call on every request, massive overkill for a server-side optional subsystem, adds secrets management
- Recommendation: Reject for this use case

**Option C: Config-driven with runtime hot-reload**
- Watch `~/.dork/config.json` and toggle Mesh dynamically without restart
- Pros: Better operator experience
- Cons: Significant complexity — route mounting/unmounting in Express at runtime is tricky; need to handle in-flight requests during toggle; not how Pulse or Relay work
- Recommendation: Reject for v1

**Server-Side Conditional Route Mounting** (from `index.ts` precedent):
```typescript
// In index.ts start()
const meshEnabled = process.env.DORKOS_MESH_ENABLED === 'true' || meshConfig?.enabled;

let meshCore: MeshCore | undefined;
if (meshEnabled) {
  meshCore = new MeshCore({ dataDir: path.join(dorkHome, 'mesh') });
  await meshCore.initialize();
  logger.info('[Mesh] MeshCore initialized');
}

// After app = createApp()
if (meshEnabled && meshCore) {
  app.use('/api/mesh', createMeshRouter(meshCore));
  setMeshEnabled(true);
  logger.info('[Mesh] Routes mounted');
}
```

**Client-Side Feature Detection**:
```typescript
// entities/mesh/model/use-mesh-enabled.ts
export function useMeshEnabled(): boolean {
  const transport = useTransport();
  const { data } = useQuery({
    queryKey: ['config'],
    queryFn: () => transport.getConfig(),
  });
  return data?.mesh?.enabled ?? false;
}
```

**Graceful Degradation** (from RelayPanel precedent):
```tsx
if (!meshEnabled) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
      <Network className="size-8 text-muted-foreground/50" />
      <div>
        <p className="font-medium">Mesh is not enabled</p>
        <p className="mt-1 text-sm text-muted-foreground">
          Mesh provides agent discovery and registry. Start DorkOS with mesh enabled.
        </p>
      </div>
      <code className="mt-2 rounded-md bg-muted px-3 py-1.5 font-mono text-sm">
        DORKOS_MESH_ENABLED=true dorkos
      </code>
    </div>
  );
}
```

---

## Detailed Analysis

### Architecture Fit

The DorkOS codebase has a clear three-subsystem pattern (core, Pulse, Relay) and Mesh slots in as a fourth. The server `index.ts` already shows the pattern: initialize the service, conditionally mount routes, set the state flag, inject into MCP tools. On the client, the FSD layer system means:

- `entities/mesh/` — hooks: `useMeshEnabled`, `useMeshAgents`, `useMeshCandidates`, `useScanAgents`, `useApproveCandidate`, `useDenyCandidate`
- `features/mesh/` — UI: `MeshPanel`, `AgentCard`, `CandidateCard`, `RegisterAgentDialog`, `CandidateReviewPanel`

The `MeshPanel` follows `RelayPanel`'s `Tabs` structure:
- Tab 1: "Registry" — list of registered agents (`AgentCard` list)
- Tab 2: "Candidates" — discovery review panel (`CandidateCard` list + batch toolbar)
- Tab 3: "Metrics" — optional metrics display

### FSD Layer Compliance

All Mesh entity hooks must live in `entities/mesh/model/`. The `MeshPanel` and sub-components live in `features/mesh/ui/`. No cross-feature model imports. The `useMeshEnabled` hook is an entity-level hook (reads config), not a feature-level hook. This mirrors `usePulseEnabled` in `entities/pulse/`.

### Service Count Impact

The server currently has 23+ services. Adding Mesh would add:
- `services/mesh/mesh-state.ts` (15 lines, trivial)
- `services/mesh/mesh-service.ts` (if @dorkos/mesh needs a wrapper)

The `server-structure.md` rule suggests domain grouping at 20+ services. The server is already using domain grouping (`services/core/`, `services/pulse/`, `services/relay/`, `services/session/`). Mesh goes in `services/mesh/`.

---

## Security Considerations

1. **Discovery scan scope**: The `POST /api/mesh/scan` endpoint must respect the boundary validation (`lib/boundary.ts`) — filesystem scans must not escape the configured boundary directory. Pass `resolvedBoundary` into `MeshCore` initialization.

2. **Approval workflow integrity**: The approve/deny actions should be human-only operations (not automatically triggered by agents without user approval). The MCP tool `mesh_approve_candidate` should be guarded — or agents should only be able to register candidates into `pending` state, requiring UI approval. Mirror the Pulse `pending_approval` pattern where agent-created entities require human sign-off.

3. **Deny-list persistence**: The deny-list must be persisted to disk (like PulseStore uses SQLite). An in-memory deny-list would be cleared on restart, re-exposing denied agents to the registry.

4. **Capability validation**: If capabilities are user-supplied strings, sanitize before storing (max length, allowed chars). Do not eval capability strings.

5. **Input validation**: All endpoints use Zod `.safeParse()` before processing — consistent with the existing API route rules in `.claude/rules/api.md`.

---

## Performance Considerations

1. **Scan duration**: Local filesystem discovery is fast (<100ms). Network-based discovery (scanning remote hosts) may block the request. For v1, synchronous scan is acceptable. Monitor via metrics.

2. **Registry list performance**: For typical use (<100 agents), cursor-based pagination with `limit=20` is sufficient. No need for a search index.

3. **Health check polling**: Do not poll agent health on every page load. Cache health status in `MeshCore` with a TTL (60s), or rely on periodic server-side health checks triggered by the scheduler (Pulse).

4. **SSE for scan progress**: If scans become long-running, a GET `/api/mesh/stream` SSE endpoint for scan progress follows the exact pattern of `GET /api/relay/stream`. Reuse `initSSEStream` from `stream-adapter.ts`.

5. **MCP tool response size**: `mesh_list_agents` should default to `limit=20` to avoid large payloads in tool responses that the LLM processes inline.

---

## Recommendation with Rationale

### Overall Architecture: Mirror Relay Exactly

Relay is the most complete and modern subsystem in DorkOS. It covers every pattern needed for Mesh:
- State flag module (`relay-state.ts` → `mesh-state.ts`)
- Router factory (`createRelayRouter` → `createMeshRouter`)
- MCP tool handlers with `requireGuard` pattern
- Conditional mounting in `index.ts`
- Client entity hooks (`entities/relay/` → `entities/mesh/`)
- Client feature panel with Tabs (`RelayPanel` → `MeshPanel`)
- Adapter cards for items with status (`AdapterCard` → `AgentCard` / `CandidateCard`)
- Graceful disabled state in panel UI

The key difference is the **approval workflow** — Relay adapters are enabled/disabled, not approved/denied. Mesh adds a `discovered → registered | denied` state machine. Model this after the Pulse `pending_approval` pattern combined with the AdapterCard toggle UI.

### Form Registration: CreateScheduleDialog Pattern

The `CreateScheduleDialog.tsx` is the direct template for `RegisterAgentDialog`. Replace cron/timezone fields with capabilities chip input + runtime selector. Add the `DirectoryPicker` (already available in `shared/ui/`) for cwd selection.

### No Third-Party Dependencies Needed

The entire integration can be built with:
- Existing shadcn primitives (Badge, Switch, Tabs, Select, Dialog, Collapsible, Input)
- Existing shared utilities (cn, TransportContext, DirectoryPicker)
- react-hook-form + zod (already used in CreateScheduleDialog)
- The `@dorkos/mesh` library itself (assumed to be written)

### Caveats

1. If `@dorkos/mesh` exposes a radically different API than `RelayCore` (e.g., event-based instead of method-based), the router factory and MCP handler factories will need adaptation. The patterns above assume a synchronous/async method API.

2. The "Candidates" tab with batch approval is the highest UX risk area — validate with a real discovery result set. If discovery regularly returns >20 candidates, consider adding sorting/filtering controls earlier rather than later.

3. If Mesh needs to know about agents registered via CLI (outside the UI), it must read its state from a persistent store (file or SQLite) rather than in-memory — same constraint as PulseStore. Do not assume the UI is the only writer.

---

## Search Methodology

- Searches performed: 12
- Most productive search terms: "MCP tool naming conventions", "REST API discovery endpoints idempotent upsert", "candidate review UI approve deny batch", "feature flag Express.js conditional route mounting"
- Primary information sources: modelcontextprotocol.info (official docs), Moesif blog (REST API design), SaaS Interface (bulk actions UX), DorkOS codebase (existing patterns — most relevant source of all)
- Codebase files analyzed: relay.ts, relay-state.ts, pulse-state.ts, mcp-tool-server.ts, index.ts, RelayPanel.tsx, PulsePanel.tsx, AdapterCard.tsx

---

## Sources

- [MCP Tools Concepts — modelcontextprotocol.info](https://modelcontextprotocol.info/docs/concepts/tools/)
- [MCP Server Naming Conventions — zazencodes.com](https://zazencodes.com/blog/mcp-server-naming-conventions)
- [15 Best Practices for Building MCP Servers — The New Stack](https://thenewstack.io/15-best-practices-for-building-mcp-servers-in-production/)
- [REST API Design: Filtering, Sorting, and Pagination — Moesif](https://www.moesif.com/blog/technical/api-design/REST-API-Design-Filtering-Sorting-and-Pagination/)
- [Best Practices for REST API Design — Stack Overflow Blog](https://stackoverflow.blog/2020/03/02/best-practices-for-rest-api-design/)
- [RESTful API Design Best Practices Guide — daily.dev](https://daily.dev/blog/restful-api-design-best-practices-guide-2024)
- [Idempotent REST APIs — restfulapi.net](https://restfulapi.net/idempotent-rest-apis/)
- [SaaS Bulk Actions UI Examples — SaaS Interface](https://saasinterface.com/components/bulk-actions/)
- [Feature Flag Routes with Express Middleware — Runnable Blog](https://runnable.com/blog/feature-flag-routes-safely-with-express-middleware)
- [Node.js Feature Flags with Express — Flagsmith](https://www.flagsmith.com/blog/nodejs-feature-flags)
- [Progressive Disclosure in UX Design — LogRocket](https://blog.logrocket.com/ux-design/progressive-disclosure-ux-types-use-cases/)
- [Badges vs Chips vs Tags — Smart Interface Design Patterns](https://smart-interface-design-patterns.com/articles/badges-chips-tags-pills/)
- [shadcn/ui Tag Input Issue #3647](https://github.com/shadcn-ui/ui/issues/3647)
- [AI Agent Registry: A Complete Guide — TrueFoundry](https://www.truefoundry.com/blog/ai-agent-registry)
- [Agent Registry Proposal — A2A Project](https://github.com/a2aproject/A2A/discussions/741)
