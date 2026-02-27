---
slug: mesh-registry-integrity
number: 65
created: 2026-02-26
status: ideation
---

# Mesh Registry Integrity & Reconciliation

**Slug:** mesh-registry-integrity
**Author:** Claude Code
**Date:** 2026-02-26
**Branch:** preflight/mesh-registry-integrity
**Related:** N/A

---

## 1) Intent & Assumptions

- **Task brief:** Fix crash bugs and silent data drift in Mesh's agent registry caused by two divergent sources of truth (`.dork/agent.json` on disk, `agents` table in `dork.db`). Add reconciliation, compensating registration, graceful handling for moved/deleted/duplicated/corrupted agent directories, and complete the DB schema to store all manifest fields.
- **Assumptions:**
  - Mesh core library (Spec 54), server integration (Spec 56), network topology (Spec 58), and observability (Spec 59) are all implemented
  - The database consolidation (Spec 63) is complete — all services use `@dorkos/db` with Drizzle ORM against a single `~/.dork/dork.db`
  - The `manifest_json` blob column has already been dropped
  - The `scan_root` column does NOT exist in the Drizzle schema (only `projectPath` and `namespace`)
  - `behavior` and `budget` are hardcoded to defaults in `rowToEntry()` — not persisted in the DB
  - This is a hardening/correctness pass, not new feature work
- **Out of scope:**
  - New Mesh features (lazy activation, supervision trees)
  - Relay internal changes (AccessControl/BudgetEnforcer modifications)
  - Client UI changes
  - File-watching (chokidar) — periodic reconciliation only per user decision

---

## 2) Pre-reading Log

- `packages/db/src/schema/mesh.ts`: Current Drizzle schema. `agents` table has id, name, runtime, projectPath (UNIQUE), namespace, capabilities (JSON text), entrypoint, version, description, approver, status, lastSeenAt, lastSeenEvent, registeredAt, updatedAt. No `scan_root`, `behavior_json`, or `budget_json` columns. `manifest_json` was dropped.
- `packages/mesh/src/mesh-core.ts` (603 lines): Main orchestrator. `register()` does 3 non-atomic steps: writeManifest → registry.insert → relayBridge.registerAgent. `upsertAutoImported()` silently skips existing entries (line 589: `if (registry.getByPath(path)) return`). `unregister()` does Relay cleanup before DB removal with no rollback.
- `packages/mesh/src/agent-registry.ts` (283 lines): Drizzle-based. `insert()` has bare `.run()` — no conflict handling. `rowToEntry()` hardcodes `behavior: { responseMode: 'always' }`, `budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 }`, and `scanRoot: ''`. `update()` only updates name, description, runtime, capabilities — not namespace, budget, or behavior.
- `packages/mesh/src/manifest.ts` (57 lines): Atomic file write via tmp+rename. `readManifest()` returns null on parse/schema failure. No version field in the manifest schema.
- `packages/mesh/src/relay-bridge.ts` (158 lines): `registerAgent()` creates endpoint + 2 ACL rules (same-ns allow, cross-ns deny). `unregisterAgent()` removes endpoint. `cleanupNamespaceRules()` removes rules only when last agent in namespace removed.
- `packages/mesh/src/discovery-engine.ts` (173 lines): `scanDirectory()` yields auto-import events when `.dork/agent.json` found. Uses `Set<realpath>` for cycle detection per-call.
- `packages/shared/src/mesh-schemas.ts`: `AgentManifestSchema` includes id, name, description, runtime, capabilities, behavior, budget, namespace (optional, max 64), registeredAt, registeredBy. No `updatedAt` or `version` field.
- `specs/db-drizzle-consolidation/04-implementation.md`: DB consolidation is complete. All services use `@dorkos/db`. `manifest_json` dropped. `computeHealthStatus()` moved to TypeScript. All tests pass.
- `specs/mesh-network-topology/02-specification.md`: Namespace resolver spec. File is canonical for namespace overrides. Scan root used only for initial derivation.
- `research/20260226_mesh_registry_integrity.md`: Research recommends file-first write ordering, `ON CONFLICT(id) DO UPDATE` upserts, startup + periodic anti-entropy sweep, hash-based change detection, and auto-removal of orphans after grace period.

---

## 3) Codebase Map

**Primary Components/Modules:**

| File | Role | Key Issue |
|------|------|-----------|
| `packages/mesh/src/mesh-core.ts` | Main lifecycle orchestrator | Non-atomic 3-step registration, silent auto-import skip |
| `packages/mesh/src/agent-registry.ts` | Drizzle DB layer | Bare insert (crashes on conflict), incomplete update(), hardcoded defaults |
| `packages/mesh/src/manifest.ts` | File I/O (read/write `.dork/agent.json`) | No version tracking |
| `packages/mesh/src/relay-bridge.ts` | Relay endpoint + ACL management | No compensation on failure |
| `packages/mesh/src/discovery-engine.ts` | BFS directory scanner | Per-call visited set (multi-call dedup failure) |
| `packages/mesh/src/namespace-resolver.ts` | Pure namespace derivation | No issues (pure function) |
| `packages/db/src/schema/mesh.ts` | Drizzle schema definition | Missing scan_root, behavior_json, budget_json columns |

**Shared Dependencies:**

- `@dorkos/db` — createDb, Db type, schema tables
- `@dorkos/shared/mesh-schemas` — AgentManifestSchema, Zod validation
- `@dorkos/relay` — RelayCore for endpoint registration

**Data Flow (Current — Non-Atomic):**

```
register(candidate) →
  1. writeManifest(path, manifest)         [file on disk — committed]
  2. registry.insert(entry)                [DB — can crash, no rollback of step 1]
  3. relayBridge.registerAgent(...)         [Relay — can fail, no rollback of steps 1-2]
```

**Feature Flags/Config:**

- `DORKOS_MESH_ENABLED` — controls Mesh feature (mesh-state.ts)
- `DORKOS_RELAY_ENABLED` — controls Relay feature (relay-state.ts)

**Potential Blast Radius:**

- **Tier 1 (Direct):** 4 files — mesh-core.ts, agent-registry.ts, manifest.ts, relay-bridge.ts
- **Tier 2 (Schema):** 2 files — packages/db/src/schema/mesh.ts (new columns), new migration SQL
- **Tier 3 (Tests):** 4 files — mesh-core.test.ts, agent-registry.test.ts, relay-integration.test.ts, new reconcile.test.ts
- **Tier 4 (Server):** 1 file — apps/server/src/index.ts (startup reconciliation)

---

## 4) Root Cause Analysis

### Crash Bug 1: UNIQUE `project_path` constraint violation

**Trigger:** Agent folder's `.dork/` removed → re-discovered → re-registered at same path → `insert()` hits UNIQUE constraint.

**Root cause:** `agent-registry.ts:77-91` — bare `this.db.insert(agents).values({...}).run()` with no conflict handling. The `@throws` JSDoc documents it but nothing catches it in mesh-core.ts.

**Evidence:** `agent-registry.ts:75` has the comment `@throws If project_path already exists (UNIQUE constraint)`.

### Crash Bug 2: PRIMARY KEY `id` conflict on moved/duplicated folders

**Trigger:** Agent folder moved or duplicated → auto-import reads manifest with existing ID → `insert()` hits PRIMARY KEY constraint.

**Root cause:** `mesh-core.ts:589-600` — `upsertAutoImported()` checks `getByPath()` (which returns undefined for new path) but not `get(manifest.id)` (which would find the ID collision).

### Silent Drift: Auto-import never syncs updated manifests

**Trigger:** User edits `.dork/agent.json` manually → DB retains stale data indefinitely.

**Root cause:** `mesh-core.ts:589` — `if (this.registry.getByPath(projectPath)) return;` skips entirely if path is already registered. No timestamp comparison, no field diff.

### Ghost Agents: Deleted paths never cleaned up

**Trigger:** User deletes project directory → DB entry persists forever with stale health status.

**Root cause:** No path validation anywhere. `list()`, `get()`, `getByPath()` never check filesystem existence. No periodic cleanup.

---

## 5) Research

Research agent consulted 13 sources including SQLite UPSERT docs, Consul health checks, Azure saga pattern, chokidar, and write-file-atomic.

### Potential Solutions

**1. File-First Write Ordering with Compensating Cleanup (Selected)**
- Description: Disk write first (atomic tmp+rename), then DB upsert with `ON CONFLICT(id) DO UPDATE`, then Relay registration. On failure at any step, compensate by undoing prior steps.
- Pros: Clear source-of-truth hierarchy, simple mental model, no saga framework needed at this scale
- Cons: Compensation logic adds code to register/unregister paths
- Complexity: Medium | Maintenance: Low

**2. Startup + Periodic Reconciliation Sweep (Selected)**
- Description: Full file-vs-DB reconciliation on server startup. Configurable periodic sweep (default 5 min) as safety net. No file watchers.
- Pros: Catches all drift including external edits/deletions/moves, simple lifecycle (no watcher management), matches Consul anti-entropy model
- Cons: Changes not detected until next sweep interval
- Complexity: Medium | Maintenance: Low

**3. Idempotent Upsert via `ON CONFLICT(id) DO UPDATE` (Selected)**
- Description: Replace bare `INSERT` with Drizzle's `.onConflictDoUpdate()`. Handle path-conflict separately with application-level check-then-act.
- Pros: No crash on ID collision, handles moved agents gracefully, matches Drizzle patterns already used in DenialList
- Cons: Path conflict requires two queries (check + insert/update)
- Complexity: Low | Maintenance: Low

**4. Auto-Remove Orphans After Grace Period (Selected)**
- Description: Reconcile marks missing-path agents as status='unreachable'. After 24h still unreachable, auto-remove from DB + Relay. Mirrors Consul's `deregister_critical_service_after`.
- Pros: Prevents ghost agent accumulation without being too aggressive (USB unmount safe)
- Cons: Ghosts visible for up to 24h
- Complexity: Low | Maintenance: Low

**5. Full Saga Pattern with Write-Ahead Log**
- Description: Write all intended operations to a WAL before executing. Replay/compensate on crash recovery.
- Pros: Full crash recovery, provably consistent
- Cons: Massive overkill for 5-50 agents on a single machine
- Complexity: Very High | Maintenance: High

### Security Considerations

- Reconciliation reads manifest files from registered paths — should validate with Zod schema to prevent injection via crafted agent.json
- Orphan auto-removal has no auth check — acceptable in single-user context

### Performance Considerations

- Startup reconcile: O(n) where n = registered agents (5-50). One `fs.access()` + one `readFile()` per agent. Negligible.
- Periodic sweep: Same cost. At 5-min interval, essentially zero overhead.
- Upsert instead of insert: Same SQL cost (single statement).

### Recommendation

Combine solutions 1-4. File-first writes with compensating cleanup, idempotent upserts, startup + configurable periodic reconciliation, and auto-removal of orphans after 24h grace period. Skip the saga pattern (Solution 5) — it's overkill at this scale.

---

## 6) Decisions

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| 1 | Source of truth hierarchy | File wins always | File is canonical. DB is a derived index. API updates write-through to the file. Matches Consul/systemd/Docker patterns. Simple mental model. On conflict, file data overwrites DB. |
| 2 | Reconciliation trigger | Startup sweep + configurable periodic | Full reconcile on server startup. Configurable periodic sweep (default 5 min, user can change interval or disable). No file watchers. Catches all drift including external edits, deletions, moves. Matches Consul's anti-entropy model. |
| 3 | Orphan handling | Auto-remove after 24h grace period | Mark as status='unreachable' immediately when path missing. Auto-remove from DB + Relay after 24h if path still missing. Prevents ghost agents without being too aggressive (USB drive temporarily unmounted won't lose agents). Mirrors Consul's `deregister_critical_service_after`. |
| 4 | DB schema completeness | Add all missing columns now | Add `behavior_json`, `budget_json`, `scan_root` columns to the `agents` table. Makes DB a complete representation of the manifest. Enables proper round-tripping and reconciliation. Natural part of an integrity fix. Requires a new Drizzle migration. |

