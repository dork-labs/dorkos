# Mesh Observability & Lifecycle — Research Findings

**Date**: 2026-02-25
**Feature**: mesh-observability-lifecycle
**Depth**: Deep Research (13 tool calls)

---

## Research Summary

React Flow (`@xyflow/react` v12) is the clear choice for the topology graph: it is React 19 + Tailwind 4 compatible (explicitly confirmed), has 2.9M weekly npm downloads, supports fully custom React node components, and ships with dagre and ELK layout adapters. For 10–50 nodes the library is trivially within its performance envelope. Health tracking should follow a three-state machine (active → inactive → stale) keyed on a `last_seen_at` SQLite column with configurable thresholds, and lifecycle signals should be delivered as Relay ephemeral publishes on `mesh.agent.lifecycle.*`.

---

## Key Findings

### 1. React Flow v12 is Production-Ready for This Use Case

- Package renamed `reactflow` → `@xyflow/react` at v12; old name is legacy.
- React 19 + Tailwind CSS 4 compatibility is **explicitly documented** in the v12 UI Components changelog.
- 2,940,303 weekly downloads (npmtrends data, Feb 2025) — by far the most adopted library in this space.
- Custom nodes are plain React components: render anything inside (badges, status dots, sparklines). The library wraps them with its own drag/select/connect container.
- Built-in layout adapters: dagre (quick tree/hierarchical), ELK (Eclipse Layout Kernel — more powerful, supports groups/sub-flows), d3-hierarchy.
- Performance guide recommends `React.memo` on custom node components, `useCallback` on handlers, and Zustand for node/edge state (already used in DorkOS client).
- Stress test demo handles 1,000+ nodes; 10–50 is trivial.
- The `nodeTypes` object **must be defined outside the component** (or `useMemo`'d) to prevent re-renders resetting the graph.

### 2. Cytoscape.js — Powerful but Wrong Abstraction Layer

- Core library: ~365 KB minified / ~112 KB gzipped (from GitHub size-snapshot).
- React wrapper (`react-cytoscapejs`) is maintained by Plotly, last actively released in 2023.
- API is imperative and graph-theory-oriented — great for analysis (shortest path, clustering) but produces more boilerplate for a status dashboard.
- Custom node rendering is done via CSS selectors on canvas, **not React components** — cannot embed shadcn/ui Badge or status indicators natively.
- For a single-machine mesh of 10–50 agents where the goal is a rich visual card per node, React Flow's native React-component-as-node model is strongly preferred.

### 3. Sigma.js / @react-sigma/core — Overkill for This Scale

- WebGL-based, designed for graphs of thousands of nodes.
- `@react-sigma/core` v5.0.6 (published ~1 month ago as of research date) — maintained.
- Custom node rendering requires a custom renderer (not React components) — significant added complexity.
- No benefit for 10–50 nodes; adds WebGL dependency for no gain.
- Dismiss unless the agent count grows to 500+.

### 4. vis-network — Legacy Choice, Avoid

- `vis-network` v10.0.2 published ~5 months ago; sporadic maintenance cadence.
- React wrappers (`vis-react`, `vis-network-react`) are community-maintained with unclear React 19 support.
- API is vanilla JS with imperative DOM manipulation — poor fit for React 19 concurrent mode.
- The broader `vis.js` ecosystem has fragmented over time; multiple forks and wrappers create confusion.

### 5. Custom SVG + d3-force — Maximum Control, Maximum Cost

- `d3-force` is a module-only dependency (~10 KB) but requires implementing the full rendering and interaction layer.
- SVG performance is fine for 10–50 nodes; canvas is only needed for 500+.
- You would manually implement: drag, zoom/pan, node selection, tooltip, edge rendering, animated transitions.
- Suitable if the topology view needs highly specialized behavior that React Flow cannot provide.
- For this feature, the cost-to-benefit ratio is unfavorable compared to React Flow.

### 6. Service Mesh Dashboard Design Patterns (Kiali / Consul / Grafana)

**Kiali (Istio's service mesh console):**
- Four-tier health classification: NA (grey) → Healthy (green) → Degraded (orange) → Failure (red).
- Health is a *composite* of multiple indicators (traffic success rate, pod status).
- Nodes and edges are both colored — edges show traffic flow health.
- Graph type switcher: service topology vs. workload topology vs. application topology.
- "Find/hide" filter to highlight specific nodes; ranking by inbound edge count.
- Per-node badges: circuit breaker, fault injection, virtual service.

**HashiCorp Consul UI:**
- Topology visualization shows sidecar proxies and upstream/downstream dependencies.
- Services have health checks (passing / warning / critical), displayed as colored dots.
- Filters by namespace, datacenter, service type.
- Explicitly described as "overview, not a comprehensive monitoring tool" — links out to Grafana.

**Key design pattern consensus:**
1. Color-coded status (green/yellow/red) is universally understood — use it.
2. Aggregate summary stats at the top (X active, Y inactive, Z stale) before the graph.
3. Topology graph is a secondary view; the primary view is a filterable list/table.
4. Click a node to show a detail panel (right sidebar or modal) with full info + history.
5. Edge labels show message flow direction or count, not just connections.

### 7. Agent Health Monitoring Patterns

**Heartbeat vs. message-based detection:**
- *Heartbeat* (push): Agent actively publishes a signal on an interval. Faster detection, predictable load.
- *Message-based* (pull): Health inferred from last activity timestamp. Zero extra traffic, but detection lag equals polling interval.
- For DorkOS: message-based is simpler since the Relay already timestamps all messages. Use a `last_seen_at` column updated on any Relay publish. Add an optional explicit heartbeat signal on `mesh.agent.lifecycle.heartbeat` for agents that want faster health detection.

**Standard thresholds from production systems:**
| System | Heartbeat interval | Inactive threshold |
|---|---|---|
| SCOM (Microsoft) | 60 s | 4 missed = 240 s |
| Bamboo CI | 30 s default | configurable |
| CipherTrust | configurable | 2x interval |
| AWS Step Functions | configurable `HeartbeatSeconds` | — |

**Recommended three-state machine for DorkOS:**

```
ACTIVE  (last_seen < 5 minutes ago)
   ↓ no signal for 5 min
INACTIVE (last_seen 5–30 minutes ago)
   ↓ no signal for 30 min
STALE (last_seen > 30 minutes ago)
   ↓ manual removal or TTL cleanup
REMOVED
```

Thresholds should be configurable constants in `packages/mesh/src/health.ts` with sensible defaults (5 min active, 30 min stale), not hardcoded magic numbers.

**State transition events** should be emitted as Relay signals:
- `mesh.agent.lifecycle.joined` — agent registered
- `mesh.agent.lifecycle.heartbeat` — explicit ping from agent
- `mesh.agent.lifecycle.status_changed` — active↔inactive↔stale transition
- `mesh.agent.lifecycle.left` — agent unregistered

### 8. Graph Layout for 10–50 Nodes

**Force-directed (`d3-force` or React Flow's built-in):**
- Pros: Emerges organically, good for dense or irregular topologies. No manual positioning required.
- Cons: Non-deterministic; same graph may render differently on each load. Can produce hairball patterns with many edges. Poor for showing hierarchy.
- Verdict: Good default for a mesh where all agents are peers.

**Dagre (tree/hierarchical):**
- Pros: Deterministic, clean left-to-right or top-to-bottom flow. Shows runtime hierarchy (Claude Code → Cursor → Codex as tiers).
- Cons: Requires directed edges; looks artificial for true peer-to-peer meshes.
- Verdict: Best if you want to group by runtime or project. React Flow has a first-party dagre example.

**ELK (Eclipse Layout Kernel via elkjs):**
- Pros: Most powerful — supports group nodes, sub-flows, mixed layouts. Can cluster by attribute (runtime, project).
- Cons: Heavier import (~200 KB); more configuration. Does not support `parentNode` — uses `children` arrays instead.
- Verdict: Best if agents need to be visually grouped (e.g., all Claude Code agents in one cluster, all Cursor agents in another).

**Recommendation for this feature:** Start with **dagre** for its deterministic layout and first-party React Flow support. Add an ELK option if grouping by runtime becomes a user request. The React Flow examples site ships ready-to-copy implementations of both.

---

## Detailed Analysis

### Topology Graph Component Design

Given the existing `AgentCard` and `AgentManifest` types in the codebase, a custom React Flow node wrapping the existing `AgentCard` component would look like:

```tsx
// TopologyNode.tsx — inside features/mesh/ui/
import { Handle, Position, type NodeProps } from '@xyflow/react';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { AgentHealthStatus } from '../model/health';

export interface AgentNodeData {
  agent: AgentManifest;
  health: AgentHealthStatus; // 'active' | 'inactive' | 'stale'
  lastSeen: string | null;
}

export function AgentTopologyNode({ data, selected }: NodeProps<AgentNodeData>) {
  return (
    <>
      <Handle type="target" position={Position.Left} />
      <div className={cn('rounded-xl border p-3 min-w-[160px]', selected && 'ring-2 ring-ring')}>
        <div className="flex items-center gap-2">
          <StatusDot status={data.health} />
          <span className="text-sm font-medium">{data.agent.name}</span>
        </div>
        <Badge variant="secondary" className="mt-1 text-xs">{data.agent.runtime}</Badge>
      </div>
      <Handle type="source" position={Position.Right} />
    </>
  );
}
```

The `nodeTypes` constant must be defined **outside** the component tree (or in a module-level const) to avoid React Flow re-mounting nodes on every parent render.

### SQLite Schema Addition for Health Tracking

The existing `AgentRegistry` (`packages/mesh/src/agent-registry.ts`) stores agents with `registered_at` but has no `last_seen_at` or health state column. A new migration (Version 2) should add:

```sql
-- Migration version 2
ALTER TABLE agents ADD COLUMN last_seen_at TEXT;
ALTER TABLE agents ADD COLUMN last_seen_event TEXT; -- 'registered' | 'heartbeat' | 'message'
CREATE INDEX IF NOT EXISTS idx_agents_last_seen ON agents(last_seen_at);
```

This follows the same WAL + PRAGMA user_version migration pattern already in `AgentRegistry`. A separate `HealthChecker` service can derive status from `last_seen_at` without an additional column (status is computed, not stored):

```typescript
function computeHealthStatus(lastSeenAt: string | null): AgentHealthStatus {
  if (!lastSeenAt) return 'stale';
  const ageMs = Date.now() - new Date(lastSeenAt).getTime();
  if (ageMs < ACTIVE_THRESHOLD_MS) return 'active';
  if (ageMs < STALE_THRESHOLD_MS) return 'inactive';
  return 'stale';
}
```

### Relay Lifecycle Signals Integration

The existing `RelayBridge` (`packages/mesh/src/relay-bridge.ts`) already integrates with `RelayCore` for endpoint registration. Lifecycle signals should be published via the same bridge:

```typescript
// In RelayBridge
async publishLifecycle(
  agentId: string,
  event: 'joined' | 'heartbeat' | 'status_changed' | 'left',
  payload: Record<string, unknown>
): Promise<void> {
  if (!this.relayCore) return;
  const subject = `mesh.agent.lifecycle.${event}`;
  await this.relayCore.publish(subject, { agentId, ...payload, ts: new Date().toISOString() });
}
```

The `MessageReceiver` in the server should subscribe to `mesh.agent.lifecycle.>` and call `agentRegistry.updateLastSeen(agentId)` to keep health timestamps current.

### HTTP Routes for Observability

New routes on the existing `mesh.ts` router:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/mesh/topology` | Return nodes + edges as `{ nodes: AgentTopologyNode[], edges: AgentEdge[] }` |
| `GET` | `/api/mesh/health` | Return health summary `{ active: N, inactive: N, stale: N, agents: AgentHealthEntry[] }` |
| `GET` | `/api/mesh/lifecycle/stream` | SSE stream of `mesh.agent.lifecycle.*` events |
| `POST` | `/api/mesh/agents/:id/heartbeat` | Explicit heartbeat touch (updates `last_seen_at`) |

### MCP Diagnostic Tools

New tools in `mcp-tool-server.ts` under the mesh tools section:

| Tool name | Description |
|---|---|
| `mesh_topology` | Returns full topology graph as nodes and edges |
| `mesh_health_summary` | Returns active/inactive/stale counts |
| `mesh_agent_health` | Returns health detail for a single agent by ID |
| `mesh_lifecycle_events` | Returns recent lifecycle events from SQLite trace |

### Client-Side FSD Structure

New additions under `features/mesh/`:

```
features/mesh/
├── ui/
│   ├── TopologyGraph.tsx        # @xyflow/react canvas component
│   ├── AgentTopologyNode.tsx    # Custom React Flow node
│   ├── StatusDot.tsx            # active/inactive/stale dot indicator
│   ├── HealthSummaryBar.tsx     # aggregate stats (X active, Y inactive, Z stale)
│   ├── LifecycleFeed.tsx        # SSE event stream display
│   └── MeshPanel.tsx            # existing — add "Topology" tab
├── model/
│   ├── use-topology.ts          # TanStack Query for /api/mesh/topology
│   ├── use-mesh-health.ts       # TanStack Query for /api/mesh/health
│   └── health.ts                # AgentHealthStatus type + constants
└── index.ts                     # barrel exports
```

New entity hooks under `entities/mesh/`:
- `useMeshTopology` — fetches topology data for the graph
- `useMeshHealth` — fetches aggregate health metrics
- `useMeshLifecycleStream` — SSE subscription for lifecycle events

---

## Sources & Evidence

- React Flow v12 React 19 + Tailwind 4 compatibility: [React Flow UI Components updated](https://reactflow.dev/whats-new/2025-10-28)
- React Flow v12 migration guide: [Migrate to React Flow 12](https://reactflow.dev/learn/troubleshooting/migrate-to-v12)
- React Flow custom nodes documentation: [Custom Nodes](https://reactflow.dev/learn/customization/custom-nodes)
- React Flow performance guide: [Performance](https://reactflow.dev/learn/advanced-use/performance)
- React Flow layout algorithms: [Overview](https://reactflow.dev/learn/layouting/layouting)
- @xyflow/react npm stats (2.9M weekly downloads): [npmtrends](https://npmtrends.com/@xyflow/react-vs-reactflow)
- Cytoscape.js bundle size (365 KB min / 112 KB gzip): [cytoscape.js size snapshot](https://github.com/cytoscape/cytoscape.js/blob/unstable/.size-snapshot.json)
- Cytoscape.js maintenance (monthly feature releases): [Cytoscape.js 2025 blog](https://blog.js.cytoscape.org/2025/07/28/3.33.0-release/)
- react-cytoscapejs React wrapper: [GitHub - plotly/react-cytoscapejs](https://github.com/plotly/react-cytoscapejs)
- @react-sigma/core v5.0.6: [@react-sigma/core npm](https://www.npmjs.com/package/@react-sigma/core)
- vis-network v10.0.2: [vis-network npm](https://www.npmjs.com/package/vis-network)
- Kiali health indicators (4-tier: NA/Healthy/Degraded/Failure): [Health | Kiali](https://kiali.io/docs/features/health/)
- Kiali topology visualization: [Topology | Kiali](https://kiali.io/docs/features/topology/)
- Consul mesh topology visualization: [Service Mesh Observability - UI Visualization](https://developer.hashicorp.com/consul/docs/connect/observability/ui-visualization)
- SCOM heartbeat (60s interval, 4-miss threshold): [How Heartbeats Work in Operations Manager](https://learn.microsoft.com/en-us/system-center/scom/manage-agent-heartbeat-overview?view=sc-om-2025)
- CipherTrust two-state heartbeat machine (healthy → warning → error): [Heartbeat Configuration](https://thalesdocs.com/ctp/cm/2.7/admin/adp_ag/adp-heartbt/index.html)
- d3-force layout and force types: [D3-Force Directed Graph Layout Optimization](https://dzone.com/articles/d3-force-directed-graph-layout-optimization-in-neb)
- Dagre vs ELK in React Flow (dagre fast/minimal, ELK powerful/grouped): [Overview - React Flow Layouting](https://reactflow.dev/learn/layouting/layouting)
- ELK subflows vs dagre subflows limitation: [ElkJS/Dagre with subflows?](https://github.com/xyflow/xyflow/discussions/3495)
- Claude Code multi-agent observability with SQLite: [claude-code-hooks-multi-agent-observability](https://github.com/disler/claude-code-hooks-multi-agent-observability)
- AutoGen SQLite/File logger for multi-agent tracking: [Agent Observability | AutoGen 0.2](https://microsoft.github.io/autogen/0.2/docs/topics/llm-observability/)
- sardine.ai React Flow + ELK production example: [Visualizing Customer Networks with React Flow and ELK](https://www.sardine.ai/blog/visualizing-customer-networks-with-react-flow-and-elk)

---

## Research Gaps & Limitations

- **Exact @xyflow/react bundle size**: Bundlephobia's rendered data was not extractable by the fetch tool. Based on npm package structure and community reports, the minified+gzipped size is approximately 150–200 KB — significant but acceptable for an internal dashboard feature loaded lazily. Should be confirmed with `npm pack` analysis or bundlephobia.com direct visit before implementation.
- **React 19 strict mode compatibility**: While v12 is documented as React 19 compatible, no specific strict mode regression test results were found. The xyflow GitHub discussions should be checked for any React 19 edge cases.
- **Relay `publish()` API availability**: The research assumes `RelayCore.publish()` exists. The codebase has `registerEndpoint`/`unregisterEndpoint` confirmed in `relay-bridge.ts`, but the full `RelayCore` publish API needs verification in `packages/relay/src/`.

---

## Contradictions & Disputes

- **react-cytoscapejs maintenance**: The Plotly-owned repo has reduced commit activity since mid-2023, while a community fork (`DeepChannel/react-cytoscapejs`) is more active. Neither side is a clear winner; the underlying `cytoscape` library itself is actively maintained (monthly releases). If Cytoscape's analysis capabilities (shortest path, clustering) were needed, this fork question would matter more.
- **Sigma.js release cadence**: The `@react-sigma/core` v5 is recent (1 month old at research time), but the sigma.js community is smaller than React Flow's by an order of magnitude. Some sources describe it as production-ready for large graphs; others note limited custom rendering support.

---

## RESEARCH FINDINGS

### Potential Solutions (Graph Library)

**1. @xyflow/react (React Flow v12)**
- Description: The dominant React node-graph library; used for workflow builders, diagrams, and topology views. Nodes are React components.
- Pros: React 19 + Tailwind 4 explicitly supported; custom nodes are plain React components (can embed shadcn/ui badges, icons, status dots); first-party dagre + ELK layout examples; excellent DX and documentation; 2.9M weekly downloads; Zustand integration aligns with existing DorkOS state; lazy/viewport-based rendering available.
- Cons: Bundle size is meaningful (~150-200 KB min+gz estimated; CSS must be imported separately); requires defining `nodeTypes` outside component tree to avoid bugs; not designed for graph-theory analysis (but DorkOS doesn't need that).
- Bundle size: ~150–200 KB min+gz (estimated; not confirmed via bundlephobia render)
- React 19 compat: Confirmed (explicit changelog entry)
- Complexity: Low
- Maintenance: High (2.9M weekly downloads, active xyflow org)

**2. Cytoscape.js + react-cytoscapejs**
- Description: Graph theory library with canvas/SVG rendering. Strong analysis primitives (shortest path, clustering).
- Pros: Excellent algorithm support; actively maintained core library; good for data-heavy graph analysis.
- Cons: 365 KB min / 112 KB gzip for the core alone; React wrapper renders to canvas/SVG, not React components — cannot embed shadcn Badge natively; wrapper (Plotly's) last active 2023; imperative API fights React's declarative model.
- Bundle size: ~365 KB min / ~112 KB gzip (core only)
- React 19 compat: Unknown (wrapper not tested)
- Complexity: High
- Maintenance: Medium (core active, wrapper sporadic)

**3. @react-sigma/core (Sigma.js)**
- Description: WebGL-based graph renderer for large graphs (1,000+ nodes). React bindings for sigma.js v3.
- Pros: Handles massive graphs without performance degradation; actively maintained (v5 recent).
- Cons: WebGL adds a significant dependency; custom node rendering requires a custom WebGL renderer (no React components as nodes); complete overkill for 10–50 nodes; poor DX for status dashboards.
- Bundle size: Not confirmed (WebGL adds to size)
- React 19 compat: Unknown
- Complexity: High
- Maintenance: Medium

**4. vis-network**
- Description: Mature network graph library with a long history. Used in many academic and enterprise tools.
- Pros: Powerful built-in physics simulation; easy to get started.
- Cons: Fragmented React wrapper ecosystem; sporadic release cadence; imperative DOM API; uncertain React 19 / concurrent mode compatibility.
- Bundle size: Large (full vis.js is 500+ KB; vis-network alone is smaller but unconfigured)
- React 19 compat: Uncertain
- Complexity: Medium
- Maintenance: Low

**5. Custom SVG + d3-force**
- Description: Build the rendering layer from scratch using React SVG + d3-force physics for positioning.
- Pros: Zero library constraints; exactly the look and behavior you want; d3-force module alone is ~10 KB.
- Cons: Must implement drag, zoom/pan, edge rendering, tooltip, selection, animated layout transitions from scratch; not advisable when React Flow provides all of this.
- Bundle size: ~10 KB (d3-force only) + implementation cost
- React 19 compat: Full (it's just React + SVG)
- Complexity: Very High
- Maintenance: N/A (owned code)

---

### Dashboard Design Patterns

Key insights from Kiali, Consul, and Grafana service mesh UIs:

1. **Status color system**: Green = healthy/active, Yellow/Orange = degraded/inactive, Red = failure/stale, Grey = unknown/no data. This is universal and instantly understood.
2. **Composite health**: Health is a composite of multiple indicators. For DorkOS: last_seen_at + any explicit heartbeat signal → single `AgentHealthStatus`.
3. **Summary bar before the graph**: Show aggregate counts (X active, Y inactive, Z stale) at the top of the panel before the user interacts with individual nodes.
4. **Node decoration, not just color**: Kiali decorates nodes with icon badges (circuit breaker, fault injection). For DorkOS: show the runtime badge (claude-code, cursor, codex) on the node itself.
5. **Detail panel on click**: Clicking a node opens a right-side detail panel or modal with full agent info, last-seen time, registered timestamp, and recent lifecycle events.
6. **Tab pattern**: The existing `MeshPanel.tsx` uses tabs (Discovery / Agents / Denied). Add a "Topology" tab — don't replace the list view, it's more scannable for monitoring.
7. **Consul's explicit scope limitation**: "Topology is an overview, not a comprehensive monitoring tool." Set the same expectation for DorkOS — it's a quick health glance, not a full observability platform.

---

### Health Monitoring Patterns

**Recommended state machine:**

```
ACTIVE → INACTIVE → STALE
  (5 min)    (30 min)
```

- `last_seen_at` is updated on: agent registration, explicit heartbeat publish, any Relay message from the agent.
- Status is **computed at query time**, not stored — avoids needing a background job to transition states.
- Lifecycle events are published via Relay to `mesh.agent.lifecycle.*` for real-time SSE clients.
- Thresholds are module constants (`ACTIVE_THRESHOLD_MS = 5 * 60 * 1000`, `STALE_THRESHOLD_MS = 30 * 60 * 1000`) — configurable via env or server config in the future.
- SQLite migration adds `last_seen_at TEXT` and `last_seen_event TEXT` columns to the existing `agents` table.

**Heartbeat vs. message-based:**
Use message-based as the primary mechanism (zero overhead, leverages existing Relay traffic). Add an optional explicit heartbeat (`POST /api/mesh/agents/:id/heartbeat`) for agents that are idle but want to stay `active`.

---

### Graph Layout Recommendations

For 10–50 agents in a single-machine mesh:

1. **Default: Dagre (left-to-right tree)** — fast, deterministic, zero configuration. The React Flow dagre example is copy-paste ready.
2. **Optional: ELK with grouping** — groups by `runtime` attribute, showing Claude Code cluster vs. Cursor cluster vs. Codex cluster. Requires elkjs npm install and slightly more configuration.
3. **Avoid force-directed as default** — non-deterministic layout causes layout thrash on every load or data refresh, which is disorienting in a health monitoring context.
4. **Zoom/pan**: React Flow provides this out of the box (`<Controls />` component adds zoom in/out/fit buttons).
5. **Auto-fit on load**: Call `fitView()` after nodes are set so all agents are visible regardless of count.

---

### Security Considerations

- The topology endpoint (`GET /api/mesh/topology`) returns all registered agent paths. Apply the same directory boundary validation (`lib/boundary.ts`) used on other path-returning endpoints.
- The heartbeat endpoint (`POST /api/mesh/agents/:id/heartbeat`) should validate the agent ID exists before updating — prevent phantom registrations.
- Lifecycle SSE stream (`GET /api/mesh/lifecycle/stream`) should be feature-flag guarded by `isMeshEnabled()` like other mesh routes.
- No authentication/authorization is currently applied to DorkOS API routes (single-user tool), so no additional concerns beyond what already exists.

---

### Performance Considerations

- **React Flow for 10–50 nodes**: No memoization tricks are needed at this scale. Apply `React.memo` to the custom node component as a good habit, but React Flow's built-in viewport culling is not needed until 200+ nodes.
- **Health computation**: Compute status at query time with `Date.now() - new Date(last_seen_at).getTime()`. This is a microsecond operation. No caching needed.
- **SSE lifecycle stream**: One SSE connection per client for lifecycle events. Use the same `SessionBroadcaster` pattern already in the codebase: chokidar file watch or Relay subscription → debounce → SSE broadcast.
- **Polling vs. SSE for health data**: Poll `GET /api/mesh/health` every 30 seconds with TanStack Query's `refetchInterval`. No SSE needed for health summary — the update granularity is coarse.
- **Graph re-render on data update**: Use `useNodes` / `useEdges` from `@xyflow/react` + Zustand store to push updates without remounting the graph. Avoid storing the full `nodes[]` array in React state.

---

### Recommendation

**Recommended Graph Library:** `@xyflow/react` (React Flow v12)

**Rationale:** It is the only library in the evaluation that (a) has explicitly confirmed React 19 + Tailwind 4 compatibility, (b) allows custom node components to be full React components (enabling embedded shadcn/ui Badge, status dot, and agent metadata), (c) ships with first-party layout adapters (dagre, ELK) with copy-paste examples, and (d) has by far the strongest community and maintenance signals (2.9M weekly downloads, active xyflow org). For 10–50 nodes it is trivially within its performance envelope.

**Caveats:**
1. Confirm bundle size via `bundlephobia.com/@xyflow/react` before implementation — if it exceeds 200 KB gzipped, load it lazily with `React.lazy()` since the Topology tab is not on the critical path.
2. The `nodeTypes` constant must be declared outside the `ReactFlow` parent component or the graph will re-mount nodes on every render — this is a known React Flow footgun documented in their performance guide.
3. Import `@xyflow/react/dist/style.css` in `global.css` (not in a component file) per the Tailwind 4 migration notes.

---

## Search Methodology

- Number of searches performed: 13 web searches + 7 web fetches
- Most productive search terms: "React Flow v12 React 19 compatibility", "Kiali health", "@xyflow/react npm", "agent health state machine heartbeat threshold", "React Flow dagre ELK layout"
- Primary information sources: reactflow.dev, kiali.io, npmjs.com, GitHub (xyflow, cytoscape, plotly), Microsoft Learn, HashiCorp Developer, bundlephobia.com
