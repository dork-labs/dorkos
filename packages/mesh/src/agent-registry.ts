/**
 * SQLite-backed agent registry for the Mesh module.
 *
 * Persists registered agent manifests in a SQLite database, providing
 * fast lookup by ULID or project path. Follows the same better-sqlite3
 * patterns as relay's sqlite-index and server's pulse-store: WAL mode,
 * PRAGMA user_version migrations, and prepared statements.
 *
 * @module mesh/agent-registry
 */
import Database from 'better-sqlite3';
import type { AgentManifest, AgentRuntime } from '@dorkos/shared/mesh-schemas';

// === Types ===

/** A registered agent entry combining the manifest with the project path. */
export interface AgentRegistryEntry extends AgentManifest {
  /** Absolute path to the agent's project directory. */
  projectPath: string;
  /** Namespace this agent belongs to (derived from scan root or manifest). */
  namespace: string;
  /** The scan root used to derive the namespace. */
  scanRoot: string;
}

/** Optional filters for listing agents. */
export interface AgentListFilters {
  runtime?: AgentRuntime;
  capability?: string;
}

// === Row Shape ===

/** Raw SQLite row for an agent (snake_case columns). */
interface AgentRow {
  id: string;
  name: string;
  description: string;
  project_path: string;
  runtime: string;
  capabilities_json: string;
  manifest_json: string;
  registered_at: string;
  registered_by: string;
  namespace: string;
  scan_root: string;
}

/** Raw SQLite row for an agent with health columns (snake_case). */
interface AgentHealthRow extends AgentRow {
  last_seen_at: string | null;
  last_seen_event: string | null;
  health_status: 'active' | 'inactive' | 'stale';
}

/** An agent entry with computed health status. */
export interface AgentHealthEntry extends AgentRegistryEntry {
  lastSeenAt: string | null;
  lastSeenEvent: string | null;
  healthStatus: 'active' | 'inactive' | 'stale';
}

/** Aggregate counts by health status. */
export interface AggregateStats {
  totalAgents: number;
  activeCount: number;
  inactiveCount: number;
  staleCount: number;
}

// === Migrations ===

const MIGRATIONS = [
  // Version 1: initial schema
  `CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    project_path TEXT NOT NULL UNIQUE,
    runtime TEXT NOT NULL,
    capabilities_json TEXT NOT NULL DEFAULT '[]',
    manifest_json TEXT NOT NULL,
    registered_at TEXT NOT NULL,
    registered_by TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_agents_project_path ON agents(project_path);
  CREATE INDEX IF NOT EXISTS idx_agents_runtime ON agents(runtime);`,
  // Version 2: health tracking columns
  `ALTER TABLE agents ADD COLUMN last_seen_at TEXT;
   ALTER TABLE agents ADD COLUMN last_seen_event TEXT;`,
  // Version 3: budget counters for sliding window rate limiting
  `CREATE TABLE IF NOT EXISTS budget_counters (
    agent_id TEXT NOT NULL,
    bucket_minute INTEGER NOT NULL,
    call_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (agent_id, bucket_minute)
  );
  CREATE INDEX IF NOT EXISTS idx_budget_counters_agent ON budget_counters(agent_id);`,
  // Version 4: namespace and scan_root columns
  `ALTER TABLE agents ADD COLUMN namespace TEXT NOT NULL DEFAULT '';
   ALTER TABLE agents ADD COLUMN scan_root TEXT NOT NULL DEFAULT '';
   CREATE INDEX IF NOT EXISTS idx_agents_namespace ON agents(namespace);`,
];

// === AgentRegistry ===

/**
 * Persistent registry for discovered and registered agents.
 *
 * @example
 * ```typescript
 * const registry = new AgentRegistry('/home/user/.dork/mesh/mesh.db');
 * registry.insert({ id: ulid(), name: 'My Agent', projectPath: '/projects/my-agent', ... });
 * const agent = registry.getByPath('/projects/my-agent');
 * registry.close();
 * ```
 */
export class AgentRegistry {
  private readonly db: Database.Database;
  private readonly stmts: {
    insert: Database.Statement;
    getById: Database.Statement;
    getByPath: Database.Statement;
    listAll: Database.Statement;
    listByNamespace: Database.Statement;
    update: Database.Statement;
    remove: Database.Statement;
    updateHealth: Database.Statement;
    getWithHealth: Database.Statement;
    listWithHealth: Database.Statement;
    getAggregateStats: Database.Statement;
  };

  /**
   * Open (or create) the agent registry database.
   *
   * @param dbPath - Absolute path to the SQLite database file
   */
  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('foreign_keys = ON');

    this.runMigrations();

    this.stmts = {
      insert: this.db.prepare(
        `INSERT INTO agents (id, name, description, project_path, runtime, capabilities_json, manifest_json, registered_at, registered_by, namespace, scan_root)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      getById: this.db.prepare(`SELECT * FROM agents WHERE id = ?`),
      getByPath: this.db.prepare(`SELECT * FROM agents WHERE project_path = ?`),
      listAll: this.db.prepare(`SELECT * FROM agents ORDER BY registered_at DESC`),
      listByNamespace: this.db.prepare(`SELECT * FROM agents WHERE namespace = ? ORDER BY registered_at DESC`),
      update: this.db.prepare(
        `UPDATE agents SET name = ?, description = ?, runtime = ?, capabilities_json = ?, manifest_json = ? WHERE id = ?`,
      ),
      remove: this.db.prepare(`DELETE FROM agents WHERE id = ?`),
      updateHealth: this.db.prepare(
        `UPDATE agents SET last_seen_at = ?, last_seen_event = ? WHERE id = ?`,
      ),
      getWithHealth: this.db.prepare(`
        SELECT *, CASE
          WHEN last_seen_at IS NULL THEN 'stale'
          WHEN (julianday('now') - julianday(last_seen_at)) * 86400 < 300 THEN 'active'
          WHEN (julianday('now') - julianday(last_seen_at)) * 86400 < 1800 THEN 'inactive'
          ELSE 'stale'
        END AS health_status
        FROM agents WHERE id = ?
      `),
      listWithHealth: this.db.prepare(`
        SELECT *, CASE
          WHEN last_seen_at IS NULL THEN 'stale'
          WHEN (julianday('now') - julianday(last_seen_at)) * 86400 < 300 THEN 'active'
          WHEN (julianday('now') - julianday(last_seen_at)) * 86400 < 1800 THEN 'inactive'
          ELSE 'stale'
        END AS health_status
        FROM agents ORDER BY registered_at DESC
      `),
      getAggregateStats: this.db.prepare(`
        SELECT
          COUNT(*) AS total_agents,
          SUM(CASE WHEN last_seen_at IS NOT NULL AND (julianday('now') - julianday(last_seen_at)) * 86400 < 300 THEN 1 ELSE 0 END) AS active_count,
          SUM(CASE WHEN last_seen_at IS NOT NULL AND (julianday('now') - julianday(last_seen_at)) * 86400 BETWEEN 300 AND 1800 THEN 1 ELSE 0 END) AS inactive_count,
          SUM(CASE WHEN last_seen_at IS NULL OR (julianday('now') - julianday(last_seen_at)) * 86400 > 1800 THEN 1 ELSE 0 END) AS stale_count
        FROM agents
      `),
    };
  }

  /**
   * Insert a new agent into the registry.
   *
   * @param agent - The agent entry to insert (id and projectPath must be unique)
   * @throws If project_path already exists (UNIQUE constraint)
   */
  insert(agent: AgentRegistryEntry): void {
    this.stmts.insert.run(
      agent.id,
      agent.name,
      agent.description,
      agent.projectPath,
      agent.runtime,
      JSON.stringify(agent.capabilities),
      JSON.stringify(agent),
      agent.registeredAt,
      agent.registeredBy,
      agent.namespace ?? '',
      agent.scanRoot ?? '',
    );
  }

  /**
   * Look up an agent by ULID.
   *
   * @param id - The agent's ULID
   * @returns The agent entry, or undefined if not found
   */
  get(id: string): AgentRegistryEntry | undefined {
    const row = this.stmts.getById.get(id) as AgentRow | undefined;
    return row ? this.rowToEntry(row) : undefined;
  }

  /**
   * Look up an agent by its project path.
   *
   * @param projectPath - Absolute path to the project directory
   * @returns The agent entry, or undefined if not found
   */
  getByPath(projectPath: string): AgentRegistryEntry | undefined {
    const row = this.stmts.getByPath.get(projectPath) as AgentRow | undefined;
    return row ? this.rowToEntry(row) : undefined;
  }

  /**
   * List all registered agents, optionally filtered by runtime or capability.
   *
   * @param filters - Optional filters to narrow results
   * @returns Array of agent entries ordered by registration date (newest first)
   */
  list(filters?: AgentListFilters): AgentRegistryEntry[] {
    const rows = this.stmts.listAll.all() as AgentRow[];
    const entries = rows.map((row) => this.rowToEntry(row));

    if (!filters) return entries;

    return entries.filter((entry) => {
      if (filters.runtime && entry.runtime !== filters.runtime) return false;
      if (filters.capability && !entry.capabilities.includes(filters.capability)) return false;
      return true;
    });
  }

  /**
   * Update mutable fields of a registered agent.
   *
   * @param id - The agent's ULID
   * @param partial - Fields to update
   * @returns `true` if the agent was updated, `false` if not found
   */
  update(id: string, partial: Partial<AgentRegistryEntry>): boolean {
    const existing = this.get(id);
    if (!existing) return false;

    const merged: AgentRegistryEntry = { ...existing, ...partial, id };
    const result = this.stmts.update.run(
      merged.name,
      merged.description,
      merged.runtime,
      JSON.stringify(merged.capabilities),
      JSON.stringify(merged),
      id,
    );
    return result.changes > 0;
  }

  /**
   * Remove an agent from the registry.
   *
   * @param id - The agent's ULID
   * @returns `true` if the agent was removed, `false` if not found
   */
  remove(id: string): boolean {
    const result = this.stmts.remove.run(id);
    return result.changes > 0;
  }

  /**
   * Update health tracking fields for an agent.
   *
   * @param id - Agent ULID
   * @param lastSeenAt - ISO timestamp of last activity
   * @param lastSeenEvent - Description of the event (e.g., 'heartbeat', 'message_sent')
   * @returns true if agent was found and updated
   */
  updateHealth(id: string, lastSeenAt: string, lastSeenEvent: string): boolean {
    const result = this.stmts.updateHealth.run(lastSeenAt, lastSeenEvent, id);
    return result.changes > 0;
  }

  /**
   * Get a single agent with computed health status.
   *
   * @param id - Agent ULID
   * @returns The agent entry with health fields, or undefined if not found
   */
  getWithHealth(id: string): AgentHealthEntry | undefined {
    const row = this.stmts.getWithHealth.get(id) as AgentHealthRow | undefined;
    return row ? this.healthRowToEntry(row) : undefined;
  }

  /**
   * List all agents with computed health status.
   *
   * @param filters - Optional runtime/capability filters
   * @returns Array of agents with health status ordered by registration date (newest first)
   */
  listWithHealth(filters?: AgentListFilters): AgentHealthEntry[] {
    const rows = this.stmts.listWithHealth.all() as AgentHealthRow[];
    const entries = rows.map((row) => this.healthRowToEntry(row));
    if (!filters) return entries;
    return entries.filter((entry) => {
      if (filters.runtime && entry.runtime !== filters.runtime) return false;
      if (filters.capability && !entry.capabilities.includes(filters.capability)) return false;
      return true;
    });
  }

  /**
   * Get aggregate health statistics across all agents.
   *
   * @returns Counts of total, active, inactive, and stale agents
   */
  getAggregateStats(): AggregateStats {
    const row = this.stmts.getAggregateStats.get() as {
      total_agents: number;
      active_count: number;
      inactive_count: number;
      stale_count: number;
    };
    return {
      totalAgents: row.total_agents,
      activeCount: row.active_count,
      inactiveCount: row.inactive_count,
      staleCount: row.stale_count,
    };
  }

  /** Close the database connection. */
  close(): void {
    this.db.close();
  }

  /** Expose the underlying Database instance for shared use (e.g., DenialList). */
  get database(): Database.Database {
    return this.db;
  }

  private runMigrations(): void {
    const currentVersion = (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
    for (let i = currentVersion; i < MIGRATIONS.length; i++) {
      this.db.exec(MIGRATIONS[i]!);
      this.db.pragma(`user_version = ${i + 1}`);
    }
  }

  /**
   * List agents belonging to a specific namespace.
   *
   * @param namespace - The namespace to filter by
   * @returns Array of agent entries in the given namespace
   */
  listByNamespace(namespace: string): AgentRegistryEntry[] {
    const rows = this.stmts.listByNamespace.all(namespace) as AgentRow[];
    return rows.map((row) => this.rowToEntry(row));
  }

  private rowToEntry(row: AgentRow): AgentRegistryEntry {
    const manifest = JSON.parse(row.manifest_json) as AgentManifest;
    return {
      ...manifest,
      projectPath: row.project_path,
      namespace: row.namespace ?? '',
      scanRoot: row.scan_root ?? '',
    };
  }

  private healthRowToEntry(row: AgentHealthRow): AgentHealthEntry {
    const manifest = JSON.parse(row.manifest_json) as AgentManifest;
    return {
      ...manifest,
      projectPath: row.project_path,
      namespace: row.namespace ?? '',
      scanRoot: row.scan_root ?? '',
      lastSeenAt: row.last_seen_at,
      lastSeenEvent: row.last_seen_event,
      healthStatus: row.health_status,
    };
  }
}
