---
title: "Mesh Network Topology"
spec: 3
order: 3
status: in-progress
blockedBy: [2]
blocks: []
parallelWith: [4]
litepaperPhase: "Phase 2 — Network Topology"
complexity: high
risk: medium
estimatedFiles: 10-15
newPackages: []
primaryWorkspaces: ["packages/mesh", "packages/relay", "apps/server", "apps/client"]
touchesServer: true
touchesClient: true
verification:
  - "Agents in the same project namespace can message each other through Relay (default-allow)"
  - "Agents in different projects are blocked by default (default-deny cross-project)"
  - "Cross-project access can be explicitly allowlisted via Mesh configuration"
  - "Budget policies per agent are enforced by Relay (maxHops, callBudget from manifest)"
  - "Invisible boundaries — unauthorized agents get 'not found', not 'forbidden'"
  - "MCP tool mesh_query_topology returns the agent's view of the network (filtered by access)"
  - "Client topology configuration UI allows editing cross-project access rules"
  - "ACL changes take effect without restarting Mesh or Relay"
  - "All existing Relay tests still pass (no regressions)"
notes: >
  Can run in PARALLEL with Spec 4 (Observability & Lifecycle) — they're
  independent additions to the Spec 2 foundation. This spec deepens the
  Mesh-Relay integration from basic endpoint registration (Spec 1) to full
  access control. The key complexity is namespace derivation — how does Mesh
  determine which "project" an agent belongs to? The litepaper says
  "default-allow within a project" but doesn't define the project boundary.
  The /ideate session must resolve this. Also study Relay's existing
  AccessControl module (packages/relay/src/access-control.ts) carefully —
  Mesh writes rules in the format Relay already understands.
---

# Spec 3: Mesh Network Topology

## Prompt

```
Add network topology and access control to @dorkos/mesh — namespace isolation, cross-project ACL rules, budget policies, and capability-based routing with filtered visibility.

This spec builds on the existing Mesh core library (Spec 1) and server integration (Spec 2). Discovery and registration work. Now we add the policy layer that makes the agent network safe for autonomous operation.

GOALS:
- Implement project namespace derivation — determine which "project" each registered agent belongs to, based on filesystem location and/or manifest metadata. Agents in the same project form an implicit trust group.
- Implement default network policy — default-allow within a project namespace, default-deny across project namespaces. Write these as Relay AccessControl rules when agents are registered.
- Implement cross-project access configuration — an explicit allowlist for which projects can communicate with which other projects. Stored in Mesh config, written to Relay ACL.
- Implement per-agent budget policies — maxHops and callBudget from the agent manifest are enforced as Relay budget constraints on that agent's endpoint.
- Implement invisible boundaries — when an agent queries the registry (mesh_list, mesh_query_topology), filter results based on the querying agent's access. Unauthorized agents don't see restricted agents at all. "Not found", not "forbidden."
- Add MCP tool: mesh_query_topology — returns the requesting agent's view of the network (which agents it can see and message, which projects are accessible)
- Add HTTP routes for topology configuration:
  - GET /api/mesh/topology — current network topology (namespaces, access rules)
  - PUT /api/mesh/topology/access — update cross-project access rules
  - GET /api/mesh/agents/:id/access — which agents this agent can reach
- Update the client Mesh panel with topology configuration:
  - Namespace overview showing agents grouped by project
  - Cross-project access rule editor (allowlist management)
  - Per-agent budget policy editor
- Ensure ACL changes are applied dynamically — updating a cross-project rule in Mesh immediately updates Relay's access control without restart

INTENDED OUTCOMES:
- Agents within the same project communicate freely through Relay without any configuration
- Cross-project communication is blocked by default and requires explicit allowlisting
- An agent's budget constraints (from its manifest) are enforced by Relay for every message
- Agents only see other agents they're authorized to communicate with — invisible boundaries
- The topology is configurable through the client UI, MCP tools, and HTTP API
- All access control is ultimately enforced by Relay — Mesh is the policy author, Relay is the policy engine

KEY DESIGN CHALLENGES:
- Namespace derivation: How to determine the "project" boundary. Options include:
  a) Scan root-relative: agents under the same scan root subdirectory share a namespace
  b) Manifest-declared: agents explicitly declare their project in .dork/agent.json
  c) Directory proximity: agents within N levels of a common parent share a namespace
  The /ideate session should evaluate these and decide.
- Access rule granularity: project-to-project? agent-to-agent? subject-pattern-based?
- How capability-based routing respects access control: mesh_list with capability filter should only return agents the requester can reach

REFERENCE DOCUMENTS:
- meta/modules/mesh-litepaper.md — "Network Topology and Access Control" section, "Invisible boundaries" concept
- meta/modules/relay-litepaper.md — budget envelopes, delivery guarantee, access control
- packages/relay/src/access-control.ts — Relay's existing ACL implementation (understand the rule format before writing new rules)
- packages/relay/src/budget-enforcer.ts — how Relay enforces budgets

CODEBASE PATTERNS TO STUDY:
- packages/relay/src/access-control.ts — AccessControl class, rule format (from, to, action, priority)
- packages/relay/src/relay-core.ts — addAccessRule() method, how rules are evaluated before delivery
- packages/relay/src/budget-enforcer.ts — budget enforcement at delivery time
- packages/mesh/src/ (from Spec 1) — MeshCore API, registry queries, Relay integration points
- apps/server/src/routes/mesh.ts (from Spec 2) — existing route patterns to extend
- apps/client/src/layers/features/mesh/ (from Spec 2) — existing UI to extend

OUT OF SCOPE:
- Console topology visualization / network graph (Spec 4)
- Lazy activation (Spec 4)
- Supervision policies (Spec 4)
- CLI commands (Spec 4)
- Dynamic namespace reconfiguration (agents changing projects)
```

## Context for Review

This spec deepens the Mesh-Relay integration from basic registration to full network policy. The /ideate exploration agent should focus on:
- Relay's `AccessControl` class — how rules are stored, evaluated, and matched
- Relay's `BudgetEnforcer` — how budget constraints are checked before delivery
- The `addAccessRule()` method on `RelayCore` — how Mesh should call it
- The existing Mesh code from Spec 1 — where namespace and ACL logic fits in

The /ideate research agent should investigate:
- Network namespace patterns in container orchestration (Kubernetes network policies, Docker networks)
- Service mesh access control (Istio authorization policies, Consul intentions)
- Zero-trust network patterns adapted for agent systems
- Capability-based access control vs role-based access control for agent networks
- "Invisible boundary" patterns (how Microsoft Teams, Slack Enterprise Grid handle tenant isolation)
