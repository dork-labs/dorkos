---
title: "Mesh Observability"
spec: 4
order: 3
status: in-progress
blockedBy: [2]
blocks: []
parallelWith: [3]
litepaperPhase: "Phase 3 — Observability"
complexity: medium
risk: low
estimatedFiles: 8-12
newPackages: []
primaryWorkspaces: ["apps/server", "apps/client", "packages/mesh"]
touchesServer: true
touchesClient: true
verification:
  - "Console shows agent network topology visualization (agents as nodes, relationships as edges)"
  - "Agent health status reflects last-seen timestamp and connectivity"
  - "MCP tools mesh_status, mesh_inspect provide diagnostic output"
  - "Agent lifecycle events (registered, unregistered, health change) are emitted as Relay signals"
  - "Mesh dashboard shows aggregate stats (total agents, by runtime, by project, errors)"
  - "Health tracking updates when agents send/receive Relay messages"
notes: >
  Can run in PARALLEL with Spec 3 (Network Topology) — they're independent
  additions to the Spec 2 foundation. This spec is focused purely on
  observability — making the mesh visible and inspectable. Agent activation
  (starting sessions when messages arrive) is NOT handled here — that's
  the responsibility of Relay's runtime adapters. The topology visualization
  can show whatever data exists — if Spec 3 has also been built, it shows
  namespace groupings and access rules; if not, it shows a flat agent list.
  The visualization should be additive, not dependent on Spec 3.
---

# Spec 4: Mesh Observability

## Prompt

```
Add observability and diagnostic tooling to @dorkos/mesh — topology visualization, agent health tracking, lifecycle events, and diagnostic commands.

This spec builds on the existing Mesh core library (Spec 1) and server integration (Spec 2). Discovery and registration work. Now we add the observability layer that makes the mesh visible and inspectable.

NOTE: Agent activation (starting sessions when messages arrive) is handled by Relay's runtime adapters, NOT by Mesh. Mesh is the phone book — it knows where agents live. Relay's runtime adapters are the phones — they know how to start a conversation. This spec focuses purely on observability.

GOALS:
- Build a Console topology visualization in the client Mesh panel — a network graph showing registered agents as nodes, with visual indicators for runtime type, health status, and capabilities. If network topology (Spec 3) is also built, show namespace groupings and access edges. The visualization should work with or without Spec 3.
- Implement agent health tracking — last-seen timestamps (updated when an agent sends or receives a Relay message), connectivity status (active/inactive based on recency). Store health state in Mesh's SQLite registry.
- Implement agent lifecycle events — registered, unregistered, health-changed. Emit as Relay ephemeral signals on relay.mesh.lifecycle.{agentId} so other components can subscribe.
- Add operational MCP tools:
  - mesh_status — aggregate mesh health (total agents, by runtime, by project, last scan time)
  - mesh_inspect — detailed view of a specific agent (manifest, health, Relay endpoint, recent messages)
- Add HTTP routes:
  - GET /api/mesh/status — aggregate mesh health stats
  - GET /api/mesh/agents/:id/health — agent health detail (last seen, message counts, status)
- Update the client Mesh panel:
  - Topology graph view (agents as nodes, connections as edges)
  - Agent health dashboard (status badges, last-seen times)
  - Aggregate stats overview (total agents, active, by runtime)

INTENDED OUTCOMES:
- Operators can see the entire agent mesh at a glance — who's registered, who's active, who's idle
- Lifecycle events are visible to the entire system through Relay signals
- Diagnostic tools (MCP + HTTP) provide deep inspection without opening the Console
- The topology visualization adapts to available data (with or without Spec 3's topology rules)

KEY DESIGN CHALLENGES:
- Topology visualization: What library to use for the network graph? Options:
  a) React Flow (most popular, good DX, supports custom nodes)
  b) D3-force (lower level, more control, heavier)
  c) Custom SVG (lightest, most work)
  The /ideate session should evaluate, considering existing dependencies.
- Health tracking: How to determine "active" vs "inactive" — based on last Relay message timestamp? Configurable threshold?
- Graph layout: How to arrange agents in the visualization — by project? by runtime? force-directed?

REFERENCE DOCUMENTS:
- meta/modules/mesh-litepaper.md — "Roadmap Phase 3: Observability"
- meta/modules/relay-litepaper.md — signal mode for ephemeral lifecycle events
- packages/relay/src/signal-emitter.ts — how Relay emits ephemeral signals

CODEBASE PATTERNS TO STUDY:
- packages/relay/src/signal-emitter.ts — SignalEmitter for lifecycle events
- apps/client/src/layers/features/pulse/ui/RunHistoryPanel.tsx — status badges, timeline UI (reference for agent health display)
- apps/client/src/layers/features/relay/ui/ActivityFeed.tsx — real-time event display (reference for lifecycle events)
- apps/client/src/layers/features/relay/ui/MessageRow.tsx — expandable detail cards (reference for agent inspection)

OUT OF SCOPE:
- Network topology ACL rules (Spec 3 — additive if present)
- Agent activation / session management (handled by Relay runtime adapters)
- Supervision / restart policies (handled by Relay runtime adapters)
- CLI commands (future — MCP tools and HTTP routes are sufficient for now)
- Multi-machine mesh (DorkOS is single-machine)
- Agent versioning or rollback
```

## Context for Review

This spec adds the observability layer. The /ideate exploration agent should focus on:
- `SignalEmitter` in `packages/relay/src/signal-emitter.ts` — how to emit lifecycle signals
- Existing client visualization patterns — any graph/chart components already in the codebase
- The Relay metrics endpoint — reference for aggregate stats patterns
- How RunHistoryPanel and ActivityFeed display status and events

The /ideate research agent should investigate:
- React network graph libraries (React Flow, Cytoscape.js, vis-network, Sigma.js) — evaluate for agent topology
- Dashboard design patterns for service mesh observability (Istio dashboard, Consul UI)
- Agent health monitoring patterns in multi-agent frameworks
- Graph layout algorithms for small networks (10-50 nodes)
