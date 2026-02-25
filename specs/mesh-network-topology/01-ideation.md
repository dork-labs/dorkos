---
slug: mesh-network-topology
number: 58
created: 2026-02-25
status: ideation
---

# Mesh Network Topology

**Slug:** mesh-network-topology
**Author:** Claude Code
**Date:** 2026-02-25
**Branch:** preflight/mesh-network-topology
**Related:** [Mesh Spec 3 Plan](../../docs/plans/mesh-specs/03-mesh-network-topology.md)

---

## 1) Intent & Assumptions

- **Task brief:** Add network topology and access control to @dorkos/mesh — project namespace isolation (default-allow within project, default-deny across projects), cross-project ACL rules, per-agent budget policies enforced by Relay, capability-based routing with filtered visibility (invisible boundaries), and topology query/configuration APIs.
- **Assumptions:**
  - Spec 1 (mesh core library — `packages/mesh/`) and Spec 2 (mesh server/client integration) are implemented and stable
  - Relay's `AccessControl` class and `BudgetEnforcer` exist and are functional as the policy engine
  - The `RelayBridge` in mesh currently creates Relay endpoints but does NOT write access rules — this is the gap Spec 3 fills
  - The `relay.agent.{projectName}.{agentId}` subject pattern from RelayBridge is the foundation for namespace-scoped ACLs
  - Recent Relay convergence commit (`c9a87fe`) migrated Pulse and Console to Relay transport — this is additive context but doesn't block Spec 3
- **Out of scope:**
  - Console topology visualization / network graph (Spec 4)
  - Lazy activation (Spec 4)
  - Supervision policies (Spec 4)
  - CLI commands (Spec 4)
  - Dynamic namespace reconfiguration (agents changing projects at runtime)

---

## 2) Pre-reading Log

- `docs/plans/mesh-specs/03-mesh-network-topology.md`: Spec 3 plan document. Lists three namespace derivation strategies (scan-root-relative, manifest-declared, directory proximity). Identifies Relay AccessControl as the policy engine. Verification criteria include invisible boundaries, dynamic ACL updates, and budget enforcement.
- `meta/modules/mesh-litepaper.md`: "Default-allow within a project. Default-deny across projects." Mesh depends on Relay (not vice versa). Discovery is passive; registration is the gate where Mesh writes ACL rules to Relay.
- `meta/modules/relay-litepaper.md`: Budget envelopes are immutable (can only shrink). AccessControl rules use NATS-style wildcard subjects and hot-reload from disk.
- `packages/relay/src/access-control.ts` (231 lines): Rules are `{ from, to, action, priority }`. Default-allow when no rules match. First match by priority wins. `addRule()` persists immediately to `access-rules.json`. Hot-reloads via chokidar.
- `packages/relay/src/relay-core.ts` (~859 lines): Composes EndpointRegistry, MaildirStore, SqliteIndex, AccessControl, BudgetEnforcer. `addAccessRule()` delegates to AccessControl. Checks access before every delivery.
- `packages/relay/src/budget-enforcer.ts` (78 lines): Pure functions. Checks hopCount < maxHops, no cycles, TTL not expired, callBudgetRemaining > 0. Returns updated budget.
- `packages/mesh/src/mesh-core.ts` (350 lines): Composes AgentRegistry, DenialList, RelayBridge, DiscoveryStrategies. `register()` calls `relayBridge.registerAgent()` at the end. Does NOT interact with Relay's AccessControl.
- `packages/mesh/src/relay-bridge.ts` (58 lines): Bridge to optional RelayCore. `registerAgent(manifest, projectPath)` creates endpoint at `relay.agent.{basename(projectPath)}.{agentId}`. Does NOT write access rules.
- `packages/mesh/src/agent-registry.ts` (236 lines): SQLite-backed. Schema: id, name, description, project_path (UNIQUE), runtime, capabilities_json, manifest_json, registered_at, registered_by. No namespace column yet.
- `apps/server/src/routes/mesh.ts` (147 lines): Nine endpoints for discovery, registration, agents CRUD, denial. No topology or access control endpoints.
- `apps/server/src/services/core/mcp-tool-server.ts`: MCP tools include mesh_discover, mesh_register, mesh_deny, mesh_list, mesh_unregister, mesh_update. No mesh_query_topology yet.
- `packages/shared/src/mesh-schemas.ts` (153+ lines): AgentManifest, AgentBudget (maxHopsPerMessage, maxCallsPerHour), DiscoveryCandidate, DenialRecord. No namespace or topology schemas.
- `packages/shared/src/relay-schemas.ts` (200+ lines): RelayAccessRule (from, to, action, priority), RelayBudget, RelayEnvelope.
- `apps/client/src/layers/features/mesh/ui/MeshPanel.tsx`: Three tabs — Discovery, Registered Agents, Denied. No topology tab.
- `apps/client/src/layers/entities/mesh/`: Eight TanStack Query hooks for mesh operations. No topology or access hooks.
- `decisions/0011-use-nats-style-subject-matching.md`: ADR establishing NATS-style subject matching in Relay — directly relevant to ACL subject patterns.
- `decisions/0014-use-sliding-window-log-for-rate-limiting.md`: ADR for rate limiting algorithm — reusable for per-agent call budget enforcement.
- `decisions/0016-structured-publishresult-rejections.md`: ADR for structured rejection responses — budget violations should use this pattern.

---

## 3) Codebase Map

**Primary Components/Modules:**

| File | Role |
|------|------|
| `packages/mesh/src/mesh-core.ts` | Orchestrates discovery → registration lifecycle. Entry point for all mesh operations. |
| `packages/mesh/src/relay-bridge.ts` | Creates/removes Relay endpoints when agents are registered. Currently does NOT write access rules. |
| `packages/mesh/src/agent-registry.ts` | SQLite persistence for registered agents. No namespace column yet. |
| `packages/relay/src/access-control.ts` | Policy engine. Evaluates allow/deny rules against (from, to) subject pairs. |
| `packages/relay/src/relay-core.ts` | Main message bus. Delegates to AccessControl before every delivery. |
| `packages/relay/src/budget-enforcer.ts` | Enforces budget constraints (maxHops, callBudget, TTL) before delivery. |
| `apps/server/src/routes/mesh.ts` | HTTP endpoints for mesh operations. |
| `apps/server/src/services/core/mcp-tool-server.ts` | MCP tools for agent use. |
| `packages/shared/src/mesh-schemas.ts` | Zod schemas for mesh types and API validation. |
| `apps/client/src/layers/features/mesh/` | UI components for mesh panel. |
| `apps/client/src/layers/entities/mesh/` | TanStack Query hooks for mesh data fetching. |

**Shared Dependencies:**

- `@dorkos/shared` — mesh-schemas, relay-schemas, types
- `@dorkos/relay` — RelayCore, AccessControl, BudgetEnforcer
- `better-sqlite3` — persistence (AgentRegistry, Relay SqliteIndex)
- `chokidar` — hot-reload for AccessControl rules file
- TanStack Query — client data fetching
- Zod — validation and OpenAPI generation

**Data Flow:**

```
Agent Discovery → MeshCore.register() → AgentRegistry.insert()
                                       → RelayBridge.registerAgent()
                                           → RelayCore.registerEndpoint()
                                           → [GAP] RelayCore.addAccessRule()  ← Spec 3 fills this
                                           → [GAP] Budget mapping             ← Spec 3 fills this

Message Delivery → RelayCore.publish()
                    → AccessControl.checkAccess(from, to)  ← rules authored by Mesh
                    → BudgetEnforcer.enforceBudget()        ← constraints from manifest
                    → deliver or reject

Topology Query → MeshCore.list(callerNamespace)
                  → filter by access rules (invisible boundary)
                  → return only visible agents
```

**Feature Flags/Config:**

- `DORKOS_MESH_ENABLED` — controls mesh feature (mesh-state.ts)
- `DORKOS_RELAY_ENABLED` — controls relay feature (relay-state.ts)
- Both independently toggleable

**Potential Blast Radius:**

- **Direct (new files):** ~5 new files (namespace-resolver, topology module, 2 client hooks, 1 UI panel)
- **Direct (modified):** ~8 files (mesh-core, relay-bridge, agent-registry, mesh routes, MCP tools, mesh-schemas, MeshPanel, entity index)
- **Indirect:** relay-core.ts (called via addAccessRule), test files
- **Tests:** ~4 new test files, ~3 modified test files

---

## 4) Root Cause Analysis

N/A — this is a feature addition, not a bug fix.

---

## 5) Research

Research agent consulted 24 sources including Kubernetes NetworkPolicy, Istio AuthorizationPolicy, Consul Intentions, NATS accounts, OWASP BOLA guidance, and LiteLLM budget hierarchies.

### Potential Solutions

**1. Scan-Root Namespace + Namespace-to-Namespace ACLs**
- Description: Namespace from first path segment after scan root. ACL rules as flat `(source_ns, dest_ns, action)`. Default same=allow, cross=deny.
- Pros: Zero config, simple schema, minimal code
- Cons: Coarse (all-or-nothing per project pair), no escape hatch if directory structure doesn't match logical boundaries, fragile if scan roots change
- Complexity: Low | Maintenance: Low

**2. Hybrid Namespace + Subject-Pattern ACLs (Selected)**
- Description: Filesystem-derived namespace with optional manifest override. ACL rules use NATS-style subject patterns reusing ADR 0011 matching. 404 invisible boundary for cross-namespace queries.
- Pros: Zero-config for common case, flexible override for edge cases, reuses ADR 0011/0014/0016 infrastructure, security-correct invisible boundary, incremental implementation path
- Cons: Medium complexity, manifest schema change (optional namespace field), ACL engine adds ~200 lines
- Complexity: Medium | Maintenance: Medium

**3. Git-Remote Namespace + RBAC Roles**
- Description: Parse `git remote get-url origin` for globally unique namespace. Assign roles to agents for capability-scoped ACLs.
- Pros: Globally unique namespace, survives directory relocation
- Cons: Requires git and shell execution during discovery, role management complexity, doesn't work for non-git projects
- Complexity: High | Maintenance: High

**4. Pure Manifest Namespace + Capability-Gated ABAC**
- Description: All agents declare namespace and capabilities. Rules gate by capability across namespaces.
- Pros: Fully explicit, semantically rich policy
- Cons: Breaks zero-config auto-discovery, requires capability taxonomy, complex policy engine
- Complexity: Very High | Maintenance: Very High

### Security Considerations

- Return 404 (not 403) for cross-namespace agents — OWASP BOLA principle prevents enumeration
- Namespace is confirmed by the operator at registration, not solely by the agent manifest (prevents spoofing)
- Budget caps at namespace level prevent one agent from exhausting shared quotas
- Current RelayBridge uses `basename(projectPath)` — must use canonical namespace to prevent collisions between same-named directories in different roots

### Performance Considerations

- Namespace lookup per message dispatch should be cached in-memory (namespace is stable post-registration)
- ACL rule table needs index on `(source_namespace, destination_namespace)` for O(log n) lookup
- Budget counter writes (sliding window) add one SQLite write per dispatch; WAL mode handles this
- `MeshCore.list()` ACL filtering adds one lookup per unique namespace in the result set — negligible with indexing

### Recommendation

**Recommended:** Solution 2 — Hybrid Filesystem + Manifest Namespace with Subject-Pattern ACLs. Maximizes reuse of existing Relay infrastructure, provides zero-config for the common case, and is security-correct per OWASP guidance.

---

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Namespace derivation strategy | Hybrid: filesystem-derived with manifest override | Default namespace from first path segment after scan root (e.g., `~/projects/dorkos/core` discovered from `~/projects` → namespace `dorkos`). Optional `namespace` field in `.dork/agent.json` overrides. Operator confirms at registration. Zero-config for common case, explicit when needed. Mirrors Kubernetes topology-derived namespaces and Docker Compose project naming. |
| 2 | ACL rule granularity | Namespace-to-namespace with NATS-style subject patterns | Rules expressed as `relay.agent.projectA.* → relay.agent.projectB.*`. Reuses ADR 0011 subject-matching already in Relay. Same-namespace default-allow, cross-namespace default-deny. Simple mental model: "project A can talk to project B." Can be refined to agent-level later. |
| 3 | ACL rule authorship | Any principal can author rules | Maximum autonomy — both human and agent principals can create/modify ACL rules directly. No approval queue. Simplifies implementation and enables fully autonomous agent networks. |
| 4 | Budget enforcement approach | Map manifest budgets to Relay budget enforcement | Agent manifest `maxHopsPerMessage` maps to Relay's `maxHops` budget field. `maxCallsPerHour` enforced via sliding window counters (reusing ADR 0014 algorithm) in a `budget_counters` SQLite table. Leverages existing BudgetEnforcer. Project-level caps deferred to a future spec. |
