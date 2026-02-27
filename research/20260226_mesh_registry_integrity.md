# Mesh Registry Integrity — Research Findings

**Date**: 2026-02-26
**Topic**: Fixing multi-source-of-truth divergence in DorkOS Mesh agent registry
**Mode**: Deep Research
**Searches performed**: 12
**Sources found**: 40+

---

## Research Summary

The DorkOS Mesh registry faces a classic local-first consistency problem: three representations of the same data (filesystem manifest, SQLite columns, JSON blob column) can diverge with no reconciliation mechanism, causing PRIMARY KEY/UNIQUE constraint crashes and silent drift. Research across service registry systems (Consul, Docker), SQLite internals, and local-first software patterns reveals a clean, layered solution appropriate for 5-50 agents at single-machine scale — no distributed systems machinery needed.

The core principle: **the filesystem manifest is the portable source of truth; the SQLite database is a derived, queryable index**. Every write operation must treat these as a cache relationship (write-through), not a co-equal store.

---

## Key Findings

### 1. Multi-Source-of-Truth Reconciliation

**Root cause of divergence**: The three representations (disk JSON, SQLite indexed columns, SQLite JSON blob) are written independently with no coordination protocol. Any partial failure or out-of-order write creates permanent drift.

**How Docker handles this**: Docker treats its `daemon.json` config file as user-intent and its internal state database as runtime state. When both specify the same directive, Docker refuses to start and reports a hard conflict error — it never silently picks one. The lesson is: **designate one source and refuse to continue if the other disagrees**.

**How Consul handles it**: Consul uses an anti-entropy loop — a background process that periodically compares in-memory state to persisted registration data and reconciles differences. It runs continuously, with a configurable interval, rather than relying on all writes being perfect.

**Recommended pattern for DorkOS Mesh**:

```
Filesystem manifest (.dork/agent.json)
        ↓  (read on startup + reconcile loop)
SQLite index (searchable columns, no blob)
        ↓  (read into memory on startup)
In-memory service (MeshCore, Relay endpoints)
```

Rules:
- The manifest file is the only portable representation. It travels with the project.
- SQLite is a derived index that can be rebuilt from disk at any time.
- In-memory state is rebuilt from SQLite on server startup.
- On write: update disk first, then update SQLite atomically from the disk content.
- On startup: reconcile SQLite against all discovered manifest files.

---

### 2. Atomic Multi-System Writes

**The problem**: Writing to three systems (filesystem, SQLite, in-memory) is not transactionally linked. A crash between steps leaves the registry in a partially written state.

**Saga pattern applicability**: The saga pattern (from distributed microservices) models long-running operations as a sequence of local transactions with compensating transactions for rollback. For a local single-machine system this is heavy machinery, but the core idea — **define explicit compensating actions and execute them on failure** — is directly applicable.

**Write-ahead log (WAL) principle**: The WAL idea (from SQLite itself and databases broadly) is: never modify state in place; write the intended change to a durable log first, then apply. If the process crashes mid-apply, replay the log on next startup. For a local agent registry at 5-50 agents, a lightweight version of this is practical.

**Atomic file writes**: The standard Unix pattern for atomic file replacement is write-to-temp-then-rename:

```typescript
// Write new content to a .tmp file
await fs.writeFile(path + '.tmp', JSON.stringify(manifest, null, 2));
// Atomic swap — on POSIX this is guaranteed atomic
await fs.rename(path + '.tmp', path);
```

npm's `write-file-atomic` package wraps exactly this pattern. On Windows, `fs.rename` is not guaranteed atomic, but for single-user local tools this is an acceptable caveat.

**Recommended write sequence for DorkOS Mesh**:

```
1. Validate the new manifest (Zod parse)
2. Write manifest to disk atomically (tmp-rename)
3. Upsert into SQLite (idempotent, see section 4)
4. Update in-memory MeshCore state
5. Publish Relay lifecycle event (best-effort, non-blocking)

On any failure:
- If step 2 fails: nothing changed, throw
- If step 3 fails: disk has new data, SQLite is stale → compensate by
  re-running the reconcile sweep (or deleting the disk file and rethrowing)
- If step 4 fails: reload from SQLite
- If step 5 fails: ignore (Relay is best-effort pubsub)
```

For step 3 failure specifically: since SQLite can be rebuilt from disk, a failed DB write is recoverable by the next reconcile run. The key is that **disk is written first**, so the canonical state is never lost.

---

### 3. Registry Integrity / Self-Healing

**Consul's approach**: Consul runs a periodic anti-entropy process alongside its event-driven updates. Even if an event-driven write fails, the background sweep will eventually correct divergence. TTL checks mark agents as critical after a configurable time without a heartbeat. `deregister_critical_service_after` auto-removes agents that stay critical too long.

**Docker's approach**: Docker detects containers whose underlying filesystem state has changed (container directory deleted or corrupted) through a reconcile pass at daemon startup. It marks such containers as unhealthy or removes them from its registry.

**Recommended reconcile loop for DorkOS Mesh**:

```typescript
// Run at startup and every N minutes (e.g., 5 min)
async function reconcile(db: Database, manifestDir: string): Promise<ReconcileResult> {
  const diskManifests = await scanDiskForManifests(manifestDir);
  const dbAgents = db.prepare('SELECT id, path, manifest_hash FROM agents').all();

  const diskById = new Map(diskManifests.map(m => [m.id, m]));
  const dbById = new Map(dbAgents.map(a => [a.id, a]));

  const results = { added: 0, updated: 0, removed: 0, errors: string[] };

  // Agents on disk but not in DB → insert
  for (const [id, manifest] of diskById) {
    if (!dbById.has(id)) {
      upsertAgent(db, manifest);
      results.added++;
    }
  }

  // Agents in DB but manifest deleted from disk → remove from DB
  for (const [id] of dbById) {
    if (!diskById.has(id)) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(id);
      results.removed++;
    }
  }

  // Agents in both → check hash, update if stale
  for (const [id, disk] of diskById) {
    const db_row = dbById.get(id);
    if (db_row && db_row.manifest_hash !== disk.hash) {
      upsertAgent(db, disk);
      results.updated++;
    }
  }

  return results;
}
```

A `manifest_hash` column (SHA-256 of the manifest file content) makes change detection O(n) with no file reads beyond the initial scan.

**TTL-based stale detection**: Add a `last_seen_at` column (already present in the schema via `AgentHealth`). Define thresholds:

- `active`: last_seen_at within 5 minutes
- `inactive`: 5–60 minutes
- `stale`: >60 minutes or manifest file no longer on disk

The health status is computed, not stored — it is derived from `last_seen_at` relative to `NOW()` on every query.

---

### 4. Idempotent Upsert Patterns

**`INSERT OR REPLACE` vs `INSERT ... ON CONFLICT DO UPDATE`**:

`INSERT OR REPLACE` is implemented as **delete-then-insert**, not update. This means:
- The ROWID changes on every replace, breaking any foreign key references
- Delete triggers fire (if recursive triggers are enabled)
- The update hook is NOT invoked — watchers miss the change
- Cascading deletes on child tables execute silently

`INSERT ... ON CONFLICT DO UPDATE` (UPSERT, SQLite 3.24+, 2018) is a true in-place update:
- ROWID stays the same
- Foreign key children are preserved
- Update triggers fire correctly
- The conflict target must be a UNIQUE or PRIMARY KEY constraint

**Verdict**: For an agent registry, always use `ON CONFLICT DO UPDATE`. Never use `INSERT OR REPLACE`.

**The moved-agent problem (ID same, path changed)**:

If an agent moves to a new path, the agent ID stays the same but the `path` column (which has a UNIQUE constraint) now conflicts with nothing on insert. The problem occurs in reverse: a new agent at the old path would collide with the old agent's path constraint even though the IDs differ.

The correct schema design:

```sql
CREATE TABLE agents (
  id      TEXT PRIMARY KEY,           -- ULID, stable identity
  path    TEXT NOT NULL UNIQUE,       -- filesystem path, mutable
  name    TEXT NOT NULL,
  runtime TEXT NOT NULL,
  -- ... other indexed columns
  registered_at TEXT NOT NULL,
  last_seen_at  TEXT,
  manifest_hash TEXT NOT NULL         -- SHA-256 of manifest file
);
```

On registration of an agent at a path that is already occupied by a different agent ID:

```typescript
// Step 1: Check if path is occupied by a DIFFERENT agent
const existing = db.prepare('SELECT id FROM agents WHERE path = ?').get(newPath);
if (existing && existing.id !== newId) {
  // Path conflict: old agent must be evicted first
  // Option A: Hard fail — require explicit unregister of old agent
  throw new Error(`Path ${newPath} is already registered to agent ${existing.id}`);
  // Option B: Auto-migrate — remove old, insert new (log the eviction)
}

// Step 2: Safe upsert by primary key
db.prepare(`
  INSERT INTO agents (id, path, name, runtime, registered_at, manifest_hash)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    path = excluded.path,
    name = excluded.name,
    runtime = excluded.runtime,
    manifest_hash = excluded.manifest_hash
`).run(id, path, name, runtime, registeredAt, hash);
```

The explicit path-conflict check before the upsert prevents the UNIQUE violation on `path` entirely. This application-level guard is cleaner than relying on SQLite's conflict resolution for the path column.

---

### 5. JSON Blob Column Anti-Pattern

**The problem**: Storing a full JSON copy (`manifest TEXT`) alongside individual indexed columns (`name TEXT`, `runtime TEXT`, etc.) creates:
- Dual writes that can diverge (the columns say one thing, the blob says another)
- Ambiguity about which is canonical
- Wasted storage and parse overhead on every read
- Inability to use SQLite's JSON functions directly on BLOB-type columns (all JSON functions throw on BLOB types)

**Is this a known anti-pattern?** Yes. The SQLite community and database design literature consistently flag the "fat redundant blob" as a smell when the blob's fields are also stored as columns. The rule of thumb from sqlite.org and database normalization:

> Store data in columns when you need to query, filter, index, or join on it. Store in a JSON text column only for semi-structured, variable-shape data you will never query field-by-field.

**The three legitimate uses of a JSON column in SQLite**:
1. Truly variable-shape extras (the `capabilities` array in `AgentManifest` is a reasonable example — it varies per agent and is not queried in WHERE clauses)
2. Config/behavior objects that are always read/written as a unit and never filtered on
3. Audit-trail snapshots for historical record

**Recommended migration: drop the blob, use virtual columns for any remaining JSON**:

```sql
-- Keep: indexed columns for all queryable fields
-- Keep: a JSON column for variable-shape extras only (capabilities, behavior, budget)
ALTER TABLE agents ADD COLUMN extras TEXT DEFAULT '{}';

-- Use SQLite generated columns for performance without duplication
-- (SQLite 3.31+, 2020-01-22)
ALTER TABLE agents ADD COLUMN runtime_virtual TEXT
  GENERATED ALWAYS AS (json_extract(extras, '$.runtime')) VIRTUAL;
CREATE INDEX idx_agents_runtime ON agents(runtime_virtual);
```

This gives B-tree index speed on JSON fields without storing them twice.

**Migration strategy for removing the blob**:
1. Add the new normalized columns alongside the blob (schema migration via `PRAGMA user_version`)
2. Run a one-time backfill: `UPDATE agents SET name = json_extract(manifest, '$.name'), ...`
3. Verify all rows have non-null values in the new columns
4. Remove the `manifest` blob column (SQLite requires a table rebuild: `CREATE TABLE agents_new ...; INSERT INTO agents_new SELECT ...; DROP TABLE agents; ALTER TABLE agents_new RENAME TO agents;`)
5. Bump `PRAGMA user_version` to mark the migration complete

---

### 6. File Watching vs Periodic Reconciliation

**chokidar / fs.watch event-based watching**:
- Uses native OS kernel events (inotify on Linux, FSEvents on macOS, ReadDirectoryChangesW on Windows)
- Zero CPU cost at idle — no polling
- Sub-second latency on most platforms
- Scales well up to a few hundred directories without meaningful resource cost
- Breaks in some Docker/VM/network filesystem scenarios

**Polling-based watching**:
- Constant CPU and disk I/O proportional to number of watched paths
- In a project with 1000+ watched files, polling can consume a full CPU core at idle
- Required fallback for NFS/SMB/Docker mounted filesystems

**Periodic reconciliation sweep**:
- Low-frequency (e.g., every 5 minutes) directory scan
- Near-zero CPU impact
- Latency up to the interval for detecting changes
- Robust — works on any filesystem, survives watcher crashes

**Recommended hybrid for DorkOS Mesh (5-50 agents)**:

```
Strategy:
1. On startup: full reconcile sweep (scan all known project dirs)
2. During runtime: chokidar watch on registered agent manifest files only
   (NOT a recursive watch of the whole filesystem — only watch specific files)
3. Every 5 minutes: lightweight reconcile sweep as safety net
   (catches moves, renames, external edits that chokidar misses)
4. On unregister: remove that file's watcher
```

Watching only the specific manifest files (not whole directories) keeps the watcher count at 5-50 — trivially cheap on all platforms.

```typescript
class ManifestWatcher {
  private watcher: FSWatcher | null = null;
  private watchedPaths = new Set<string>();

  watchManifest(manifestPath: string, onChange: (path: string) => void) {
    if (!this.watcher) {
      this.watcher = chokidar.watch([], { persistent: false, ignoreInitial: true });
      this.watcher.on('change', onChange);
      this.watcher.on('unlink', onChange); // manifest deleted
    }
    if (!this.watchedPaths.has(manifestPath)) {
      this.watcher.add(manifestPath);
      this.watchedPaths.add(manifestPath);
    }
  }

  unwatchManifest(manifestPath: string) {
    this.watcher?.unwatch(manifestPath);
    this.watchedPaths.delete(manifestPath);
  }
}
```

The periodic sweep catches anything the file watcher misses (file moved via `mv` on some systems fires `unlink` + `add` rather than `change`; the sweep handles the re-registration).

---

## Detailed Architecture Recommendation

### Single Source of Truth: Manifests on Disk

```
~/.dork/mesh/
├── agents/
│   ├── {agentId}.json    ← canonical manifest per agent
│   └── ...
└── denied.json           ← denial list (flat file, simple)
```

Each `{agentId}.json` contains the full `AgentManifest` shape. This is the portable, human-readable truth. The agent ID is embedded in the filename (no ambiguity) and in the JSON (self-describing).

### SQLite as a Derived Index

```sql
CREATE TABLE agents (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL UNIQUE,   -- project filesystem path
  name           TEXT NOT NULL,
  runtime        TEXT NOT NULL,
  namespace      TEXT,
  capabilities   TEXT NOT NULL DEFAULT '[]',  -- JSON array, not individually indexed
  behavior       TEXT NOT NULL DEFAULT '{}',  -- JSON object, read as unit
  budget         TEXT NOT NULL DEFAULT '{}',  -- JSON object, read as unit
  registered_at  TEXT NOT NULL,
  registered_by  TEXT NOT NULL,
  last_seen_at   TEXT,
  last_seen_event TEXT,
  manifest_hash  TEXT NOT NULL            -- SHA-256 for change detection
  -- NO separate manifest blob column
);

CREATE INDEX idx_agents_runtime   ON agents(runtime);
CREATE INDEX idx_agents_namespace ON agents(namespace);
```

The `capabilities`, `behavior`, and `budget` fields are legitimately variable-shape — store as JSON TEXT. For the common `runtime` and `namespace` filter queries, keep them as indexed columns.

### Write Protocol

```typescript
async function registerAgent(manifest: AgentManifest, db: Database): Promise<void> {
  // 1. Validate
  AgentManifestSchema.parse(manifest);

  // 2. Check for path conflict with a DIFFERENT agent ID
  const pathConflict = db.prepare('SELECT id FROM agents WHERE path = ?').get(manifest.path);
  if (pathConflict && pathConflict.id !== manifest.id) {
    throw new Error(`Path already registered to agent ${pathConflict.id}. Unregister it first.`);
  }

  // 3. Atomic file write (tmp-rename)
  const manifestPath = agentManifestPath(manifest.id);
  const tmp = manifestPath + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(manifest, null, 2), 'utf8');
  await fs.rename(tmp, manifestPath);

  // 4. Compute hash and upsert into SQLite
  const hash = sha256(JSON.stringify(manifest));
  db.prepare(`
    INSERT INTO agents (id, path, name, runtime, namespace, capabilities, behavior, budget,
                        registered_at, registered_by, manifest_hash)
    VALUES (@id, @path, @name, @runtime, @namespace, @capabilities, @behavior, @budget,
            @registeredAt, @registeredBy, @hash)
    ON CONFLICT(id) DO UPDATE SET
      path           = excluded.path,
      name           = excluded.name,
      runtime        = excluded.runtime,
      namespace      = excluded.namespace,
      capabilities   = excluded.capabilities,
      behavior       = excluded.behavior,
      budget         = excluded.budget,
      manifest_hash  = excluded.manifest_hash
  `).run({
    id: manifest.id,
    path: manifest.path,       // assuming path is part of the manifest or passed separately
    name: manifest.name,
    runtime: manifest.runtime,
    namespace: manifest.namespace ?? null,
    capabilities: JSON.stringify(manifest.capabilities),
    behavior: JSON.stringify(manifest.behavior),
    budget: JSON.stringify(manifest.budget),
    registeredAt: manifest.registeredAt,
    registeredBy: manifest.registeredBy,
    hash,
  });

  // 5. Update in-memory state (best-effort — reconcile will fix it on next sweep)
  meshCore.ingest(manifest);
}
```

### Startup Reconciliation

```typescript
async function startupReconcile(db: Database, meshDir: string): Promise<void> {
  const agentsDir = path.join(meshDir, 'agents');

  // Read all manifest files
  let files: string[] = [];
  try {
    files = (await fs.readdir(agentsDir)).filter(f => f.endsWith('.json'));
  } catch {
    return; // no agents dir yet
  }

  const diskIds = new Set<string>();

  for (const file of files) {
    const filePath = path.join(agentsDir, file);
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      const manifest = AgentManifestSchema.parse(parsed);
      const hash = sha256(raw);
      diskIds.add(manifest.id);

      // Check if DB is stale for this agent
      const row = db.prepare('SELECT manifest_hash FROM agents WHERE id = ?').get(manifest.id);
      if (!row || row.manifest_hash !== hash) {
        // Upsert from disk (disk wins)
        upsertFromManifest(db, manifest, hash);
      }
    } catch (err) {
      console.warn(`[mesh:reconcile] Skipping corrupt manifest ${file}:`, err);
    }
  }

  // Remove DB entries with no corresponding disk file
  const dbIds = db.prepare('SELECT id FROM agents').all().map(r => r.id);
  for (const id of dbIds) {
    if (!diskIds.has(id)) {
      db.prepare('DELETE FROM agents WHERE id = ?').run(id);
      console.info(`[mesh:reconcile] Removed stale agent ${id} (manifest deleted)`);
    }
  }
}
```

---

## Contradictions and Trade-offs

### Chokidar on macOS (FSEvents) vs Linux (inotify)

macOS FSEvents is reliable and low-latency. Linux inotify has a watch limit (`/proc/sys/fs/inotify/max_user_watches`, default 8192) — but 50 manifest files is nowhere near this limit. The hybrid watch + periodic sweep is robust regardless.

### SQLite WAL mode vs rollback journal

Enable WAL mode for the Mesh database (`PRAGMA journal_mode = WAL`). This matches the existing pattern in `PulseStore` (which uses WAL). WAL allows concurrent readers during the reconcile sweep without blocking writers.

### Compensating transactions vs just rebuilding from disk

For a 5-50 agent registry, compensating transactions (saga-style) add complexity without proportional benefit. The simpler approach — write disk first, rebuild DB from disk on inconsistency — achieves the same safety goal with far less code. Reserve compensating transactions for systems where rebuilding from scratch is expensive.

---

## Research Gaps

- No research was done on Relay in-memory endpoint synchronization specifically — the Relay endpoint sync problem may have different characteristics than the manifest sync problem
- The `atomically` npm package (newer alternative to `write-file-atomic`) was identified but not deeply evaluated for Windows cross-drive rename behavior

---

## Sources & Evidence

- [UPSERT — SQLite Documentation](https://sqlite.org/lang_upsert.html) — canonical reference on `ON CONFLICT DO UPDATE` behavior, conflict targets, and the `excluded.` qualifier
- [The ON CONFLICT Clause — SQLite](https://sqlite.org/lang_conflict.html) — explains `INSERT OR REPLACE` as delete-then-insert, documents that the update hook is NOT invoked for rows deleted by REPLACE
- [JSON and virtual columns in SQLite](https://antonz.org/json-virtual-columns/) — practical guide to generated columns as an alternative to storing fields redundantly
- [SQLite JSON Superpower: Virtual Columns + Indexing](https://www.dbpro.app/blog/sqlite-json-virtual-columns-indexing) — covers indexing JSON via generated columns, the recommended pattern for replacing blob redundancy
- [Write-Ahead Logging — SQLite](https://sqlite.org/wal.html) — WAL mode semantics, checkpoint behavior, concurrency model
- [write-file-atomic — npm](https://www.npmjs.com/package/write-file-atomic) — atomic file write via tmp-rename pattern, used by npm itself
- [atomically — npm](https://www.npmjs.com/package/atomically) — more modern alternative, same pattern with queued writes to same path
- [Define health checks — Consul](https://developer.hashicorp.com/consul/docs/register/health-check/vm) — TTL check pattern, deregister_critical_service_after for auto-removal of stale entries
- [Troubleshooting Stale Service Registry and Gossip Issues in Consul](https://www.mindfulchase.com/explore/troubleshooting-tips/devops-tools/troubleshooting-stale-service-registry-and-gossip-issues-in-consul.html) — Consul's anti-entropy approach to reconciliation
- [chokidar — GitHub](https://github.com/paulmillr/chokidar) — native event vs polling distinction, resource cost at scale
- [Saga Design Pattern — Azure Architecture Center](https://learn.microsoft.com/en-us/azure/architecture/patterns/saga) — compensating transaction model, orchestration vs choreography
- [Anti-Entropy in Distributed Systems — GeeksforGeeks](https://www.geeksforgeeks.org/system-design/anti-entropy-in-distributed-systems/) — periodic background reconciliation pattern
- [Systemd service config clashes with daemon.json — Docker Forums](https://forums.docker.com/t/systemd-service-config-clashes-with-daemon-json/140855) — Docker's approach to config source-of-truth conflicts
- [SQLite Versioning and Migration Strategies](https://www.sqliteforum.com/p/sqlite-versioning-and-migration-strategies) — PRAGMA user_version migration pattern
