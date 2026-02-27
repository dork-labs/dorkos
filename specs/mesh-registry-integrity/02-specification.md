---
slug: mesh-registry-integrity
number: 65
created: 2026-02-26
status: specified
---

# Specification: Mesh Registry Integrity & Reconciliation

**Status:** Draft
**Author:** Claude Code
**Date:** 2026-02-26
**Spec Number:** 65
**Ideation:** `specs/mesh-registry-integrity/01-ideation.md`

---

## 1. Overview

Harden the Mesh agent registry to eliminate crash bugs, silent data drift, and ghost agents. The `.dork/agent.json` manifest file on disk is the canonical source of truth; the SQLite `agents` table is a derived index. Four interconnected changes deliver integrity:

1. **Idempotent upserts** — Replace bare `INSERT` with `ON CONFLICT DO UPDATE`
2. **File-first registration with compensating cleanup** — Disk → DB → Relay, with rollback on failure
3. **Startup + periodic reconciliation** — Anti-entropy sweep syncing file state to DB
4. **Orphan auto-removal** — Mark unreachable agents, auto-remove after 24h grace period
5. **DB schema completeness** — Add `scan_root`, `behavior_json`, `budget_json` columns

## 2. Background / Problem Statement

The Mesh registry has two representations of agent state — `.dork/agent.json` files on disk and rows in the `agents` table in `dork.db`. These can diverge silently, causing 4 distinct bugs:

### Crash Bug 1: UNIQUE `project_path` constraint violation

Agent folder's `.dork/` removed → re-discovered → re-registered at same path → `insert()` hits UNIQUE constraint. Root cause: `agent-registry.ts` line 77-91 — bare `.run()` with no conflict handling.

### Crash Bug 2: PRIMARY KEY `id` conflict on moved/duplicated folders

Agent folder moved or duplicated → auto-import reads manifest with existing ID → `insert()` hits PK constraint. Root cause: `mesh-core.ts` line 589-600 — `upsertAutoImported()` checks `getByPath()` but not `get(manifest.id)`.

### Silent Drift: Auto-import never syncs updated manifests

User edits `.dork/agent.json` manually → DB retains stale data indefinitely. Root cause: `mesh-core.ts` line 589 — `if (this.registry.getByPath(projectPath)) return;` skips entirely.

### Ghost Agents: Deleted paths never cleaned up

User deletes project directory → DB entry persists forever with stale health status. Root cause: No path validation or periodic cleanup anywhere.

## 3. Goals

- Eliminate all 4 crash/drift bugs identified above
- Establish file-on-disk as the unambiguous source of truth
- Ensure DB always converges to file state within one reconciliation interval
- Complete the DB schema so `rowToEntry()` reads all fields from columns (no hardcoded defaults)
- Maintain backward compatibility — existing manifests and DB rows work without migration scripts

## 4. Non-Goals

- New Mesh features (lazy activation, supervision trees)
- Relay internal changes (AccessControl/BudgetEnforcer modifications)
- Client UI changes (MeshPanel stays unchanged)
- File-watching via chokidar — periodic reconciliation only
- Configurable reconciliation interval via UI (env var or config.json for now)
- Multi-instance/multi-process coordination

## 5. Technical Dependencies

| Dependency | Version | Purpose |
|---|---|---|
| `drizzle-orm` | ^0.39 | ORM for SQLite queries, `.onConflictDoUpdate()` |
| `drizzle-kit` | ^0.30 | Migration generation |
| `@dorkos/db` | workspace | Shared DB instance, schema, migrations |
| `@dorkos/shared` | workspace | Zod schemas for manifest validation |
| Node.js `fs/promises` | built-in | `access()` for path existence checks |

No new external dependencies required.

## 6. Detailed Design

### 6.1 DB Schema Changes

**File:** `packages/db/src/schema/mesh.ts`

Add three columns and extend the status enum:

```typescript
export const agents = sqliteTable('agents', {
  // ... existing columns unchanged ...
  status: text('status', {
    enum: ['active', 'inactive', 'unreachable'],
  }).notNull().default('active'),
  // New columns:
  scanRoot: text('scan_root').notNull().default(''),
  behaviorJson: text('behavior_json').notNull().default('{"responseMode":"always"}'),
  budgetJson: text('budget_json').notNull().default('{"maxHopsPerMessage":5,"maxCallsPerHour":100}'),
});
```

**Migration:** `packages/db/drizzle/0003_*.sql`

```sql
ALTER TABLE agents ADD COLUMN scan_root TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN behavior_json TEXT NOT NULL DEFAULT '{"responseMode":"always"}';
ALTER TABLE agents ADD COLUMN budget_json TEXT NOT NULL DEFAULT '{"maxHopsPerMessage":5,"maxCallsPerHour":100}';
```

No data migration needed — defaults cover all existing rows. The `status` column is `TEXT` in SQLite, so adding `'unreachable'` to the Drizzle enum requires no ALTER — it's application-level validation only.

### 6.2 AgentRegistry Changes

**File:** `packages/mesh/src/agent-registry.ts`

#### 6.2.1 Replace `insert()` with `upsert()`

```typescript
/**
 * Insert or update an agent in the registry.
 * Uses ON CONFLICT(id) DO UPDATE for idempotent registration.
 * Handles path conflicts by removing the stale entry first.
 */
upsert(agent: AgentRegistryEntry): void {
  const now = new Date().toISOString();

  // Check for path conflict: different agent ID at same path
  const existingAtPath = this.getByPath(agent.projectPath);
  if (existingAtPath && existingAtPath.id !== agent.id) {
    this.remove(existingAtPath.id);
  }

  this.db.insert(agents).values({
    id: agent.id,
    name: agent.name,
    description: agent.description ?? '',
    projectPath: agent.projectPath,
    runtime: agent.runtime,
    capabilities: JSON.stringify(agent.capabilities),
    namespace: agent.namespace ?? 'default',
    scanRoot: agent.scanRoot ?? '',
    behaviorJson: JSON.stringify(agent.behavior),
    budgetJson: JSON.stringify(agent.budget),
    approver: agent.registeredBy,
    registeredAt: agent.registeredAt,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: agents.id,
    set: {
      name: agent.name,
      description: agent.description ?? '',
      projectPath: agent.projectPath,
      runtime: agent.runtime,
      capabilities: JSON.stringify(agent.capabilities),
      namespace: agent.namespace ?? 'default',
      scanRoot: agent.scanRoot ?? '',
      behaviorJson: JSON.stringify(agent.behavior),
      budgetJson: JSON.stringify(agent.budget),
      updatedAt: now,
      status: 'active', // Re-registration clears unreachable
    },
  }).run();
}
```

#### 6.2.2 Update `rowToEntry()` to read from DB columns

```typescript
private rowToEntry(row: typeof agents.$inferSelect): AgentRegistryEntry {
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? '',
    runtime: row.runtime as AgentRuntime,
    capabilities: JSON.parse(row.capabilities) as string[],
    behavior: JSON.parse(row.behaviorJson),
    budget: JSON.parse(row.budgetJson),
    namespace: row.namespace,
    registeredAt: row.registeredAt,
    registeredBy: row.approver ?? 'mesh',
    projectPath: row.projectPath,
    scanRoot: row.scanRoot,
  };
}
```

#### 6.2.3 Update `update()` to include all mutable fields

```typescript
update(id: string, partial: Partial<AgentRegistryEntry>): boolean {
  const existing = this.get(id);
  if (!existing) return false;

  const merged = { ...existing, ...partial, id };
  const now = new Date().toISOString();
  const result = this.db.update(agents).set({
    name: merged.name,
    description: merged.description,
    runtime: merged.runtime,
    capabilities: JSON.stringify(merged.capabilities),
    namespace: merged.namespace,
    scanRoot: merged.scanRoot,
    behaviorJson: JSON.stringify(merged.behavior),
    budgetJson: JSON.stringify(merged.budget),
    updatedAt: now,
  }).where(eq(agents.id, id)).run();
  return result.changes > 0;
}
```

#### 6.2.4 New orphan management methods

```typescript
/** Mark an agent as unreachable (path no longer accessible). */
markUnreachable(id: string): boolean {
  const now = new Date().toISOString();
  const result = this.db.update(agents).set({
    status: 'unreachable',
    updatedAt: now,
  }).where(eq(agents.id, id)).run();
  return result.changes > 0;
}

/** List all agents with unreachable status. */
listUnreachable(): AgentRegistryEntry[] {
  const rows = this.db.select().from(agents)
    .where(eq(agents.status, 'unreachable'))
    .all();
  return rows.map((row) => this.rowToEntry(row));
}

/** List unreachable agents whose updatedAt is before the given ISO cutoff. */
listUnreachableBefore(cutoffIso: string): AgentRegistryEntry[] {
  const rows = this.db.select().from(agents)
    .where(and(
      eq(agents.status, 'unreachable'),
      lt(agents.updatedAt, cutoffIso),
    ))
    .all();
  return rows.map((row) => this.rowToEntry(row));
}
```

### 6.3 MeshCore Registration Changes

**File:** `packages/mesh/src/mesh-core.ts`

#### 6.3.1 File-first `register()` with compensating cleanup

```typescript
async register(candidate, overrides?, approver?, scanRoot?): Promise<AgentManifest> {
  const manifest = buildManifest(candidate, overrides, approver);
  const namespace = resolveNamespace(candidate.path, scanRoot, manifest.namespace);
  const entry = toRegistryEntry(manifest, candidate.path, namespace, scanRoot);

  // Step 1: Write manifest to disk (atomic tmp+rename)
  await writeManifest(candidate.path, manifest);

  // Step 2: Upsert into DB (idempotent)
  try {
    this.registry.upsert(entry);
  } catch (err) {
    // Compensate: remove manifest file
    await removeManifest(candidate.path);
    throw err;
  }

  // Step 3: Register with Relay
  try {
    await this.relayBridge.registerAgent(manifest, candidate.path, namespace, scanRoot);
  } catch (err) {
    // Compensate: remove DB entry
    this.registry.remove(manifest.id);
    throw err;
  }

  this.emitLifecycleEvent('registered', manifest);
  return manifest;
}
```

#### 6.3.2 Sync-aware `upsertAutoImported()`

Replace the skip-if-exists logic with sync-aware upsert:

```typescript
private async upsertAutoImported(
  manifest: AgentManifest,
  projectPath: string,
): Promise<void> {
  const namespace = resolveNamespace(
    projectPath,
    this.defaultScanRoot,
    manifest.namespace,
  );
  const entry: AgentRegistryEntry = {
    ...manifest,
    projectPath,
    namespace,
    scanRoot: this.defaultScanRoot,
  };

  // Upsert handles both new and existing agents
  this.registry.upsert(entry);

  // Ensure Relay endpoint exists
  await this.relayBridge.registerAgent(
    manifest, projectPath, namespace, this.defaultScanRoot,
  );
}
```

### 6.4 Reconciler Module

**New file:** `packages/mesh/src/reconciler.ts`

```typescript
import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentRegistry, AgentRegistryEntry } from './agent-registry.js';
import type { RelayBridge } from './relay-bridge.js';
import { readManifest } from './manifest.js';
import { resolveNamespace } from './namespace-resolver.js';

const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface ReconcileResult {
  synced: number;       // DB entries updated from file
  unreachable: number;  // Newly marked unreachable
  removed: number;      // Auto-removed after grace period
  discovered: number;   // New agents found on disk
}

/**
 * Full anti-entropy reconciliation between filesystem and DB.
 *
 * 1. Check each DB entry's path exists on disk
 * 2. For existing paths, sync file → DB if data differs
 * 3. Mark missing paths as unreachable
 * 4. Auto-remove unreachable entries past grace period
 */
export async function reconcile(
  registry: AgentRegistry,
  relayBridge: RelayBridge,
  defaultScanRoot: string,
): Promise<ReconcileResult> {
  const result: ReconcileResult = {
    synced: 0, unreachable: 0, removed: 0, discovered: 0,
  };
  const entries = registry.list();

  for (const entry of entries) {
    const pathExists = await pathAccessible(entry.projectPath);

    if (!pathExists) {
      // Mark unreachable (idempotent — already-unreachable stays unreachable)
      if (entry.status !== 'unreachable') {
        registry.markUnreachable(entry.id);
        result.unreachable++;
      }
      continue;
    }

    // Path exists — sync file → DB
    const manifest = await readManifest(entry.projectPath);
    if (!manifest) continue; // Corrupt/missing manifest, skip

    // Re-activate if previously unreachable
    if (entry.status === 'unreachable') {
      registry.update(entry.id, { status: 'active' } as any);
    }

    // Compare and sync if file data differs
    if (manifestDiffersFromEntry(manifest, entry)) {
      const namespace = resolveNamespace(
        entry.projectPath, entry.scanRoot || defaultScanRoot, manifest.namespace,
      );
      registry.update(entry.id, {
        name: manifest.name,
        description: manifest.description,
        runtime: manifest.runtime,
        capabilities: manifest.capabilities,
        behavior: manifest.behavior,
        budget: manifest.budget,
        namespace,
      });
      result.synced++;
    }
  }

  // Auto-remove orphans past grace period
  const cutoff = new Date(Date.now() - ORPHAN_GRACE_MS).toISOString();
  const expired = registry.listUnreachableBefore(cutoff);
  for (const entry of expired) {
    await relayBridge.unregisterAgent(entry.id, entry.namespace);
    registry.remove(entry.id);
    result.removed++;
  }

  return result;
}

/** Check if a filesystem path is accessible. */
async function pathAccessible(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

/** Compare manifest fields against registry entry. */
function manifestDiffersFromEntry(
  manifest: AgentManifest,
  entry: AgentRegistryEntry,
): boolean {
  return (
    manifest.name !== entry.name ||
    manifest.description !== entry.description ||
    manifest.runtime !== entry.runtime ||
    JSON.stringify(manifest.capabilities) !== JSON.stringify(entry.capabilities) ||
    JSON.stringify(manifest.behavior) !== JSON.stringify(entry.behavior) ||
    JSON.stringify(manifest.budget) !== JSON.stringify(entry.budget)
  );
}
```

### 6.5 Server Startup Integration

**File:** `apps/server/src/index.ts`

After MeshCore initialization, add reconciliation:

```typescript
if (meshCore) {
  // Startup reconciliation — sync DB with filesystem
  try {
    const result = await meshCore.reconcileOnStartup();
    logger.info('[Mesh] Startup reconciliation complete', result);
  } catch (err) {
    logger.error('[Mesh] Startup reconciliation failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Periodic reconciliation (every 5 minutes)
  meshCore.startPeriodicReconciliation(300_000);
}
```

On shutdown (existing SIGINT/SIGTERM handler), add:

```typescript
meshCore?.stopPeriodicReconciliation();
```

### 6.6 Shared Schema Update

**File:** `packages/shared/src/mesh-schemas.ts`

The `AgentHealthStatusSchema` (`active | inactive | stale`) is computed at query time and is separate from the DB `status` column. No change needed to the shared schema for `unreachable` — it's a DB-only status that maps to `inactive` or `stale` in the health computation.

However, the `MeshStatusResponseSchema` should surface unreachable count. Add to the existing status response:

```typescript
unreachableCount: z.number().int().nonneg(),
```

### 6.7 Data Flow Diagrams

**Registration (new flow):**

```
register(candidate)
  │
  ├─1→ writeManifest(path, manifest)      [disk — atomic tmp+rename]
  │     ↓ success
  ├─2→ registry.upsert(entry)             [DB — idempotent ON CONFLICT]
  │     ↓ success                          ↓ failure → removeManifest()
  ├─3→ relayBridge.registerAgent(...)      [Relay — endpoint + ACL]
  │     ↓ success                          ↓ failure → registry.remove()
  └──→ return manifest
```

**Reconciliation sweep:**

```
reconcile()
  │
  ├─→ registry.list()                      [load all DB entries]
  │
  ├─→ for each entry:
  │     ├─ fs.access(path)?
  │     │   ├─ YES → readManifest()
  │     │   │         ├─ differs? → registry.update()    [sync file→DB]
  │     │   │         └─ same? → skip
  │     │   └─ NO → registry.markUnreachable()
  │
  └─→ registry.listUnreachableBefore(24h ago)
        └─→ for each: relayBridge.unregisterAgent() + registry.remove()
```

## 7. User Experience

This is an infrastructure hardening change with no user-facing UI changes. Users benefit from:

- **No more crashes** when re-discovering agents or moving agent folders
- **Automatic sync** — editing `.dork/agent.json` is reflected in the UI within 5 minutes
- **Automatic cleanup** — deleting a project folder removes the ghost agent after 24h
- **USB-safe** — temporarily unmounting a drive doesn't delete agents (24h grace period)

## 8. Testing Strategy

### 8.1 Unit Tests

**`packages/mesh/src/__tests__/agent-registry.test.ts`** (extend existing):

```typescript
// Purpose: Verify upsert handles all conflict scenarios without crashing
describe('upsert()', () => {
  it('inserts new agent when no conflict exists');
  it('updates existing agent when same ID re-registered');
  it('replaces stale entry when different ID registered at same path');
  it('clears unreachable status on re-registration');
  it('persists behavior_json and budget_json from entry');
  it('persists scan_root from entry');
});

describe('markUnreachable()', () => {
  it('sets status to unreachable and updates timestamp');
  it('returns false for non-existent agent');
});

describe('listUnreachableBefore()', () => {
  it('returns only unreachable agents with updatedAt before cutoff');
  it('excludes active agents and recently-unreachable agents');
});

describe('rowToEntry()', () => {
  it('parses behavior_json from DB column');
  it('parses budget_json from DB column');
  it('reads scanRoot from DB column');
});
```

**`packages/mesh/src/__tests__/reconciler.test.ts`** (new):

```typescript
// Purpose: Verify reconciliation correctly syncs file state to DB
describe('reconcile()', () => {
  it('marks agents with missing paths as unreachable');
  it('syncs updated manifest fields to DB');
  it('re-activates previously unreachable agents when path reappears');
  it('auto-removes unreachable agents past 24h grace period');
  it('skips agents with corrupt/unparseable manifests');
  it('handles empty registry gracefully');
});
```

**`packages/mesh/src/__tests__/mesh-core.test.ts`** (extend existing):

```typescript
// Purpose: Verify compensating cleanup on registration failure
describe('register() compensation', () => {
  it('removes manifest file when DB upsert fails');
  it('removes DB entry when Relay registration fails');
  it('succeeds on re-registration at same path');
});

describe('upsertAutoImported()', () => {
  it('updates DB when manifest file has changed');
  it('handles moved folder (same ID, different path)');
});
```

### 8.2 Integration Tests

**`packages/db/src/__tests__/migrations.test.ts`** (extend existing):

```typescript
// Purpose: Verify migration 0003 adds columns with correct defaults
describe('migration 0003', () => {
  it('adds scan_root column with empty string default');
  it('adds behavior_json column with default behavior');
  it('adds budget_json column with default budget');
  it('existing rows get default values for new columns');
});
```

### 8.3 Mocking Strategy

- `fs/promises.access()` — mock for path existence checks in reconciler tests
- `readManifest()` — mock return values (valid manifest, null for corrupt, different data for drift)
- `RelayBridge` — mock `registerAgent()`/`unregisterAgent()` to test compensation
- `createTestDb()` from `@dorkos/test-utils` — in-memory DB for all registry tests

## 9. Performance Considerations

- **Startup reconcile**: O(n) where n = registered agents (typically 5-50). One `fs.access()` + one `readFile()` per agent. Sub-second for typical workloads.
- **Periodic sweep**: Same cost. At 5-min interval, essentially zero overhead.
- **Upsert vs insert**: Same SQL cost (single statement with ON CONFLICT clause).
- **JSON.stringify comparison**: Negligible for small objects (behavior/budget are <100 bytes).

## 10. Security Considerations

- Reconciliation reads manifest files from registered paths — all data is validated through the existing `AgentManifestSchema` (Zod) before use, preventing injection via crafted `agent.json`
- Orphan auto-removal has no auth check — acceptable in single-user context
- No new network-accessible endpoints; all changes are internal to the Mesh module

## 11. Documentation

Update these files:

- `contributing/architecture.md` — Add reconciliation lifecycle to Mesh section
- `packages/mesh/README.md` (if exists) — Document reconciliation behavior

No new documentation files needed.

## 12. Implementation Phases

### Phase 1: Schema + Upsert (Foundation)

1. Add `scan_root`, `behavior_json`, `budget_json` columns to Drizzle schema
2. Generate and verify migration 0003
3. Replace `insert()` with `upsert()` in `agent-registry.ts`
4. Update `rowToEntry()` to read new columns
5. Update `update()` to include all mutable fields
6. Add `markUnreachable()`, `listUnreachable()`, `listUnreachableBefore()`
7. Update migration smoke tests

### Phase 2: Compensating Registration

1. Reorder `register()` to file-first with try/catch compensation
2. Update `upsertAutoImported()` to sync instead of skip
3. Add `removeManifest()` helper to `manifest.ts`
4. Add registration compensation tests

### Phase 3: Reconciliation

1. Create `reconciler.ts` with `reconcile()` function
2. Add `reconcileOnStartup()` and periodic timer methods to `MeshCore`
3. Wire into `apps/server/src/index.ts` startup and shutdown
4. Add reconciler unit tests
5. Update shared schemas if needed (unreachable count in status)

## 13. Open Questions

None — all decisions resolved during ideation.

## 14. Related ADRs

| ADR | Title | Relevance |
|---|---|---|
| #25 | Use Simple JSON Columns for Agent Registry SQLite Schema | Original schema design — this spec extends it |
| #36 | Compute Agent Health Status at Query Time via SQL | Health status is computed, not stored — `unreachable` is a separate DB status |
| #39 | Use Drizzle ORM for Database Layer | Drizzle patterns used for upsert and migrations |
| #40 | Consolidate All DorkOS Databases to Single dork.db | Foundation — single DB enables this work |

## 15. References

- Ideation: `specs/mesh-registry-integrity/01-ideation.md`
- DB consolidation: `specs/db-drizzle-consolidation/04-implementation.md`
- Research: `research/20260226_mesh_registry_integrity.md`
- Mesh core spec: `specs/mesh-core-library/`
- Mesh topology spec: `specs/mesh-network-topology/`
- Consul anti-entropy model: HashiCorp Consul documentation
- SQLite UPSERT: `INSERT ... ON CONFLICT DO UPDATE` (SQLite 3.24+)
