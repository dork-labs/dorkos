# Research: Mesh Network Topology and Access Control

**Date**: 2026-02-25
**Topic**: Network namespace isolation, cross-project ACL rules, budget policies, and capability-based routing for @dorkos/mesh
**Mode**: Deep Research
**Sources consulted**: 14 searches, 8 source domains

---

## Research Summary

The DorkOS mesh feature needs project-scoped namespace isolation — agents within the same project communicate freely, cross-project communication is blocked by default unless explicitly allowlisted. The industry has solved analogous problems in Kubernetes (NetworkPolicy), service meshes (Istio AuthorizationPolicy, Consul Intentions, Linkerd workload identity), NATS (account-scoped subject namespaces), and multi-tenant SaaS systems (AWS Organizations SCPs). The cleanest analogue for DorkOS is NATS accounts + Consul Intentions: declare a project namespace derived from filesystem topology, enforce default-deny between namespaces, and use explicit ACL rules for cross-namespace allowlisting. For budgets, LiteLLM's hierarchical model (project → agent → key) is directly applicable.

---

## Key Findings

### 1. Namespace Derivation

The fundamental question is: what determines which "project" an agent belongs to? The industry offers two mental models:

**Topology-derived (Kubernetes, Docker)**: Membership is inferred from physical location (namespace = Kubernetes namespace determined by where the pod runs). No agent self-declaration required.

**Identity-declared (Consul, NATS)**: Each service/user explicitly belongs to an account or namespace. Namespace is encoded in the credential, not the location.

For DorkOS, the filesystem IS the topology. Agents have a `projectPath` already stored in the SQLite registry. The natural namespace is derivable from that path relative to a scan root. If an agent lives at `/home/user/projects/dorkos/core` and was discovered from a root of `/home/user/projects`, then its namespace token is `dorkos` (or `dorkos/core` if deeper granularity is desired).

**The hybrid approach** (filesystem-derived with manifest override) is recommended. Derive the namespace from the common ancestor path relative to the scan root, but allow `.dork/agent.json` to declare `namespace: "my-project"` to override the default. This mirrors how Docker Compose handles project names: default = directory name, override = `COMPOSE_PROJECT_NAME`.

### 2. Access Control Patterns

**Kubernetes NetworkPolicy** establishes the gold standard for default-deny namespace isolation:
- By default, all pods accept all traffic (default-allow)
- Once a NetworkPolicy selects a pod, only explicitly allowed traffic passes
- Cross-namespace traffic requires both: a pod selector in the source namespace AND a namespace selector that matches the destination
- This "double-allow" model is important: both sides must agree

**Istio AuthorizationPolicy** adds semantic richness:
- Mesh-wide, namespace-wide, or workload-specific scopes
- Source principal matching (workload identity, not IP addresses)
- Deny rules take priority over allow rules
- A single empty `DENY` policy at the root namespace blocks everything

**Consul Intentions** is the most analogous for DorkOS:
- Default: configure a default-deny intention policy for the entire mesh
- Intentions are service-to-service (not pod-to-pod), matching DorkOS agents
- Intentions compose: wildcard `*` allows any service in a namespace to reach another namespace's `*` or specific service
- Namespace-scoped intentions: `source_namespace: "project-a"` → `destination_namespace: "project-b"` with allow/deny action
- Consul stores intentions in the catalog, DorkOS stores them in SQLite ACL rules table

**NATS Accounts** are the tightest analogue for subject-based messaging:
- Each account has its own isolated subject namespace — `foo` in account A does not reach subscribers in account B
- Cross-account access requires explicit export (from source account) + import (from destination account) declarations
- This is exactly what DorkOS needs: `relay.agent.project-a.*` is invisible to agents in `project-b` unless explicitly imported

**OWASP 404 vs 403 principle**: When an agent in project-A queries the mesh for agents in project-B, it should receive a 404 (not found) rather than a 403 (forbidden). Returning 403 reveals that the agent exists but is inaccessible — a form of information disclosure. Returning 404 makes cross-project agents invisible. This is explicitly documented in OWASP BOLA (Broken Object Level Authorization) guidance. The "invisible boundary" principle is used by GitHub Enterprise (repos from other orgs don't appear in search), AWS Organizations (cross-account resources are simply not visible without explicit sharing), and Slack Enterprise Grid (workspaces from other organizations are opaque).

### 3. Budget Policy Patterns

**LiteLLM's hierarchical budget model** (Organization → Team → User → Key → End User) directly maps to DorkOS:

```
scan-root (global budget)
  └── project-namespace (project budget)
        └── agent (agent budget from manifest)
              └── individual message (per-message hop/token cap)
```

Key design decisions from LiteLLM:
- Child budgets cannot exceed parent budgets (guaranteed throughput enforcement)
- Budget counters are stored separately from the resource definition (in Redis/SQLite, not in the manifest)
- Rate limits and spend limits are separate dimensions: RPM/TPM (rate) vs total spend (cumulative)

For DorkOS, the existing `AgentBudget` schema already has `maxHopsPerMessage` and `maxCallsPerHour`. The gap is:
1. No project-level budget that caps the sum of all agents in a project
2. No enforcement mechanism (the budget is declared but never checked)
3. No budget counter persistence (where do you store current usage?)

**Token bucket vs sliding window**: For `maxCallsPerHour`, a sliding window log is already used by the Relay subsystem (ADR 0014). The same pattern should be reused for Mesh budget enforcement. For hop counting per-message, a simple in-flight counter suffices — increment on dispatch, decrement on completion.

**Budget exceeded behavior**: The three options (reject, queue, degrade) map to:
- **Reject**: Return a structured `PublishResult` rejection (ADR 0016 pattern already exists in Relay)
- **Queue**: Hold the message until budget resets — adds complexity
- **Degrade**: Allow but flag as over-budget — dangerous for cost control

Recommendation: reject with a structured error, matching the existing Relay rejection pattern.

### 4. Capability-Based Routing

The A2A protocol (Google, now Linux Foundation) publishes each agent's `/.well-known/agent.json` listing its skills. DorkOS already has `capabilities: string[]` in `AgentManifest`. Capability-based routing means:
- A requesting agent declares what capability it needs ("code-review", "deploy", "budget-approval")
- The mesh routes to agents that declare that capability
- Access control then filters: does the requesting agent's project have ACL permission to reach any agent with that capability in the target project?

This decouples routing logic from ACL logic cleanly. Routing = "who can do this?"; ACL = "are you allowed to ask them?".

---

## Detailed Analysis

### Namespace Derivation Approaches

**Option A: Scan-root-relative path segment**

```
scan_root: /home/user/projects
agent_path: /home/user/projects/dorkos/core
namespace: "dorkos"  (first path segment after scan root)
```

Implementation: when `MeshCore.discover(roots)` is called, the first path component after each root becomes the namespace. Store `namespace` in the `agents` SQLite table.

Pros:
- Zero configuration — derived automatically from filesystem topology
- Consistent with how projects are naturally organized (one git repo = one directory = one project)
- No manifest changes required for existing agents
- Directly mirrors how Kubernetes assigns namespace (where you deploy determines your namespace)

Cons:
- Breaks if agents span multiple directories
- Flat (one level deep) — no sub-project grouping
- Ambiguous if discovery roots overlap or nest
- Doesn't survive agent relocation

**Option B: Manifest-declared namespace**

```json
// .dork/agent.json
{
  "namespace": "dorkos",
  "id": "01JKABC..."
}
```

Pros:
- Explicit and unambiguous
- Survives relocation
- Supports agents in non-standard directory layouts
- Enables multiple agents in the same directory to belong to different projects

Cons:
- Requires agents to know their namespace at registration time
- Manual for auto-discovered agents (hints won't know the namespace)
- Creates a chicken-and-egg problem: who sets the namespace?

**Option C: Git remote URL as namespace**

Parse `git remote get-url origin` in the project directory and extract the repo path as the namespace (e.g., `doriancollier/dork-os`). Git repos are already the natural unit of project identity.

Pros:
- Globally unique
- Survives directory relocation
- Natural alignment with "project" in software development

Cons:
- Requires git to be present
- Non-git projects have no namespace
- Remote URL can change (repo rename, fork, migration)
- Requires shell execution during discovery

**Option D: Hybrid (filesystem-derived with manifest override)**

Default to scan-root-relative path segment, allow `.dork/agent.json` to declare `namespace` to override. If the agent has a `.git` directory, optionally use the git remote as a secondary derivation.

This is the recommended approach. It gives zero-config behavior for the common case, explicit escape hatch for edge cases, and mirrors Docker Compose's project naming convention.

---

### Access Control Granularity

There are four levels of ACL granularity to choose from:

**Level 1: Namespace-to-namespace (coarse)**

```
ALLOW project-a → project-b
DENY project-c → *
```

Simplest to reason about. One rule covers all agents in both projects. This is what Consul Intentions does at namespace scope. Sufficient for 80% of use cases.

**Level 2: Agent-to-agent (fine)**

```
ALLOW agent:01JKABC → agent:01JKXYZ
```

Maximum granularity. Becomes unmanageable as agent count grows. Analogous to Kubernetes pod-to-pod NetworkPolicy — powerful but complex.

**Level 3: Subject-pattern (NATS-style)**

```
ALLOW project-a.* → relay.agent.project-b.*
ALLOW agent:01JKABC → relay.agent.project-b.01JKXYZ
```

Flexible. Patterns can match all agents in a namespace or individual agents. Already aligned with the Relay subject naming scheme (`relay.agent.{project}.{agentId}`).

**Level 4: Capability-gated (ABAC-flavored)**

```
ALLOW project-a → capability:code-review IN project-b
```

Routes to agents that declare a capability and grants access in one rule. Requires capability awareness in the ACL engine.

**Recommendation**: Start with Level 1 (namespace-to-namespace) plus Level 3 subject patterns. These two together cover the common cases without requiring Level 2 complexity. Level 4 can be added as a query-time filter on top of Level 1/3 rules.

---

### Invisible Boundary Implementation

The OWASP principle: unauthorized resources should return 404, not 403. This prevents information leakage about the existence of cross-project agents.

Implementation pattern for `MeshCore.list()`:

```typescript
// Current: returns all agents regardless of caller
list(filters?: { runtime?: AgentRuntime; capability?: string }): AgentManifest[]

// Target: caller's namespace filters results
list(filters?: { runtime?: AgentRuntime; capability?: string }, callerNamespace?: string): AgentManifest[]
```

When `callerNamespace` is provided:
1. Filter to own-namespace agents (always visible)
2. Check ACL rules for cross-namespace allows
3. Include cross-namespace agents that pass ACL check
4. Return the filtered list — excluded agents are not mentioned, not even as "forbidden"

For the HTTP layer (`routes/mesh.ts`), the caller's identity comes from the requesting agent's ID (from the X-Client-Id header or Relay sender identity). The server looks up the caller's namespace from the registry and passes it to `MeshCore.list()`.

---

### Relay Subject Naming and ACL Integration

The current `RelayBridge` uses:
```
relay.agent.{basename(projectPath)}.{agentId}
```

With namespace support this becomes:
```
relay.agent.{namespace}.{agentId}
```

The namespace replaces `basename(projectPath)`, which is fragile (two different projects in different roots could have the same basename). The namespace (derived from scan root or manifest) is canonical.

Relay's existing `addAccessRule()` method (if it exists on `RelayCore`) should be called at registration time:

```typescript
// When registering agent B in project-b, add intra-project access rule:
await relayCore.addAccessRule({
  source: `relay.agent.project-b.*`,
  destination: `relay.agent.project-b.${agentId}`,
  action: 'allow'
});

// Cross-project rules are added separately when the human explicitly allowlists:
await relayCore.addAccessRule({
  source: `relay.agent.project-a.*`,
  destination: `relay.agent.project-b.${agentId}`,
  action: 'allow'
});
```

---

### Budget Enforcement Architecture

The existing `AgentBudget` in `AgentManifest` declares limits. Enforcement requires:

1. **Counter storage**: A new SQLite table `budget_counters` in `mesh.db`:
   ```sql
   CREATE TABLE budget_counters (
     agent_id TEXT NOT NULL,
     window_start INTEGER NOT NULL,  -- unix epoch seconds
     call_count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (agent_id, window_start)
   );
   ```

2. **Project-level budget**: A new `ProjectPolicy` table or embedded in a `namespace_policies` table:
   ```sql
   CREATE TABLE namespace_policies (
     namespace TEXT PRIMARY KEY,
     max_calls_per_hour INTEGER,
     max_agents INTEGER,
     cross_namespace_default TEXT NOT NULL DEFAULT 'deny'
   );
   ```

3. **Enforcement point**: In `RelayBridge.registerAgent()`, before dispatching to RelayCore, check the sliding window counter. If `callCount >= maxCallsPerHour`, return a rejection.

4. **Hierarchy enforcement**: Check project budget before agent budget. If the project has consumed its total quota, reject even if the individual agent is under its limit.

This mirrors LiteLLM's `guaranteed_throughput` mode where child budgets sum cannot exceed parent budget.

---

## Potential Solutions

### 1. Scan-Root Namespace with Namespace-to-Namespace ACLs (Simple)

**Description**: Derive namespace from the first path segment after the scan root. Store namespace in the `agents` table. Add a `namespace_acl_rules` SQLite table with `(source_namespace, destination_namespace, action)` tuples. Default: same-namespace = allow, cross-namespace = deny. Human adds explicit allowlist rules via the console UI.

**Pros**:
- Zero config for the common case
- Simple ACL model — operators understand "project A can talk to project B"
- Small schema addition (one new table)
- No manifest changes required

**Cons**:
- Coarse granularity — all agents in project A can reach all agents in project B (or none)
- Namespace derived from scan root is fragile if roots change
- No per-agent overrides

**Complexity**: Low (3–4 new files, 1 new SQLite table migration, 1 new ACL engine)
**Maintenance**: Low — namespace rules are human-readable, few moving parts

---

### 2. Hybrid Filesystem + Manifest Namespace with Subject-Pattern ACLs (Recommended)

**Description**: Namespace defaults to scan-root-relative path segment, overridable in `.dork/agent.json` via a `namespace` field. ACL rules use NATS-style subject patterns: `relay.agent.project-a.*` → `relay.agent.project-b.*`. Same-namespace traffic is implicitly allowed. Cross-namespace requires an explicit rule. `MeshCore.list()` filters results by caller namespace + ACL rules, returning 404 for invisible agents.

**Pros**:
- Zero-config for common case, explicit override for edge cases
- Subject patterns are expressive — can allow all-agents to all-agents, or one specific agent to one specific agent
- Aligns with existing Relay subject naming scheme
- Invisible boundary (404) prevents information leakage
- Extensible to capability-based routing by adding subject capability patterns

**Cons**:
- Medium complexity — namespace derivation logic, ACL engine, schema migration
- Manifest change: adding optional `namespace` field to `AgentManifest`
- Subject pattern matching logic needs to be implemented (or reused from Relay's existing NATS-style matching — ADR 0011)

**Complexity**: Medium (5–7 new files, 2 new SQLite tables, namespace derivation logic, ACL engine)
**Maintenance**: Medium — subject patterns are slightly harder to reason about than project-to-project names, but much more flexible

---

### 3. Git-Remote-Based Namespace with RBAC Agent Roles (Complex)

**Description**: Parse `git remote get-url origin` to derive a globally unique namespace. Assign roles to agents (e.g., `reviewer`, `deployer`, `approver`). ACL rules specify which roles can communicate with which roles across which namespaces.

**Pros**:
- Globally unique namespace — no collision risk
- Role-based access is familiar to operators
- Survives directory relocation

**Cons**:
- Requires git to be present — non-git projects excluded
- Shell execution during discovery adds latency and failure modes
- Roles add significant management complexity
- Role assignment is a separate operational concern

**Complexity**: High (8+ new files, role management system, git integration)
**Maintenance**: High — role assignments become stale, require audit trails

---

### 4. Pure Manifest-Declared Namespace with Capability-Gated ABAC (Future State)

**Description**: Agents declare `namespace` and `capabilities` in `.dork/agent.json`. ACL rules gate access by capability: `ALLOW project-a → capability:code-review IN project-b`. The mesh routes to agents in project-b that declare `code-review` and that project-a has permission to reach.

**Pros**:
- Fully explicit — no ambiguity
- Capability-gated access is expressive and semantically rich
- Enables agent-to-agent permission negotiation

**Cons**:
- Requires all agents to declare namespace (breaks auto-discovery for unknown agents)
- Capability taxonomy needs to be standardized
- ABAC policy evaluation is significantly more complex than ACL rules
- No existing agents declare namespace — all existing registrations would need migration

**Complexity**: Very High
**Maintenance**: Very High — capability taxonomy drift, policy complexity

---

## Security Considerations

1. **Information leakage via 403**: Always return 404 when an agent in namespace A queries for an agent in namespace B that they cannot see. Returning 403 reveals the agent exists. This is the OWASP BOLA principle applied to agent registries.

2. **Namespace spoofing**: If namespace is derived from the manifest (`namespace` field in `.dork/agent.json`), an adversarial agent could declare itself as belonging to another project's namespace. Mitigations:
   - Namespace field in manifest is advisory only; canonical namespace comes from the scan root topology at registration time
   - Manifest-declared namespace is only trusted if the registrar explicitly set it (not if auto-imported)
   - Alternatively: namespace is set by the DorkOS operator, not the agent itself

3. **ACL rule injection**: If agents can write ACL rules (via `relay_send` or `mesh_register` MCP tools), they could grant themselves cross-project access. Mitigations:
   - ACL rules can only be created by `human:console` or `human:cli` principals
   - Agent-created ACL rules enter `pending_approval` state (same as Pulse schedule pattern, ADR 0009)

4. **Budget exhaustion attacks**: An agent with high `maxCallsPerHour` could consume the project's total budget, starving other agents. Mitigation: project-level budget cap that takes precedence over per-agent limits.

5. **ULID predictability**: Agent IDs are ULIDs (lexicographically sortable). An attacker who knows the approximate registration timestamp could enumerate agent IDs in sequence. Mitigation: this is acceptable — ULIDs are not secrets, they are identifiers. Access control is on namespace + ACL, not on ID obscurity.

---

## Performance Considerations

1. **Namespace lookup on every message**: Each Relay message dispatch needs to resolve the sender's namespace and check ACL rules. This must be fast. Implementation: cache the sender's namespace in memory (namespace is stable once registered), cache ACL rules in-memory (invalidate on rule change).

2. **SQLite ACL table read patterns**: The ACL query `SELECT * FROM namespace_acl_rules WHERE source_namespace = ? AND (destination_namespace = ? OR destination_namespace = '*')` should have an index on `(source_namespace, destination_namespace)`.

3. **Budget counter write volume**: `maxCallsPerHour` enforcement requires incrementing a counter on every message dispatch. With SQLite WAL mode, this is fast for single-process use. Use a time-bucketed row (1-minute buckets) to avoid update hotspots, then sum the last 60 rows to get the sliding window total.

4. **Discovery scan with namespace derivation**: Namespace derivation from path is O(1) — just string splitting. No performance impact on discovery.

5. **`MeshCore.list()` with ACL filtering**: For large registries (100+ agents), the ACL filter adds one extra ACL table lookup per namespace encountered. Should be negligible with indexed queries and in-memory ACL caching.

---

## Existing DorkOS Patterns to Leverage

1. **Sliding window rate limiting (ADR 0014)**: Already implemented in Relay. Reuse the same algorithm for `maxCallsPerHour` enforcement in Mesh budget policies.

2. **Structured PublishResult rejections (ADR 0016)**: Relay already has a structured rejection pattern. Budget exceeded rejections should use the same shape.

3. **NATS-style subject matching (ADR 0011)**: Relay already has subject pattern matching. The ACL engine for Mesh subject-pattern rules can reuse this exact logic rather than reimplementing it.

4. **SQLite migrations with PRAGMA user_version**: `AgentRegistry` already uses this pattern. New tables (`namespace_policies`, `namespace_acl_rules`, `budget_counters`) are added as version 2 and 3 migrations.

5. **Pending approval state (ADR 0009)**: Agent-created ACL rules should enter pending approval, not take effect immediately. The existing calm-tech notification layer pattern applies.

6. **`relay.agent.{namespace}.{agentId}` subject scheme**: The current `basename(projectPath)` in `RelayBridge` should be replaced with the canonical namespace to avoid collisions between projects in different roots that happen to share a directory name.

---

## Research Gaps and Limitations

1. **Relay's `addAccessRule()` API**: The research examined `RelayBridge.registerAgent()` which calls `relayCore.registerEndpoint()`, but it's unclear whether `RelayCore` exposes an `addAccessRule()` method. The Relay integration for ACL rules may need to be implemented from scratch if this method doesn't exist.

2. **Multi-root scan ambiguity**: If `MeshCore.discover()` is called with multiple roots, and an agent's path could be relative to more than one root, the namespace derivation is ambiguous. The scan root used for a given agent needs to be stored at registration time.

3. **Agent relocation**: If an agent's project directory is moved to a different path, the stored `projectPath` becomes stale. This is a pre-existing problem in the registry, not introduced by namespaces, but namespace derivation from path makes it slightly worse.

4. **Cross-DorkOS-instance namespaces**: If two separate DorkOS instances (on different machines) want to communicate, their namespace schemes are independent. The current design is single-instance; federated namespace resolution is out of scope.

---

## Recommendation

**Recommended Approach**: Solution 2 — Hybrid Filesystem + Manifest Namespace with Subject-Pattern ACLs

**Rationale**:

1. **Zero friction for the common case**: Most developers have one agent per project directory. Scan-root-relative namespace derivation requires no configuration and gives correct isolation immediately.

2. **Reuses existing infrastructure**: Subject-pattern ACL matching reuses ADR 0011 (NATS-style matching already in Relay). Budget enforcement reuses ADR 0014 (sliding window already in Relay). Rejection format reuses ADR 0016 (PublishResult rejections already in Relay). The pattern precedents are already established.

3. **Right granularity**: Namespace-to-namespace is coarse enough to be manageable, subject patterns are fine enough to be flexible. This matches what Consul Intentions provides — the same level operators are comfortable with in production service meshes.

4. **Security-first**: Invisible boundary (404) pattern aligns with OWASP BOLA guidance and prevents cross-project enumeration.

5. **Incremental path**: Start with Level 1 (namespace-to-namespace) ACL rules stored in SQLite. The schema can be extended later to Level 3 (subject patterns) or Level 4 (capability-gated) without breaking existing registrations.

**Implementation Order**:

1. Add `namespace` column to `agents` SQLite table (migration v2). Populate from scan-root-relative path at registration time. Store the scan root used for each agent.
2. Add optional `namespace` field to `AgentManifestSchema` (as an override).
3. Add `namespace_acl_rules` SQLite table (migration v3): `(id, source_namespace, destination_namespace, action, created_by, created_at)`.
4. Add `namespace_policies` SQLite table (migration v4): `(namespace, max_calls_per_hour, max_agents, cross_namespace_default)`.
5. Implement `AclEngine` class that checks ACL rules with NATS-style subject matching (reuse ADR 0011 logic).
6. Update `MeshCore.list()` to accept caller namespace and filter results through `AclEngine`.
7. Update `RelayBridge.registerAgent()` to use canonical namespace in subject, and add intra-namespace allow rule.
8. Implement budget counter storage and `BudgetEnforcer` class using sliding window (ADR 0014 pattern).
9. Add `namespace_acl_rules` and `namespace_policies` CRUD to `routes/mesh.ts`.

**Caveats**:

- The scan root used for namespace derivation must be stored per-agent in the registry, or namespace derivation becomes ambiguous when multiple roots are used.
- ACL rules should only be writable by `human:*` principals (not `agent:*`) unless the rule enters `pending_approval` state to prevent agents from self-granting access.
- The Relay subject naming in `RelayBridge` currently uses `basename(projectPath)` — this must be changed to use the canonical namespace to avoid collisions.
- Budget enforcement adds a synchronous SQLite write on the hot path of every message dispatch. Profile this with WAL mode under realistic concurrency before deploying.

---

## Search Methodology

- Number of searches performed: 14
- Most productive search terms: "NATS subject-based access control permissions namespace", "Istio AuthorizationPolicy cross-namespace zero-trust", "liteLLM per-user per-team budget hierarchy", "OWASP 404 vs 403 tenant isolation"
- Primary information sources: Kubernetes docs, Istio docs, NATS docs, Consul docs, Linkerd docs, OWASP, LiteLLM docs, A2A protocol announcements

---

## Sources

- [Kubernetes Network Policies — Official Docs](https://kubernetes.io/docs/concepts/services-networking/network-policies/)
- [Kubernetes Network Policies for Isolating Namespaces — Loft Labs](https://www.vcluster.com/blog/kubernetes-network-policies-for-isolating-namespaces)
- [Isolating namespaces with NetworkPolicy — William Denniss](https://wdenniss.com/isolating-namespaces-with-networkpolicy)
- [Istio Authorization Policy — Official Docs](https://istio.io/latest/docs/reference/config/security/authorization-policy/)
- [Istio Security — Official Docs](https://istio.io/latest/docs/concepts/security/)
- [Zero Trust Architecture with Istio — Solo.io](https://www.solo.io/blog/how-to-configure-zero-trust-authn-authz-with-istio/)
- [Consul Service Mesh Intentions — HashiCorp Developer](https://developer.hashicorp.com/consul/docs/secure-mesh/intention)
- [Consul Namespace Setup — HashiCorp Developer](https://developer.hashicorp.com/consul/docs/multi-tenant/namespace/vm)
- [Linkerd Authorization Policy — Official Docs](https://linkerd.io/2-edge/features/server-policy/)
- [Locking down Kubernetes with Linkerd — Buoyant](https://www.buoyant.io/service-mesh-academy/locking-down-your-kubernetes-cluster-with-linkerd)
- [NATS Authorization — Official Docs](https://docs.nats.io/running-a-nats-service/configuration/securing_nats/authorization)
- [NATS Subject-Based Messaging — Official Docs](https://docs.nats.io/nats-concepts/subjects)
- [OWASP API1:2023 Broken Object Level Authorization](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/)
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [RBAC vs ABAC vs PBAC — Styra](https://www.styra.com/blog/what-is-rbac-vs-abac-vs-pbac/)
- [LiteLLM Budgets and Rate Limits — Official Docs](https://docs.litellm.ai/docs/proxy/users)
- [LiteLLM Rate Limit Tiers — Official Docs](https://docs.litellm.ai/docs/proxy/rate_limit_tiers)
- [LiteLLM Team Budgets — Official Docs](https://docs.litellm.ai/docs/proxy/team_budgets)
- [AWS Cross-Account Policy Evaluation — AWS IAM Docs](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_evaluation-logic-cross-account.html)
- [AWS Service Control Policies — AWS Organizations Docs](https://docs.aws.amazon.com/organizations/latest/userguide/orgs_manage_policies_scps.html)
- [A2A Protocol Announcement — Google Developers Blog](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/)
- [A2A Protocol — GitHub](https://github.com/a2aproject/A2A)
- [Rate Limiting Algorithms — API7.ai](https://api7.ai/blog/rate-limiting-guide-algorithms-best-practices)
- [Rate Limiting in Multi-Tenant APIs — DreamFactory](https://blog.dreamfactory.com/rate-limiting-in-multi-tenant-apis-key-strategies)
