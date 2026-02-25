---
slug: mesh-observability-lifecycle
number: 59
created: 2026-02-25
status: specified
---

# Specification: Mesh Observability & Lifecycle Events

**Status:** Draft
**Authors:** Claude Code, 2026-02-25
**Spec:** 59
**Ideation:** [01-ideation.md](./01-ideation.md)

---

## Overview

Add observability and diagnostic tooling to @dorkos/mesh: topology visualization via React Flow, agent health tracking via computed 3-state model, lifecycle events via Relay signals, and diagnostic MCP tools + HTTP routes. This makes the agent mesh visible and inspectable — operators can see who's registered, who's active, and who's idle at a glance.

Builds on the Mesh core library (Spec 1, `370cabd`) and server/client integration (Spec 2, `60c4879`). Works with or without Spec 3 (Network Topology ACLs).

## Background / Problem Statement

The Mesh subsystem can discover, register, and manage agents — but there's no way to see the mesh at a glance. Operators have no visibility into:

- Which agents are actively communicating vs idle
- The overall health of the agent network
- When agents register, unregister, or change state
- Aggregate statistics (how many agents, by runtime, by project)

Without observability, the mesh is a black box. Debugging agent communication issues requires manual inspection of individual agents. There's no dashboard, no health indicators, no lifecycle event stream.

## Goals

- Topology visualization: network graph showing agents as nodes with health status indicators
- Agent health tracking: computed from Relay message activity (active/inactive/stale)
- Lifecycle events: emitted as Relay signals, streamed to clients via SSE
- Diagnostic MCP tools: `mesh_status` and `mesh_inspect` for agent-driven inspection
- HTTP routes: `GET /api/mesh/status` and `GET /api/mesh/agents/:id/health`
- Aggregate stats dashboard: total agents, by runtime, by health status

## Non-Goals

- Network topology ACL rules (Spec 3 — additive if present)
- Agent activation / session management (Relay runtime adapters)
- Supervision / restart policies (Relay runtime adapters)
- CLI commands (MCP tools + HTTP routes sufficient for now)
- Multi-machine mesh (DorkOS is single-machine)
- Agent versioning or rollback
- Configurable health thresholds (hardcode now, configurable later)
- Force-directed or ELK graph layouts (dagre only for v1)

## Technical Dependencies

| Dependency | Version | Purpose | Install Location |
|---|---|---|---|
| `@xyflow/react` | ^12 | Network graph visualization | `apps/client` |
| `dagre` | ^0.8 | Deterministic graph layout (LTR) | `apps/client` |
| `@types/dagre` | ^0.7 | TypeScript types for dagre | `apps/client` (devDep) |
| `better-sqlite3` | (existing) | Health column storage | `packages/mesh` |
| `@dorkos/relay` | (existing) | SignalEmitter for lifecycle events | `packages/mesh` |

React Flow v12 (`@xyflow/react`) has confirmed React 19 + Tailwind CSS 4 compatibility. Custom nodes are plain React components — shadcn Badge and status indicators embed directly. First-party dagre layout adapter with copy-paste examples.

## Detailed Design

### 1. Schema Migration — Agent Health Columns

Extend the existing `agents` table in `packages/mesh/src/agent-registry.ts` with a version 2 migration:

```sql
-- Migration v2: Add health tracking columns
ALTER TABLE agents ADD COLUMN last_seen_at TEXT;
ALTER TABLE agents ADD COLUMN last_seen_event TEXT;
```

Health status is **computed at query time** via SQL, not stored:

```sql
SELECT *,
  CASE
    WHEN last_seen_at IS NULL THEN 'stale'
    WHEN (julianday('now') - julianday(last_seen_at)) * 86400 < 300 THEN 'active'
    WHEN (julianday('now') - julianday(last_seen_at)) * 86400 < 1800 THEN 'inactive'
    ELSE 'stale'
  END AS health_status
FROM agents
WHERE id = ?
```

Thresholds: Active < 5 min, Inactive 5-30 min, Stale > 30 min (or never seen).

**New prepared statements to add to AgentRegistry:**

```typescript
// Update last-seen timestamp
updateHealth: db.prepare(
  `UPDATE agents SET last_seen_at = ?, last_seen_event = ? WHERE id = ?`
),

// Get single agent with computed health
getWithHealth: db.prepare(`
  SELECT *, CASE
    WHEN last_seen_at IS NULL THEN 'stale'
    WHEN (julianday('now') - julianday(last_seen_at)) * 86400 < 300 THEN 'active'
    WHEN (julianday('now') - julianday(last_seen_at)) * 86400 < 1800 THEN 'inactive'
    ELSE 'stale'
  END AS health_status
  FROM agents WHERE id = ?
`),

// List all agents with computed health
listWithHealth: db.prepare(`
  SELECT *, CASE
    WHEN last_seen_at IS NULL THEN 'stale'
    WHEN (julianday('now') - julianday(last_seen_at)) * 86400 < 300 THEN 'active'
    WHEN (julianday('now') - julianday(last_seen_at)) * 86400 < 1800 THEN 'inactive'
    ELSE 'stale'
  END AS health_status
  FROM agents ORDER BY registered_at DESC
`),

// Aggregate stats
getAggregateStats: db.prepare(`
  SELECT
    COUNT(*) AS total_agents,
    SUM(CASE WHEN last_seen_at IS NOT NULL AND (julianday('now') - julianday(last_seen_at)) * 86400 < 300 THEN 1 ELSE 0 END) AS active_count,
    SUM(CASE WHEN last_seen_at IS NOT NULL AND (julianday('now') - julianday(last_seen_at)) * 86400 BETWEEN 300 AND 1800 THEN 1 ELSE 0 END) AS inactive_count,
    SUM(CASE WHEN last_seen_at IS NULL OR (julianday('now') - julianday(last_seen_at)) * 86400 > 1800 THEN 1 ELSE 0 END) AS stale_count
  FROM agents
`)
```

**New AgentRegistry methods:**

| Method | Signature | Purpose |
|---|---|---|
| `updateHealth()` | `updateHealth(id: string, lastSeenAt: string, lastSeenEvent: string): boolean` | Update last-seen timestamp |
| `getWithHealth()` | `getWithHealth(id: string): AgentHealthEntry \| undefined` | Single agent + computed status |
| `listWithHealth()` | `listWithHealth(filters?: AgentListFilters): AgentHealthEntry[]` | All agents + computed status |
| `getAggregateStats()` | `getAggregateStats(): AggregateStats` | Counts by health status |

**New types:**

```typescript
interface AgentHealthEntry extends AgentRegistryEntry {
  lastSeenAt: string | null;
  lastSeenEvent: string | null;
  healthStatus: 'active' | 'inactive' | 'stale';
}

interface AggregateStats {
  totalAgents: number;
  activeCount: number;
  inactiveCount: number;
  staleCount: number;
}
```

### 2. MeshCore Health Methods

Add to `packages/mesh/src/mesh-core.ts`:

| Method | Signature | Purpose |
|---|---|---|
| `updateLastSeen()` | `updateLastSeen(agentId: string, event: string): void` | Update health timestamp |
| `getAgentHealth()` | `getAgentHealth(agentId: string): AgentHealth \| undefined` | Get agent + health + relay subject |
| `getStatus()` | `getStatus(): MeshStatus` | Aggregate stats + metadata |
| `inspect()` | `inspect(agentId: string): MeshInspect \| undefined` | Full agent detail for diagnostics |

`getStatus()` returns:

```typescript
{
  totalAgents: number;
  activeCount: number;
  inactiveCount: number;
  staleCount: number;
  byRuntime: Record<string, number>;   // Computed from listWithHealth()
  byProject: Record<string, number>;   // Computed from projectPath basenames
}
```

`inspect()` returns:

```typescript
{
  agent: AgentManifest;
  health: AgentHealth;
  relaySubject: string | null;  // From RelayBridge subject cache
}
```

### 3. Lifecycle Signal Emission

Extend `packages/mesh/src/relay-bridge.ts` to accept a `SignalEmitter` and emit lifecycle signals:

```typescript
export class RelayBridge {
  constructor(
    private readonly relayCore?: RelayCore,
    private readonly signalEmitter?: SignalEmitter,  // NEW
  ) {}

  async registerAgent(agent: AgentManifest, projectPath: string): Promise<string | null> {
    // ... existing relay endpoint registration ...

    // NEW: Emit lifecycle signal
    this.signalEmitter?.emit('mesh.agent.lifecycle.registered', {
      agentId: agent.id,
      agentName: agent.name,
      event: 'registered',
      timestamp: new Date().toISOString(),
    });

    return subject;
  }

  async unregisterAgent(subject: string, agent?: AgentManifest): Promise<void> {
    // ... existing relay endpoint unregistration ...

    // NEW: Emit lifecycle signal
    if (agent) {
      this.signalEmitter?.emit('mesh.agent.lifecycle.unregistered', {
        agentId: agent.id,
        agentName: agent.name,
        event: 'unregistered',
        timestamp: new Date().toISOString(),
      });
    }
  }
}
```

**Health change signals** are emitted from `MeshCore.updateLastSeen()` when a status transition occurs:

```typescript
updateLastSeen(agentId: string, event: string): void {
  const before = this.registry.getWithHealth(agentId);
  this.registry.updateHealth(agentId, new Date().toISOString(), event);
  const after = this.registry.getWithHealth(agentId);

  if (before && after && before.healthStatus !== after.healthStatus) {
    this.relayBridge.emitHealthChanged(agentId, after.name, before.healthStatus, after.healthStatus);
  }
}
```

**Signal subjects:**

| Subject | Payload | When |
|---|---|---|
| `mesh.agent.lifecycle.registered` | `{ agentId, agentName, event: 'registered', timestamp }` | Agent registered |
| `mesh.agent.lifecycle.unregistered` | `{ agentId, agentName, event: 'unregistered', timestamp }` | Agent unregistered |
| `mesh.agent.lifecycle.health_changed` | `{ agentId, agentName, event: 'health_changed', previousStatus, currentStatus, timestamp }` | Status transition |

### 4. MeshCore Constructor Changes

Pass `SignalEmitter` from RelayCore through to RelayBridge:

```typescript
// In MeshCore constructor
const signalEmitter = options.relayCore
  ? (options.relayCore as any).signalEmitter  // Access from RelayCore
  : undefined;

this.relayBridge = new RelayBridge(options.relayCore, signalEmitter);
```

If RelayCore doesn't expose `signalEmitter` directly, pass it as an explicit option:

```typescript
interface MeshOptions {
  dataDir?: string;
  relayCore?: RelayCore;
  signalEmitter?: SignalEmitter;  // NEW
  strategies?: DiscoveryStrategy[];
}
```

Then in `apps/server/src/index.ts`:

```typescript
meshCore = new MeshCore({
  dataDir: path.join(dorkHome, 'mesh'),
  relayCore,
  signalEmitter: relayCore?.signalEmitter,  // Pass through
});
```

### 5. Shared Schemas

Add to `packages/shared/src/mesh-schemas.ts`:

```typescript
// Health status enum
export const AgentHealthStatusSchema = z.enum(['active', 'inactive', 'stale']);
export type AgentHealthStatus = z.infer<typeof AgentHealthStatusSchema>;

// Agent health detail
export const AgentHealthSchema = z.object({
  agentId: z.string(),
  name: z.string(),
  status: AgentHealthStatusSchema,
  lastSeenAt: z.string().nullable(),
  lastSeenEvent: z.string().nullable(),
  registeredAt: z.string(),
  runtime: AgentRuntimeSchema,
  capabilities: z.array(z.string()),
}).openapi('AgentHealth');
export type AgentHealth = z.infer<typeof AgentHealthSchema>;

// Aggregate mesh status
export const MeshStatusSchema = z.object({
  totalAgents: z.number(),
  activeCount: z.number(),
  inactiveCount: z.number(),
  staleCount: z.number(),
  byRuntime: z.record(z.string(), z.number()),
  byProject: z.record(z.string(), z.number()),
}).openapi('MeshStatus');
export type MeshStatus = z.infer<typeof MeshStatusSchema>;

// Detailed agent inspection
export const MeshInspectSchema = z.object({
  agent: AgentManifestSchema,
  health: AgentHealthSchema,
  relaySubject: z.string().nullable(),
}).openapi('MeshInspect');
export type MeshInspect = z.infer<typeof MeshInspectSchema>;

// Lifecycle event
export const MeshLifecycleEventSchema = z.object({
  agentId: z.string(),
  agentName: z.string(),
  event: z.enum(['registered', 'unregistered', 'health_changed']),
  previousStatus: AgentHealthStatusSchema.optional(),
  currentStatus: AgentHealthStatusSchema.optional(),
  timestamp: z.string(),
}).openapi('MeshLifecycleEvent');
export type MeshLifecycleEvent = z.infer<typeof MeshLifecycleEventSchema>;

// Heartbeat request
export const HeartbeatRequestSchema = z.object({
  event: z.string().optional().default('heartbeat'),
}).openapi('HeartbeatRequest');
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;
```

### 6. HTTP Routes

Add to `apps/server/src/routes/mesh.ts` inside `createMeshRouter()`:

#### GET /api/mesh/status

```typescript
router.get('/status', (_req, res) => {
  try {
    const status = meshCore.getStatus();
    res.json(status);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});
```

**Response:** `MeshStatus` object.

#### GET /api/mesh/agents/:id/health

```typescript
router.get('/agents/:id/health', (req, res) => {
  const health = meshCore.getAgentHealth(req.params.id);
  if (!health) return res.status(404).json({ error: 'Agent not found' });
  res.json(health);
});
```

**Response:** `AgentHealth` object.

#### POST /api/mesh/agents/:id/heartbeat

```typescript
router.post('/agents/:id/heartbeat', (req, res) => {
  const agent = meshCore.get(req.params.id);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const parse = HeartbeatRequestSchema.safeParse(req.body);
  const event = parse.success ? parse.data.event : 'heartbeat';

  meshCore.updateLastSeen(req.params.id, event);
  res.json({ success: true, agentId: req.params.id });
});
```

### 7. MCP Diagnostic Tools

Add to `apps/server/src/services/core/mcp-tool-server.ts`:

#### mesh_status

```typescript
tool('mesh_status', {
  description: 'Get aggregate mesh health stats (total agents, by runtime, by status)',
  parameters: z.object({}),
  execute: async () => {
    const guard = requireMesh(deps);
    if (guard) return guard;
    const status = deps.meshCore!.getStatus();
    return jsonContent(status);
  },
});
```

#### mesh_inspect

```typescript
tool('mesh_inspect', {
  description: 'Get detailed view of a specific agent (manifest, health, relay endpoint)',
  parameters: z.object({
    agentId: z.string().describe('ULID of the agent to inspect'),
  }),
  execute: async ({ agentId }) => {
    const guard = requireMesh(deps);
    if (guard) return guard;
    const detail = deps.meshCore!.inspect(agentId);
    if (!detail) return jsonContent({ error: 'Agent not found' }, true);
    return jsonContent(detail);
  },
});
```

### 8. Transport Interface Extension

Add to the `Transport` interface and `HttpTransport` implementation:

```typescript
// Transport interface additions
getMeshStatus(): Promise<MeshStatus>;
getMeshAgentHealth(id: string): Promise<AgentHealth>;
sendMeshHeartbeat(id: string, event?: string): Promise<{ success: boolean }>;

// HttpTransport implementation
getMeshStatus(): Promise<MeshStatus> {
  return fetchJSON(this.baseUrl, '/mesh/status');
}

getMeshAgentHealth(id: string): Promise<AgentHealth> {
  return fetchJSON(this.baseUrl, `/mesh/agents/${id}/health`);
}

sendMeshHeartbeat(id: string, event?: string): Promise<{ success: boolean }> {
  return fetchJSON(this.baseUrl, `/mesh/agents/${id}/heartbeat`, {
    method: 'POST',
    body: JSON.stringify({ ...(event && { event }) }),
  });
}
```

Also add to `DirectTransport` (Obsidian plugin) with equivalent in-process calls.

### 9. Client Entity Hooks

#### useMeshStatus (`use-mesh-status.ts`)

```typescript
const MESH_STATUS_KEY = ['mesh', 'status'] as const;

export function useMeshStatus(enabled = true) {
  const transport = useTransport();
  return useQuery({
    queryKey: [...MESH_STATUS_KEY],
    queryFn: () => transport.getMeshStatus(),
    enabled,
    staleTime: 30_000,
    refetchInterval: 30_000,  // Poll every 30s
  });
}
```

#### useMeshAgentHealth (`use-mesh-agent-health.ts`)

```typescript
const MESH_HEALTH_KEY = ['mesh', 'health'] as const;

export function useMeshAgentHealth(agentId: string | null) {
  const transport = useTransport();
  return useQuery({
    queryKey: [...MESH_HEALTH_KEY, agentId],
    queryFn: () => transport.getMeshAgentHealth(agentId!),
    enabled: !!agentId,
    staleTime: 15_000,
  });
}
```

#### useMeshHeartbeat (`use-mesh-heartbeat.ts`)

```typescript
export function useMeshHeartbeat() {
  const transport = useTransport();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, event }: { id: string; event?: string }) =>
      transport.sendMeshHeartbeat(id, event),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['mesh', 'status'] });
      queryClient.invalidateQueries({ queryKey: ['mesh', 'health'] });
    },
  });
}
```

Update barrel at `apps/client/src/layers/entities/mesh/index.ts` to export all three.

### 10. Topology Graph Component

#### TopologyGraph.tsx

Lazy-loaded via `React.lazy()` in MeshPanel. Uses `@xyflow/react` with dagre layout.

```typescript
import { ReactFlow, Controls, Background, useNodesState, useEdgesState } from '@xyflow/react';
import dagre from 'dagre';

// IMPORTANT: nodeTypes must be defined outside the component
const nodeTypes = { agent: AgentNode };

export function TopologyGraph({ agents }: { agents: AgentHealthEntry[] }) {
  const [nodes, setNodes, onNodesChange] = useNodesState(buildNodes(agents));
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);

  useEffect(() => {
    const { nodes: laid, edges: laidEdges } = layoutWithDagre(agents);
    setNodes(laid);
    setEdges(laidEdges);
  }, [agents]);

  return (
    <div className="h-full w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={(_, node) => setSelectedAgent(node.id)}
        fitView
      >
        <Controls />
        <Background />
      </ReactFlow>
      {selectedAgent && (
        <AgentHealthDetail
          agentId={selectedAgent}
          onClose={() => setSelectedAgent(null)}
        />
      )}
    </div>
  );
}
```

**Dagre layout function:**

```typescript
function layoutWithDagre(agents: AgentHealthEntry[]) {
  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'LR', nodesep: 60, ranksep: 100 });
  g.setDefaultEdgeLabel(() => ({}));

  agents.forEach((agent) => {
    g.setNode(agent.id, { width: 200, height: 80 });
  });

  dagre.layout(g);

  const nodes = agents.map((agent) => {
    const pos = g.node(agent.id);
    return {
      id: agent.id,
      type: 'agent',
      position: { x: pos.x - 100, y: pos.y - 40 },
      data: agent,
    };
  });

  return { nodes, edges: [] };  // No edges for v1 (flat topology)
}
```

#### AgentNode.tsx

Custom React Flow node component:

```typescript
import { Handle, Position } from '@xyflow/react';
import { Badge } from '@/layers/shared/ui/badge';

const STATUS_COLORS = {
  active: 'bg-green-500',
  inactive: 'bg-amber-500',
  stale: 'bg-neutral-400',
} as const;

export function AgentNode({ data }: { data: AgentHealthEntry }) {
  return (
    <div className="rounded-xl border bg-card p-3 shadow-sm">
      <Handle type="target" position={Position.Left} className="invisible" />
      <div className="flex items-center gap-2">
        <span className={`size-2.5 rounded-full ${STATUS_COLORS[data.healthStatus]}`} />
        <span className="text-sm font-medium">{data.name}</span>
      </div>
      <div className="mt-1 flex items-center gap-1.5">
        <Badge variant="secondary" className="text-xs">
          {data.runtime}
        </Badge>
        {data.capabilities.slice(0, 2).map((cap) => (
          <Badge key={cap} variant="outline" className="text-xs">
            {cap}
          </Badge>
        ))}
      </div>
      <Handle type="source" position={Position.Right} className="invisible" />
    </div>
  );
}
```

Handles are invisible for v1 (no edges) but present for future Spec 3 integration.

#### MeshStatsHeader.tsx

Compact stats bar above MeshPanel tabs:

```typescript
export function MeshStatsHeader({ enabled }: { enabled: boolean }) {
  const { data: status, isLoading } = useMeshStatus(enabled);

  if (!enabled || isLoading || !status) return null;

  return (
    <div className="mx-4 mt-3 flex items-center gap-3 text-xs text-muted-foreground">
      <span>{status.totalAgents} agents</span>
      <span className="text-green-600 dark:text-green-400">
        {status.activeCount} active
      </span>
      <span className="text-amber-600 dark:text-amber-400">
        {status.inactiveCount} inactive
      </span>
      <span>{status.staleCount} stale</span>
    </div>
  );
}
```

#### AgentHealthDetail.tsx

Detail panel shown when clicking a node or agent card:

```typescript
export function AgentHealthDetail({ agentId, onClose }: Props) {
  const { data: health, isLoading } = useMeshAgentHealth(agentId);

  if (isLoading) return <Loader2 className="size-4 animate-spin" />;
  if (!health) return null;

  return (
    <div className="absolute right-0 top-0 z-10 w-80 rounded-xl border bg-card p-4 shadow-lg">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">{health.name}</h3>
        <button onClick={onClose}><X className="size-4" /></button>
      </div>
      <div className="mt-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Status</span>
          <Badge variant={health.status === 'active' ? 'default' : 'secondary'}>
            {health.status}
          </Badge>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last seen</span>
          <span>{health.lastSeenAt ? formatRelative(health.lastSeenAt) : 'Never'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Last event</span>
          <span>{health.lastSeenEvent ?? 'N/A'}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Runtime</span>
          <Badge variant="secondary">{health.runtime}</Badge>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">Registered</span>
          <span>{formatRelative(health.registeredAt)}</span>
        </div>
        {health.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1 pt-1">
            {health.capabilities.map((cap) => (
              <Badge key={cap} variant="outline" className="text-xs">{cap}</Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
```

### 11. MeshPanel Updates

Add Topology tab and stats header to `MeshPanel.tsx`:

```typescript
const LazyTopologyGraph = lazy(() =>
  import('./TopologyGraph').then((m) => ({ default: m.TopologyGraph }))
);

export function MeshPanel() {
  const meshEnabled = useMeshEnabled();
  const { data: agentsResult, isLoading: agentsLoading } = useRegisteredAgents(undefined, meshEnabled);
  const agents = agentsResult?.agents ?? [];
  const { data: deniedResult, isLoading: deniedLoading } = useDeniedAgents(meshEnabled);
  const denied = deniedResult?.denied ?? [];

  if (!meshEnabled) { /* ... existing disabled state ... */ }

  return (
    <Tabs defaultValue="topology" className="flex h-full flex-col">
      <MeshStatsHeader enabled={meshEnabled} />
      <TabsList className="mx-4 mt-2 shrink-0">
        <TabsTrigger value="topology">Topology</TabsTrigger>
        <TabsTrigger value="discovery">Discovery</TabsTrigger>
        <TabsTrigger value="agents">Agents</TabsTrigger>
        <TabsTrigger value="denied">Denied</TabsTrigger>
      </TabsList>

      <TabsContent value="topology" className="relative min-h-0 flex-1">
        <Suspense fallback={<LoadingSpinner />}>
          <LazyTopologyGraph agents={agents} />
        </Suspense>
      </TabsContent>

      {/* ... existing tabs unchanged ... */}
    </Tabs>
  );
}
```

Default tab changes from `"discovery"` to `"topology"` — the topology view is the primary observability surface.

### 12. CSS Import

Add React Flow styles to `apps/client/src/index.css`:

```css
@import '@xyflow/react/dist/style.css';
```

This must be at the file level, not inside a component import.

### 13. SSE Lifecycle Event Streaming

Add `mesh_lifecycle` event type to the SSE protocol. Server-side, subscribe to mesh lifecycle signals and fan out to connected SSE clients:

In `apps/server/src/index.ts` (after mesh initialization):

```typescript
if (meshCore && relayCore) {
  const signalEmitter = relayCore.signalEmitter;
  signalEmitter.subscribe('mesh.agent.lifecycle.>', (subject, signal) => {
    // Broadcast to all connected mesh SSE clients
    meshLifecycleBroadcaster.broadcast({
      type: 'mesh_lifecycle',
      data: signal,
    });
  });
}
```

Client-side, the `useMeshStatus` hook's 30s polling is sufficient for health updates. Real-time lifecycle events can be consumed via the existing Relay event stream pattern if needed in the future.

## User Experience

### Topology Tab (Default View)

When opening the Mesh panel, users see the Topology tab:

1. **Stats header** at the top: "12 agents | 8 active | 3 inactive | 1 stale"
2. **Network graph** showing agents as cards with:
   - Green dot = active (communicating recently)
   - Amber dot = inactive (idle 5-30 min)
   - Grey dot = stale (idle > 30 min or never seen)
   - Runtime badge (claude-code, cursor, codex)
   - First 2 capability badges
3. **Click a node** to see health detail panel (last seen, last event, capabilities, etc.)
4. **Zoom/pan controls** via React Flow's built-in Controls component

### Existing Tabs (Unchanged)

Discovery, Agents, and Denied tabs remain exactly as-is. The Agents tab cards could optionally gain a health status dot in a future enhancement.

### MCP Tools

Agents can inspect the mesh via:
- `mesh_status` — "How many agents are active?" → returns aggregate counts
- `mesh_inspect 01JKABC00001` — "Tell me about this agent" → returns full detail

### Empty State

When no agents are registered, the Topology tab shows an empty state: "No agents registered. Discover and register agents from the Discovery tab."

## Testing Strategy

### Unit Tests — packages/mesh/

**`agent-registry.test.ts` additions:**

- `it('migrates from v1 to v2 adding health columns')` — Verify migration runs cleanly on v1 database, columns exist
- `it('updateHealth() sets last_seen_at and last_seen_event')` — Verify update writes correctly
- `it('getWithHealth() computes active status for recent timestamp')` — Set last_seen_at to 1 min ago, verify status='active'
- `it('getWithHealth() computes inactive status for 10-minute-old timestamp')` — Verify status='inactive'
- `it('getWithHealth() computes stale status for 60-minute-old timestamp')` — Verify status='stale'
- `it('getWithHealth() computes stale for null last_seen_at')` — Never-seen agent is stale
- `it('getAggregateStats() returns correct counts')` — Insert agents with varying last_seen_at, verify counts
- `it('listWithHealth() includes health_status for all agents')` — Verify all entries have computed status

**`mesh-core.test.ts` additions:**

- `it('updateLastSeen() updates registry and emits health_changed signal on transition')` — Mock SignalEmitter, verify emit called when status changes
- `it('updateLastSeen() does not emit signal when status unchanged')` — Verify no signal for same-state update
- `it('getStatus() returns aggregate health stats')` — Verify shape matches MeshStatus
- `it('inspect() returns agent + health + relay subject')` — Verify shape matches MeshInspect
- `it('inspect() returns undefined for unknown agent')` — Verify graceful handling

**`relay-bridge.test.ts` additions:**

- `it('registerAgent() emits lifecycle.registered signal')` — Mock SignalEmitter, verify emit called with correct subject/payload
- `it('unregisterAgent() emits lifecycle.unregistered signal')` — Verify emit on unregister
- `it('no signal emitted when SignalEmitter is undefined')` — Verify no-op behavior

### Unit Tests — apps/server/

**`routes/__tests__/mesh.test.ts` additions:**

- `it('GET /status returns aggregate health stats')` — Mock meshCore.getStatus(), verify response shape
- `it('GET /agents/:id/health returns agent health')` — Mock meshCore.getAgentHealth(), verify response
- `it('GET /agents/:id/health returns 404 for unknown agent')` — Verify error handling
- `it('POST /agents/:id/heartbeat updates last seen')` — Mock meshCore.updateLastSeen(), verify call
- `it('POST /agents/:id/heartbeat returns 404 for unknown agent')` — Verify error handling

**`services/core/__tests__/mcp-tool-server.test.ts` additions:**

- `it('mesh_status tool returns aggregate stats')` — Verify tool registration and execution
- `it('mesh_inspect tool returns agent detail')` — Verify with valid agentId
- `it('mesh_inspect tool returns error for unknown agent')` — Verify error handling
- `it('mesh tools return error when mesh disabled')` — Verify guard function

### Component Tests — apps/client/

**`features/mesh/__tests__/MeshPanel.test.tsx`:**

- `it('renders Topology tab as default')` — Verify topology tab is selected on mount
- `it('renders stats header with aggregate counts')` — Mock useMeshStatus, verify display
- `it('renders all four tabs')` — Verify Topology, Discovery, Agents, Denied tabs present

**`features/mesh/__tests__/MeshStatsHeader.test.tsx`:**

- `it('renders nothing when disabled')` — Verify null render
- `it('renders nothing when loading')` — Verify null render
- `it('displays correct counts')` — Mock data, verify text content
- `it('uses correct color classes for status counts')` — Verify green/amber classes

**`entities/mesh/__tests__/use-mesh-status.test.ts`:**

- `it('fetches from /api/mesh/status')` — Verify transport method called
- `it('polls every 30 seconds')` — Verify refetchInterval
- `it('disabled when enabled=false')` — Verify no fetch

### Integration Testing

- Manual verification: register 3+ agents, verify topology shows correct nodes with health indicators
- Verify health status updates after simulated Relay messages
- Verify lifecycle signals appear in Relay subscriber logs

## Performance Considerations

- **React Flow with 10-50 nodes:** No optimization needed. Apply `React.memo` to `AgentNode` as good practice.
- **Lazy loading:** `TopologyGraph` loaded via `React.lazy()` — `@xyflow/react` bundle (~150-200 KB) not in initial page load.
- **Health polling:** 30s `refetchInterval` on `useMeshStatus` — minimal server load.
- **SQL computation:** Health status computed via `julianday()` at query time — SQLite handles this efficiently for < 1000 rows.
- **No background jobs:** Health status thresholds are pure SQL computations, no timers or cron needed.
- **Signal emission:** Synchronous, in-memory only via SignalEmitter — zero disk I/O.

## Security Considerations

- **Path exposure:** Topology endpoint returns project paths. All mesh routes are already behind `DORKOS_MESH_ENABLED` feature flag and mesh router mounting.
- **Heartbeat validation:** POST /agents/:id/heartbeat validates agent exists before updating `last_seen_at`.
- **Feature flag guard:** All new routes and MCP tools are guarded by the existing mesh feature flag pattern.
- **No new auth surface:** Mesh observability uses the same auth model as existing mesh routes (currently none — DorkOS is single-user, local-only).

## Documentation

- Update `contributing/api-reference.md` with new mesh routes (GET /status, GET /agents/:id/health, POST /agents/:id/heartbeat)
- Update `CLAUDE.md` mesh route descriptions to include new endpoints
- Add new MCP tools to the tool list in `CLAUDE.md`
- Update `docs/` external docs with mesh observability guide

## Implementation Phases

### Phase 1: Core Health Tracking (packages/mesh/ + packages/shared/)

1. Add `AgentHealthSchema`, `MeshStatusSchema`, `MeshInspectSchema`, `MeshLifecycleEventSchema` to `mesh-schemas.ts`
2. Add v2 migration to `agent-registry.ts` — `last_seen_at`, `last_seen_event` columns
3. Add `updateHealth()`, `getWithHealth()`, `listWithHealth()`, `getAggregateStats()` to AgentRegistry
4. Add `updateLastSeen()`, `getAgentHealth()`, `getStatus()`, `inspect()` to MeshCore
5. Write unit tests for registry and core health methods

### Phase 2: Lifecycle Signals + Server Routes

1. Extend `RelayBridge` with `SignalEmitter` injection and lifecycle signal emission
2. Pass `SignalEmitter` through `MeshOptions` and wire in `index.ts`
3. Add `GET /status`, `GET /agents/:id/health`, `POST /agents/:id/heartbeat` to mesh router
4. Add `mesh_status`, `mesh_inspect` MCP tools
5. Write server route and MCP tool tests

### Phase 3: Client UI

1. Install `@xyflow/react`, `dagre`, `@types/dagre` in `apps/client`
2. Add `@xyflow/react/dist/style.css` import to `index.css`
3. Add Transport interface methods + HttpTransport implementation
4. Create entity hooks: `useMeshStatus`, `useMeshAgentHealth`, `useMeshHeartbeat`
5. Create `AgentNode.tsx`, `TopologyGraph.tsx`, `MeshStatsHeader.tsx`, `AgentHealthDetail.tsx`
6. Update `MeshPanel.tsx` with Topology tab + stats header
7. Update barrel exports
8. Write component tests

## Open Questions

None — all questions resolved during ideation.

## Related ADRs

| ADR | Title | Relevance |
|---|---|---|
| #23 | Custom Async BFS for Agent Discovery | Discovery engine architecture (unchanged by this spec) |
| #24 | DorkOS-Native Agent Manifest at .dork/agent.json | Manifest format that health tracking extends |
| #25 | Simple JSON Columns for Agent Registry | SQLite schema pattern we're extending with health columns |

## References

- [React Flow v12 — React 19 + Tailwind 4 Support](https://reactflow.dev/whats-new/2025-10-28)
- [React Flow — Custom Nodes](https://reactflow.dev/learn/customization/custom-nodes)
- [React Flow — Dagre Layout Example](https://reactflow.dev/examples/layout/dagre)
- [Kiali — Service Mesh Health](https://kiali.io/docs/features/health/)
- [Kiali — Topology View](https://kiali.io/docs/features/topology/)
- [Ideation Document](./01-ideation.md)
- [Research Artifact](../../research/20260225_mesh_observability_lifecycle.md)
