---
slug: mesh-network-topology
number: 58
created: 2026-02-25
status: draft
---

# Specification: Mesh Network Topology

**Status:** Draft
**Authors:** Claude Code, 2026-02-25
**Ideation:** [01-ideation.md](./01-ideation.md)
**Plan:** [03-mesh-network-topology.md](../../docs/plans/mesh-specs/03-mesh-network-topology.md)

---

## Overview

Add network topology and access control to `@dorkos/mesh` so agents are isolated by project namespace. Same-project agents communicate freely through Relay (default-allow). Cross-project agents are blocked by default (default-deny) unless explicitly allowlisted. Per-agent budget constraints from the agent manifest are enforced by Relay at delivery time. Agents only see other agents they are authorized to reach (invisible boundaries).

Mesh is the **policy author** — it derives namespaces, computes rules, and writes them. Relay is the **policy engine** — it evaluates rules and enforces budgets on every message delivery. This separation is already established by Specs 1 and 2; Spec 3 connects them.

## Background / Problem Statement

Specs 1 and 2 established agent discovery, registration, and basic Relay endpoint creation. However:

1. **No namespace isolation** — All registered agents share a flat address space. An agent in project A can message any agent in project B without restriction.
2. **No access control rules** — `RelayBridge.registerAgent()` creates the endpoint but never calls `AccessControl.addRule()`. The Relay default policy is allow-all, so every message passes.
3. **No budget enforcement** — The `AgentManifest.budget` fields (`maxHopsPerMessage`, `maxCallsPerHour`) are stored but never mapped to Relay's `BudgetEnforcer` constraints.
4. **No visibility filtering** — `MeshCore.list()` returns all agents regardless of who is asking, enabling cross-project enumeration.

Without this spec, autonomous agents can freely message, overload, and enumerate agents across project boundaries — violating the litepaper's core safety guarantee.

## Goals

- Derive a project namespace for each agent from filesystem position (with manifest override)
- Write default-allow same-namespace and default-deny cross-namespace Relay access rules at registration time
- Provide explicit cross-project allowlisting via HTTP API, MCP tools, and client UI
- Map agent manifest budget fields to Relay budget constraints enforced at delivery
- Filter `MeshCore.list()` and `mesh_list` results by caller namespace (invisible boundaries)
- Add `mesh_query_topology` MCP tool for agents to query their visible network
- Add topology HTTP routes for configuration
- Add client UI for namespace visualization and ACL management
- Ensure ACL changes take effect immediately without restart (leverages Relay's hot-reload)

## Non-Goals

- Console topology visualization / network graph (Spec 4)
- Lazy activation of agents (Spec 4)
- Supervision policies (Spec 4)
- CLI commands for topology management (Spec 4)
- Dynamic namespace reconfiguration (agents changing projects at runtime)
- Project-level aggregate budget caps (future spec)
- Hierarchical namespace nesting (flat namespace model for now)

## Technical Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `better-sqlite3` | existing | Budget counter table, namespace column migration |
| `@dorkos/relay` | workspace | AccessControl, BudgetEnforcer, subject-matcher |
| `@dorkos/shared` | workspace | New Zod schemas for topology types |
| `chokidar` | existing | AccessControl hot-reload (already in Relay) |

No new external packages required.

## Detailed Design

### 1. Namespace Resolver (`packages/mesh/src/namespace-resolver.ts`)

New module. Pure functions, no side effects.

**Derivation algorithm:**
1. Accept `(projectPath, scanRoot, manifestNamespace?)`
2. If `manifestNamespace` is provided and non-empty, use it as the namespace
3. Otherwise, compute `path.relative(scanRoot, projectPath)` and take the first path segment
4. Normalize: lowercase, replace non-alphanumeric chars with hyphens, trim leading/trailing hyphens
5. Validate: non-empty, max 64 chars

```typescript
// Example derivations:
// scanRoot: ~/projects, path: ~/projects/dorkos/core → "dorkos"
// scanRoot: ~/projects, path: ~/projects/team-a/backend → "team-a"
// scanRoot: ~/work, path: ~/work/my-agent → "my-agent"
// manifestNamespace: "custom-ns" → "custom-ns" (override)
```

**Exported API:**

```typescript
export function resolveNamespace(
  projectPath: string,
  scanRoot: string,
  manifestNamespace?: string,
): string;

export function normalizeNamespace(raw: string): string;

export function validateNamespace(ns: string): { valid: true } | { valid: false; reason: string };
```

### 2. Agent Registry Schema Migration (`packages/mesh/src/agent-registry.ts`)

Add migration version 2 to the existing `MIGRATIONS` array:

```sql
-- Version 2: namespace support
ALTER TABLE agents ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN scan_root TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_agents_namespace ON agents(namespace);
```

Update `AgentRegistryEntry` interface to include `namespace` and `scanRoot`.

Update `insert()` to accept and persist the new columns.

Add `listByNamespace(namespace: string)` method for fast lookup.

Update `AgentRow` interface and `rowToEntry()` mapping.

### 3. Relay Access Rule Authoring

#### 3.1. Expose AccessControl on RelayCore (`packages/relay/src/relay-core.ts`)

RelayCore's `accessControl` is currently private. Add three public delegate methods:

```typescript
/** Add an access rule. Persists immediately and hot-reloads. */
addAccessRule(rule: RelayAccessRule): void {
  this.accessControl.addRule(rule);
}

/** Remove the first rule matching the given from/to patterns. */
removeAccessRule(from: string, to: string): void {
  this.accessControl.removeRule(from, to);
}

/** List all current access rules. */
listAccessRules(): RelayAccessRule[] {
  return this.accessControl.listRules();
}
```

This is a minimal, non-breaking addition to the Relay public API.

#### 3.2. Extend RelayBridge (`packages/mesh/src/relay-bridge.ts`)

Extend `registerAgent()` to also write access rules after creating the endpoint:

```typescript
async registerAgent(
  agent: AgentManifest,
  projectPath: string,
  namespace: string,
  scanRoot: string,
): Promise<string | null> {
  if (!this.relayCore) return null;

  const subject = `relay.agent.${namespace}.${agent.id}`;
  await this.relayCore.registerEndpoint(subject);

  // Write default same-namespace allow rule (idempotent — deduped by addRule)
  this.relayCore.addAccessRule({
    from: `relay.agent.${namespace}.*`,
    to: `relay.agent.${namespace}.*`,
    action: 'allow',
    priority: 100,
  });

  // Write default cross-namespace deny rule (catch-all, lower priority)
  this.relayCore.addAccessRule({
    from: `relay.agent.${namespace}.*`,
    to: 'relay.agent.>',
    action: 'deny',
    priority: 10,
  });

  return subject;
}
```

The same-namespace allow rule (priority 100) takes precedence over the cross-namespace deny rule (priority 10). The deny rule blocks messages from this namespace to any other namespace. Together they create: same-project = allow, cross-project = deny.

Note: The deny rule uses `relay.agent.>` (wildcard for "any agent subject") so it blocks all cross-namespace traffic. The allow rule for the specific namespace at higher priority carves out the exception.

Extend `unregisterAgent()` to also clean up access rules when the last agent in a namespace is removed.

#### 3.3. Budget Mapping

When registering, map manifest budget to Relay endpoint budget:

- `agent.budget.maxHopsPerMessage` → Used as `maxHops` in the Relay budget when messages are published *from* this agent
- `agent.budget.maxCallsPerHour` → Tracked via a `budget_counters` SQLite table using 1-minute time buckets (ADR 0014 sliding window algorithm)

**Budget counter schema** (added to `mesh.db` as migration version 3):

```sql
CREATE TABLE IF NOT EXISTS budget_counters (
  agent_id TEXT NOT NULL,
  bucket_minute INTEGER NOT NULL,
  call_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (agent_id, bucket_minute)
);
CREATE INDEX IF NOT EXISTS idx_budget_counters_agent ON budget_counters(agent_id);
```

**Enforcement point:** Before Relay publishes a message from an agent, Mesh checks the sliding window. This is done in the `RelayBridge` by adding a `checkBudget(agentId)` method that sums `call_count` for the last 60 1-minute buckets. If the sum exceeds `maxCallsPerHour`, the publish is rejected.

**Pruning:** Buckets older than 2 hours are pruned on each check (same approach as ADR 0014).

### 4. Topology Manager (`packages/mesh/src/topology.ts`)

New module that composes namespace-resolver, registry, and relay-bridge for topology queries.

```typescript
export interface TopologyView {
  callerNamespace: string;
  namespaces: NamespaceInfo[];
  accessRules: CrossNamespaceRule[];
}

export interface NamespaceInfo {
  namespace: string;
  agentCount: number;
  agents: AgentManifest[];
}

export interface CrossNamespaceRule {
  sourceNamespace: string;
  targetNamespace: string;
  action: 'allow' | 'deny';
}
```

**Key methods:**

```typescript
export class TopologyManager {
  constructor(
    private registry: AgentRegistry,
    private relayBridge: RelayBridge,
    private relayCore?: RelayCore,
  ) {}

  /** Get the topology view filtered by caller's namespace access. */
  getTopology(callerNamespace: string): TopologyView;

  /** Get which agents a specific agent can reach. */
  getAgentAccess(agentId: string): AgentManifest[];

  /** Add a cross-namespace allow rule. */
  allowCrossNamespace(source: string, target: string): void;

  /** Remove a cross-namespace allow rule (reverts to default-deny). */
  denyCrossNamespace(source: string, target: string): void;

  /** List all cross-namespace rules. */
  listCrossNamespaceRules(): CrossNamespaceRule[];
}
```

**Invisible boundary enforcement:** `getTopology()` only returns namespaces that the caller has an allow rule for (either same-namespace or explicit cross-namespace allow). Namespaces without access are omitted entirely — the caller never sees they exist.

### 5. MeshCore Integration (`packages/mesh/src/mesh-core.ts`)

Extend MeshCore to compose the new modules:

**Constructor changes:**
- Accept optional `scanRoots` in `MeshOptions` for namespace derivation context
- Create `TopologyManager` instance
- Store default scan root for registration

**Method changes:**

- `register()` and `registerByPath()` — Accept `scanRoot` parameter, call `resolveNamespace()`, pass namespace to `AgentRegistry.insert()` and `RelayBridge.registerAgent()`
- `list(filters?, callerNamespace?)` — When `callerNamespace` is provided, filter results to only show agents in accessible namespaces (invisible boundary)
- `unregister()` — Clean up access rules when last agent in namespace removed

**New methods:**

```typescript
/** Get topology view for a namespace. */
getTopology(callerNamespace: string): TopologyView;

/** Get which agents a specific agent can reach. */
getAgentAccess(agentId: string): AgentManifest[];

/** Add cross-namespace allow rule. */
allowCrossNamespace(source: string, target: string): void;

/** Remove cross-namespace allow rule. */
denyCrossNamespace(source: string, target: string): void;

/** List all cross-namespace rules. */
listCrossNamespaceRules(): CrossNamespaceRule[];
```

### 6. Zod Schema Updates (`packages/shared/src/mesh-schemas.ts`)

Add new schemas:

```typescript
// Namespace field on agent manifest (optional, for override)
// Add to AgentManifestSchema:
namespace: z.string().max(64).optional(),

// Topology response
export const NamespaceInfoSchema = z.object({
  namespace: z.string(),
  agentCount: z.number().int(),
  agents: z.array(AgentManifestSchema),
}).openapi('NamespaceInfo');

export const CrossNamespaceRuleSchema = z.object({
  sourceNamespace: z.string(),
  targetNamespace: z.string(),
  action: z.enum(['allow', 'deny']),
}).openapi('CrossNamespaceRule');

export const TopologyViewSchema = z.object({
  callerNamespace: z.string(),
  namespaces: z.array(NamespaceInfoSchema),
  accessRules: z.array(CrossNamespaceRuleSchema),
}).openapi('TopologyView');

// HTTP request schemas
export const UpdateAccessRuleRequestSchema = z.object({
  sourceNamespace: z.string().min(1),
  targetNamespace: z.string().min(1),
  action: z.enum(['allow', 'deny']),
}).openapi('UpdateAccessRuleRequest');

// Extend AgentListQuery with callerNamespace
export const AgentListQuerySchema = z.object({
  runtime: AgentRuntimeSchema.optional(),
  capability: z.string().optional(),
  callerNamespace: z.string().optional(),
}).openapi('AgentListQuery');
```

### 7. HTTP Routes (`apps/server/src/routes/mesh.ts`)

Add three new endpoints to the existing mesh router:

```typescript
// GET /topology — Network topology (filtered by caller namespace)
router.get('/topology', (req, res) => {
  const callerNamespace = req.query.namespace as string | undefined;
  if (!callerNamespace) {
    // Without namespace, return full topology (admin view)
    return res.json(meshCore.getTopology('*'));
  }
  return res.json(meshCore.getTopology(callerNamespace));
});

// PUT /topology/access — Update cross-namespace access rule
router.put('/topology/access', (req, res) => {
  const result = UpdateAccessRuleRequestSchema.safeParse(req.body);
  if (!result.success) {
    return res.status(400).json({ error: 'Validation failed', details: result.error.flatten() });
  }
  const { sourceNamespace, targetNamespace, action } = result.data;
  if (action === 'allow') {
    meshCore.allowCrossNamespace(sourceNamespace, targetNamespace);
  } else {
    meshCore.denyCrossNamespace(sourceNamespace, targetNamespace);
  }
  return res.json({ success: true });
});

// GET /agents/:id/access — Which agents this agent can reach
router.get('/agents/:id/access', (req, res) => {
  const reachable = meshCore.getAgentAccess(req.params.id);
  if (!reachable) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  return res.json({ agents: reachable });
});
```

Update existing `GET /agents` to pass `callerNamespace` query param through to `meshCore.list()`.

### 8. MCP Tool (`apps/server/src/services/core/mcp-tool-server.ts`)

Add `mesh_query_topology` tool:

```typescript
tool('mesh_query_topology', {
  description: 'Query the agent network topology visible to a given namespace',
  parameters: z.object({
    namespace: z.string().optional().describe('Caller namespace (omit for full admin view)'),
  }),
  handler: createMeshQueryTopologyHandler(deps),
});
```

Handler calls `meshCore.getTopology(namespace ?? '*')` and returns the filtered view.

Also update `mesh_list` to accept optional `callerNamespace` parameter for invisible boundary filtering.

### 9. Client UI

#### 9.1. New Entity Hooks (`apps/client/src/layers/entities/mesh/model/`)

**`use-mesh-topology.ts`:**
```typescript
export function useTopology(namespace?: string) {
  return useQuery({
    queryKey: ['mesh', 'topology', namespace],
    queryFn: () => transport.get(`/api/mesh/topology${namespace ? `?namespace=${namespace}` : ''}`),
  });
}
```

**`use-mesh-access.ts`:**
```typescript
export function useUpdateAccessRule() {
  return useMutation({
    mutationFn: (rule: { sourceNamespace: string; targetNamespace: string; action: 'allow' | 'deny' }) =>
      transport.put('/api/mesh/topology/access', rule),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['mesh', 'topology'] }),
  });
}

export function useAgentAccess(agentId: string) {
  return useQuery({
    queryKey: ['mesh', 'agents', agentId, 'access'],
    queryFn: () => transport.get(`/api/mesh/agents/${agentId}/access`),
    enabled: !!agentId,
  });
}
```

#### 9.2. TopologyPanel (`apps/client/src/layers/features/mesh/ui/TopologyPanel.tsx`)

New component added as a fourth tab in MeshPanel ("Topology").

**Layout:**
- **Namespace Groups** — Agents grouped by namespace, each group collapsible
- **Cross-Project Rules** — Table of current access rules with add/remove buttons
- **Per-Agent Budget** — Shows each agent's budget constraints (maxHops, callsPerHour)

**Interactions:**
- Toggle cross-namespace access via a rule editor (source namespace dropdown, target namespace dropdown, allow/deny toggle)
- View per-agent budget from manifest (read-only display, editing is via agent update)

#### 9.3. MeshPanel Tab Addition

Add "Topology" as the fourth tab in MeshPanel.tsx, using the existing Tabs pattern from the three current tabs.

### 10. Mesh Package Exports (`packages/mesh/src/index.ts`)

Add exports for new modules:

```typescript
export { resolveNamespace, normalizeNamespace, validateNamespace } from './namespace-resolver.js';
export { TopologyManager } from './topology.js';
export type { TopologyView, NamespaceInfo, CrossNamespaceRule } from './topology.js';
```

## User Experience

### Agent Registration Flow (Updated)

1. User scans directories via Discovery tab or `mesh_discover` MCP tool
2. Candidates appear with detected runtime and suggested name
3. User approves a candidate → Mesh registers the agent:
   - Namespace derived from scan root + project path
   - Relay endpoint created at `relay.agent.{namespace}.{agentId}`
   - Same-namespace allow rule written (priority 100)
   - Cross-namespace deny rule written (priority 10)
   - Budget constraints mapped from manifest
4. Agent immediately appears in its namespace group in Topology tab

### Cross-Project Access Configuration

1. User navigates to Topology tab in Mesh panel
2. Sees agents grouped by namespace
3. To allow cross-project communication:
   - Clicks "Add Rule" in the cross-project rules section
   - Selects source namespace, target namespace, action (allow)
   - Rule takes effect immediately (Relay hot-reloads)
4. To revoke: removes the rule, communication is blocked again

### Agent Perspective (MCP Tools)

1. Agent calls `mesh_query_topology` → sees only agents in accessible namespaces
2. Agent calls `mesh_list` → same invisible boundary filtering
3. Agent sends message to cross-project agent → rejected if no allow rule exists
4. Agent's budget is enforced: exceeding `maxCallsPerHour` blocks further messages

## Testing Strategy

### Unit Tests

**`packages/mesh/src/__tests__/namespace-resolver.test.ts`** (NEW)
- Derives namespace from scan root and project path correctly
- Uses manifest override when provided
- Normalizes special characters to hyphens
- Rejects empty or overly long namespaces
- Handles edge cases: trailing slashes, same-level paths, deeply nested paths

**`packages/mesh/src/__tests__/topology.test.ts`** (NEW)
- Returns only visible namespaces for a given caller
- Invisible boundary: omits namespaces without access (not 403, just absent)
- Lists cross-namespace rules correctly
- `allowCrossNamespace()` makes previously hidden agents visible
- `denyCrossNamespace()` hides previously visible agents
- Admin view (`*`) returns all namespaces

**`packages/mesh/src/__tests__/budget-mapper.test.ts`** (NEW)
- Maps maxHopsPerMessage to Relay maxHops
- Tracks call counts in sliding window
- Rejects when maxCallsPerHour exceeded
- Prunes old buckets correctly
- Handles concurrent calls within same minute bucket

**`packages/mesh/src/__tests__/mesh-core.test.ts`** (MODIFY)
- Registration stores namespace and scan_root
- list() with callerNamespace filters by access
- unregister() cleans up access rules when last agent in namespace
- register() writes correct Relay access rules

### Integration Tests

**`packages/mesh/src/__tests__/relay-integration.test.ts`** (NEW)
- Register two agents in same namespace → messages flow
- Register two agents in different namespaces → messages blocked
- Add cross-namespace allow rule → messages flow
- Remove cross-namespace allow rule → messages blocked again
- Budget enforcement: agent exceeding maxCallsPerHour gets rejected

### Server Tests

**`apps/server/src/routes/__tests__/mesh-topology.test.ts`** (NEW)
- GET /topology returns namespace-grouped agents
- GET /topology?namespace=X returns filtered view
- PUT /topology/access validates request body
- PUT /topology/access with action=allow creates rule
- PUT /topology/access with action=deny removes rule
- GET /agents/:id/access returns reachable agents
- GET /agents with callerNamespace filters results

**`apps/server/src/services/core/__tests__/mcp-mesh-tools.test.ts`** (MODIFY)
- mesh_query_topology returns filtered topology
- mesh_list with callerNamespace respects invisible boundaries

### Client Tests

**`apps/client/src/layers/features/mesh/ui/__tests__/TopologyPanel.test.tsx`** (NEW)
- Renders namespace groups with agent counts
- Renders cross-namespace rule table
- Add rule form submits correct payload
- Remove rule button calls mutation
- Disabled state when mesh is disabled

## Performance Considerations

- **Namespace lookup:** Cached in AgentRegistry row — no re-computation on each query
- **ACL rule evaluation:** Relay's `checkAccess()` iterates sorted rules — O(n) where n is rule count. With namespace-scoped rules, n stays small (2 rules per namespace + cross-namespace overrides)
- **Budget counter writes:** One SQLite write per message dispatch. WAL mode handles concurrent writes efficiently. Old buckets pruned lazily.
- **Invisible boundary filtering:** One namespace-access check per unique namespace in the result set. With an index on `namespace` column, this is O(log n) per namespace.

## Security Considerations

- **Invisible boundaries (OWASP BOLA):** Unauthorized agents receive empty results, not 403 errors. This prevents cross-namespace enumeration.
- **Namespace spoofing prevention:** Namespace is derived from filesystem position and confirmed at registration. Manifest override is advisory but the scan root anchors the derivation.
- **Any principal can author ACL rules:** Per user decision, both human and agent principals can create/modify access rules directly. This enables fully autonomous agent networks but means a compromised agent could open cross-project access. This is an acceptable trade-off for the current single-user context.
- **Budget enforcement at Relay level:** Even if Mesh's budget check is bypassed, Relay's `BudgetEnforcer` still enforces `maxHops` and `callBudgetRemaining` on every delivery.
- **Default-deny cross-namespace:** New namespaces are isolated by default. Access must be explicitly granted.

## Documentation

- Update `contributing/architecture.md` with Mesh topology section
- Add topology API endpoints to the OpenAPI spec (auto-generated from Zod schemas)
- Update `CLAUDE.md` to document new topology routes, MCP tool, and UI tab

## Implementation Phases

### Phase 1: Core Policy Layer

- `namespace-resolver.ts` — Namespace derivation with tests
- `agent-registry.ts` migration — Add namespace/scan_root columns
- `relay-core.ts` — Expose `addAccessRule()`, `removeAccessRule()`, `listAccessRules()` public methods
- `relay-bridge.ts` — Write access rules on registration
- `mesh-core.ts` — Pass namespace through registration flow
- Update `mesh-schemas.ts` with namespace field
- All unit tests for Phase 1

### Phase 2: Topology & Budget

- `topology.ts` — TopologyManager with invisible boundary filtering
- Budget counter table and sliding window enforcement
- MeshCore topology query methods
- Integration tests for access control + budget enforcement

### Phase 3: HTTP API & MCP

- Topology HTTP routes (GET /topology, PUT /topology/access, GET /agents/:id/access)
- `mesh_query_topology` MCP tool
- Update `mesh_list` with callerNamespace filtering
- Server route tests

### Phase 4: Client UI

- `use-mesh-topology.ts` and `use-mesh-access.ts` hooks
- `TopologyPanel.tsx` component
- MeshPanel fourth tab integration
- Client component tests

## Open Questions

*No open questions — all key decisions were resolved during ideation (see Section 6 of 01-ideation.md).*

## Related ADRs

- **ADR 0011** — NATS-style subject matching: Reused for ACL rule patterns (`relay.agent.{namespace}.*`)
- **ADR 0014** — Sliding window log for rate limiting: Algorithm reused for `maxCallsPerHour` budget counter
- **ADR 0016** — Structured PublishResult rejections: Budget and ACL violations use this rejection format

## References

- [Mesh Litepaper](../../meta/modules/mesh-litepaper.md) — "Network Topology and Access Control" section
- [Relay Litepaper](../../meta/modules/relay-litepaper.md) — Budget envelopes, access control
- [Spec 3 Plan](../../docs/plans/mesh-specs/03-mesh-network-topology.md) — Original plan with verification criteria
- [Research](../../research/20260225_mesh_network_topology.md) — Kubernetes, Istio, NATS, OWASP research
- [Relay AccessControl](../../packages/relay/src/access-control.ts) — Policy engine implementation
- [Relay BudgetEnforcer](../../packages/relay/src/budget-enforcer.ts) — Budget enforcement
