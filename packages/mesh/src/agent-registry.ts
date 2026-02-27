/**
 * Drizzle-backed agent registry for the Mesh module.
 *
 * Persists registered agent manifests in the consolidated DorkOS database,
 * providing fast lookup by ULID or project path. Uses Drizzle ORM query
 * builders against the `agents` table defined in @dorkos/db.
 *
 * @module mesh/agent-registry
 */
import { eq, desc, and, lt } from 'drizzle-orm';
import { agents } from '@dorkos/db';
import type { Db } from '@dorkos/db';
import type { AgentManifest, AgentRuntime } from '@dorkos/shared/mesh-schemas';
import { computeHealthStatus } from './health.js';

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
  unreachableCount: number;
}

// === AgentRegistry ===

/**
 * Persistent registry for discovered and registered agents.
 *
 * @example
 * ```typescript
 * const db = createDb(':memory:');
 * runMigrations(db);
 * const registry = new AgentRegistry(db);
 * registry.upsert({ id: ulid(), name: 'My Agent', projectPath: '/projects/my-agent', ... });
 * const agent = registry.getByPath('/projects/my-agent');
 * ```
 */
export class AgentRegistry {
  /**
   * Create an AgentRegistry backed by a Drizzle database instance.
   *
   * @param db - Drizzle database instance from createDb()
   */
  constructor(private readonly db: Db) {}

  /**
   * Insert or update an agent in the registry.
   *
   * Uses ON CONFLICT(id) DO UPDATE for idempotent registration.
   * Handles path conflicts by removing the stale entry first.
   *
   * @param agent - The agent entry to upsert
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

  /**
   * Look up an agent by ULID.
   *
   * @param id - The agent's ULID
   * @returns The agent entry, or undefined if not found
   */
  get(id: string): AgentRegistryEntry | undefined {
    const rows = this.db.select().from(agents).where(eq(agents.id, id)).all();
    const row = rows[0];
    return row ? this.rowToEntry(row) : undefined;
  }

  /**
   * Look up an agent by its project path.
   *
   * @param projectPath - Absolute path to the project directory
   * @returns The agent entry, or undefined if not found
   */
  getByPath(projectPath: string): AgentRegistryEntry | undefined {
    const rows = this.db.select().from(agents).where(eq(agents.projectPath, projectPath)).all();
    const row = rows[0];
    return row ? this.rowToEntry(row) : undefined;
  }

  /**
   * List all registered agents, optionally filtered by runtime or capability.
   *
   * @param filters - Optional filters to narrow results
   * @returns Array of agent entries ordered by registration date (newest first)
   */
  list(filters?: AgentListFilters): AgentRegistryEntry[] {
    const rows = this.db.select().from(agents).orderBy(desc(agents.registeredAt)).all();
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

  /**
   * Remove an agent from the registry.
   *
   * @param id - The agent's ULID
   * @returns `true` if the agent was removed, `false` if not found
   */
  remove(id: string): boolean {
    const result = this.db.delete(agents).where(eq(agents.id, id)).run();
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
    const result = this.db.update(agents).set({
      lastSeenAt,
      lastSeenEvent,
    }).where(eq(agents.id, id)).run();
    return result.changes > 0;
  }

  /**
   * Get a single agent with computed health status.
   *
   * @param id - Agent ULID
   * @returns The agent entry with health fields, or undefined if not found
   */
  getWithHealth(id: string): AgentHealthEntry | undefined {
    const rows = this.db.select().from(agents).where(eq(agents.id, id)).all();
    const row = rows[0];
    return row ? this.rowToHealthEntry(row) : undefined;
  }

  /**
   * List all agents with computed health status.
   *
   * @param filters - Optional runtime/capability filters
   * @returns Array of agents with health status ordered by registration date (newest first)
   */
  listWithHealth(filters?: AgentListFilters): AgentHealthEntry[] {
    const rows = this.db.select().from(agents).orderBy(desc(agents.registeredAt)).all();
    const entries = rows.map((row) => this.rowToHealthEntry(row));
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
    const rows = this.db.select().from(agents).all();
    let activeCount = 0;
    let inactiveCount = 0;
    let staleCount = 0;
    let unreachableCount = 0;

    for (const row of rows) {
      if (row.status === 'unreachable') {
        unreachableCount++;
        continue;
      }
      const status = computeHealthStatus(row.lastSeenAt);
      if (status === 'active') activeCount++;
      else if (status === 'inactive') inactiveCount++;
      else staleCount++;
    }

    return {
      totalAgents: rows.length,
      activeCount,
      inactiveCount,
      staleCount,
      unreachableCount,
    };
  }

  /**
   * List agents belonging to a specific namespace.
   *
   * @param namespace - The namespace to filter by
   * @returns Array of agent entries in the given namespace
   */
  listByNamespace(namespace: string): AgentRegistryEntry[] {
    const rows = this.db.select().from(agents)
      .where(eq(agents.namespace, namespace))
      .orderBy(desc(agents.registeredAt))
      .all();
    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * Mark an agent as unreachable (path no longer accessible).
   *
   * @param id - The agent's ULID
   * @returns `true` if the agent was updated, `false` if not found
   */
  markUnreachable(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db.update(agents).set({
      status: 'unreachable',
      updatedAt: now,
    }).where(eq(agents.id, id)).run();
    return result.changes > 0;
  }

  /**
   * List all agents with unreachable status.
   *
   * @returns Array of unreachable agent entries
   */
  listUnreachable(): AgentRegistryEntry[] {
    const rows = this.db.select().from(agents)
      .where(eq(agents.status, 'unreachable'))
      .all();
    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * List unreachable agents whose updatedAt is before the given ISO cutoff.
   *
   * @param cutoffIso - ISO 8601 timestamp; only entries updated before this are returned
   * @returns Array of unreachable agent entries past the cutoff
   */
  listUnreachableBefore(cutoffIso: string): AgentRegistryEntry[] {
    const rows = this.db.select().from(agents)
      .where(and(
        eq(agents.status, 'unreachable'),
        lt(agents.updatedAt, cutoffIso),
      ))
      .all();
    return rows.map((row) => this.rowToEntry(row));
  }

  /** Row type returned by Drizzle select from agents table. */
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

  /** Convert a row to an entry with computed health status. */
  private rowToHealthEntry(row: typeof agents.$inferSelect): AgentHealthEntry {
    return {
      ...this.rowToEntry(row),
      lastSeenAt: row.lastSeenAt,
      lastSeenEvent: row.lastSeenEvent,
      healthStatus: computeHealthStatus(row.lastSeenAt),
    };
  }
}
