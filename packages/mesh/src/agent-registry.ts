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
import { EffortLevelSchema } from '@dorkos/shared/schemas';
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

/**
 * What {@link AgentRegistry.upsert} did.
 *
 * - `registered` — the row was inserted or updated in place.
 * - `duplicate-id` — this id already belongs to a row at a DIFFERENT directory,
 *   so nothing at all was written. A value rather than a throw, because the
 *   caller (the discovery layer) has to go and read the incumbent's manifest
 *   before it can tell a theft from a genuine move — and a scan must not abort
 *   on either.
 */
export type UpsertResult = 'registered' | 'duplicate-id';

/** An agent entry with computed health status. */
export interface AgentHealthEntry extends AgentRegistryEntry {
  lastSeenAt: string | null;
  lastSeenEvent: string | null;
  healthStatus: 'active' | 'inactive' | 'stale' | 'unreachable';
}

/** Aggregate counts by health status with runtime/project groupings. */
export interface AggregateStats {
  totalAgents: number;
  activeCount: number;
  inactiveCount: number;
  staleCount: number;
  unreachableCount: number;
  /** Agent counts grouped by runtime. */
  byRuntime: Record<string, number>;
  /** Agent counts grouped by project path. */
  byProject: Record<string, number>;
}

// === AgentRegistry ===

/**
 * Persistent registry for discovered and registered agents.
 *
 * ADR-0043: this is a **derived cache/index** — `.dork/agent.json` files on
 * disk are the canonical source of truth. All writes should go through
 * MeshCore, which writes to disk first and then updates this registry.
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
   * Insert or update an agent in the registry — and refuse, writing nothing at
   * all, when the incoming id already lives somewhere else.
   *
   * **`upsert` never moves a row between directories.** `.dork/agent.json` is
   * git-tracked, so every clone and linked worktree of an agent's repo carries
   * the same manifest ULID; the old `ON CONFLICT(id) DO UPDATE` rewrote
   * `project_path` to whichever copy a scan reached last, and the agent's
   * `@handle`, `responseMode` and room membership silently followed it
   * (ADR 260801-003050). A genuine move goes through {@link AgentRegistry.relocate},
   * which the discovery layer calls only after reading the incumbent directory's
   * manifest and finding the id released.
   *
   * **The refusal is decided before any mutation, and the ordering is the whole
   * safety of it.** This method used to delete a different-id row sitting at the
   * incoming path FIRST. Combined with a refusal that would have destroyed data:
   * `/w` registered as agent X, `/w` checks out a branch carrying agent D's
   * committed manifest, the scan yields D at `/w` — X deleted, D refused, `/w`
   * agent-less and X gone. So the id conflict is resolved first and the
   * path-incumbent delete fires only when the registration actually proceeds.
   *
   * @param agent - The agent entry to upsert
   * @returns `registered` when the row was written, `duplicate-id` when this id
   *   already sits at another directory and nothing was touched.
   */
  upsert(agent: AgentRegistryEntry): UpsertResult {
    const now = new Date().toISOString();

    // FIRST: would this move an existing row to a new directory? If so, nothing
    // below runs — not the path-incumbent delete, not the write.
    const existingById = this.get(agent.id);
    if (existingById && existingById.projectPath !== agent.projectPath) return 'duplicate-id';

    // Check for path conflict: different agent ID at same path
    const existingAtPath = this.getByPath(agent.projectPath);
    if (existingAtPath && existingAtPath.id !== agent.id) {
      this.remove(existingAtPath.id);
    }

    this.db
      .insert(agents)
      .values({
        id: agent.id,
        name: agent.name,
        displayName: agent.displayName ?? null,
        description: agent.description ?? '',
        projectPath: agent.projectPath,
        runtime: agent.runtime,
        capabilities: JSON.stringify(agent.capabilities),
        namespace: agent.namespace ?? 'default',
        scanRoot: agent.scanRoot ?? '',
        behaviorJson: JSON.stringify(agent.behavior),
        approver: agent.registeredBy,
        persona: agent.persona ?? null,
        personaEnabled: agent.personaEnabled ?? true,
        isSystem: agent.isSystem ?? false,
        color: agent.color ?? null,
        icon: agent.icon ?? null,
        model: agent.model ?? null,
        effort: agent.effort ?? null,
        account: agent.account ?? null,
        registeredAt: agent.registeredAt,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: {
          name: agent.name,
          displayName: agent.displayName ?? null,
          description: agent.description ?? '',
          projectPath: agent.projectPath,
          runtime: agent.runtime,
          capabilities: JSON.stringify(agent.capabilities),
          namespace: agent.namespace ?? 'default',
          scanRoot: agent.scanRoot ?? '',
          behaviorJson: JSON.stringify(agent.behavior),
          persona: agent.persona ?? null,
          personaEnabled: agent.personaEnabled ?? true,
          isSystem: agent.isSystem ?? false,
          color: agent.color ?? null,
          icon: agent.icon ?? null,
          model: agent.model ?? null,
          effort: agent.effort ?? null,
          account: agent.account ?? null,
          updatedAt: now,
          status: 'active', // Re-registration clears unreachable
        },
      })
      .run();

    return 'registered';
  }

  /**
   * Move a registered agent to a new directory — the one write path that may.
   *
   * Explicit, so relocation can never happen by accident: {@link AgentRegistry.upsert}
   * refuses an id that has moved, and only the discovery layer calls this, only
   * after reading the incumbent directory's manifest and finding the id
   * genuinely released (ADR 260801-003050).
   *
   * **It owns the destination's incumbent, in one transaction.**
   * `agents.project_path` is `NOT NULL UNIQUE`, so a different-id row already
   * sitting at `newPath` would otherwise make this throw a constraint error
   * inside the discovery generator and abort a whole scan. That state is
   * reachable, not theoretical: `/w` registered as X, D's manifest appears at
   * `/w`, and D's old home has lost its manifest. Deleting the incumbent and
   * moving the row is the same replace-the-path-incumbent semantics `upsert`
   * applies when a registration proceeds — done atomically so a crash between
   * the two cannot leave the agent nowhere.
   *
   * @param id - The agent's ULID.
   * @param newPath - Absolute path the agent now lives at.
   * @returns `true` when the row was moved, `false` when no agent carries that id.
   */
  relocate(id: string, newPath: string): boolean {
    const existing = this.get(id);
    if (!existing) return false;
    if (existing.projectPath === newPath) return true;

    const now = new Date().toISOString();
    return this.db.transaction((tx) => {
      const incumbent = tx.select().from(agents).where(eq(agents.projectPath, newPath)).all()[0];
      if (incumbent && incumbent.id !== id) {
        tx.delete(agents).where(eq(agents.id, incumbent.id)).run();
      }
      const result = tx
        .update(agents)
        .set({ projectPath: newPath, updatedAt: now, status: 'active' })
        .where(eq(agents.id, id))
        .run();
      return result.changes > 0;
    });
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
   * Check whether a project path is already registered.
   *
   * @param projectPath - Absolute path to the project directory
   * @returns true if an agent is registered at this path
   */
  isRegistered(projectPath: string): boolean {
    return this.getByPath(projectPath) !== undefined;
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
    const result = this.db
      .update(agents)
      .set({
        name: merged.name,
        displayName: merged.displayName ?? null,
        description: merged.description,
        runtime: merged.runtime,
        capabilities: JSON.stringify(merged.capabilities),
        namespace: merged.namespace,
        scanRoot: merged.scanRoot,
        behaviorJson: JSON.stringify(merged.behavior),
        persona: merged.persona ?? null,
        personaEnabled: merged.personaEnabled ?? true,
        isSystem: merged.isSystem ?? false,
        color: merged.color ?? null,
        icon: merged.icon ?? null,
        model: merged.model ?? null,
        effort: merged.effort ?? null,
        account: merged.account ?? null,
        updatedAt: now,
      })
      .where(eq(agents.id, id))
      .run();
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
    const result = this.db
      .update(agents)
      .set({
        lastSeenAt,
        lastSeenEvent,
      })
      .where(eq(agents.id, id))
      .run();
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
   * Computes health counts, runtime groupings, and project groupings in a
   * single pass over all rows, eliminating the need for a separate query.
   *
   * @returns Counts of total, active, inactive, stale agents with runtime/project groupings
   */
  getAggregateStats(): AggregateStats {
    const rows = this.db.select().from(agents).all();
    let activeCount = 0;
    let inactiveCount = 0;
    let staleCount = 0;
    let unreachableCount = 0;
    const byRuntime: Record<string, number> = {};
    const byProject: Record<string, number> = {};

    for (const row of rows) {
      // Health status
      if (row.status === 'unreachable') {
        unreachableCount++;
      } else {
        const status = computeHealthStatus(row.lastSeenAt);
        if (status === 'active') activeCount++;
        else if (status === 'inactive') inactiveCount++;
        else staleCount++;
      }

      // Runtime grouping
      byRuntime[row.runtime] = (byRuntime[row.runtime] ?? 0) + 1;

      // Project grouping
      const project = row.projectPath || 'unknown';
      byProject[project] = (byProject[project] ?? 0) + 1;
    }

    return {
      totalAgents: rows.length,
      activeCount,
      inactiveCount,
      staleCount,
      unreachableCount,
      byRuntime,
      byProject,
    };
  }

  /**
   * List agents belonging to a specific namespace.
   *
   * @param namespace - The namespace to filter by
   * @returns Array of agent entries in the given namespace
   */
  listByNamespace(namespace: string): AgentRegistryEntry[] {
    const rows = this.db
      .select()
      .from(agents)
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
    const result = this.db
      .update(agents)
      .set({
        status: 'unreachable',
        updatedAt: now,
      })
      .where(eq(agents.id, id))
      .run();
    return result.changes > 0;
  }

  /**
   * Clear an agent's unreachable status (path is accessible again).
   *
   * Counterpart to {@link markUnreachable}: resets the status to `active`
   * so the agent is no longer a candidate for grace-period removal.
   *
   * @param id - The agent's ULID
   * @returns `true` if the agent was updated, `false` if not found
   */
  markReachable(id: string): boolean {
    const now = new Date().toISOString();
    const result = this.db
      .update(agents)
      .set({
        status: 'active',
        updatedAt: now,
      })
      .where(eq(agents.id, id))
      .run();
    return result.changes > 0;
  }

  /**
   * List all agents with unreachable status.
   *
   * @returns Array of unreachable agent entries
   */
  listUnreachable(): AgentRegistryEntry[] {
    const rows = this.db.select().from(agents).where(eq(agents.status, 'unreachable')).all();
    return rows.map((row) => this.rowToEntry(row));
  }

  /**
   * List unreachable agents whose updatedAt is before the given ISO cutoff.
   *
   * @param cutoffIso - ISO 8601 timestamp; only entries updated before this are returned
   * @returns Array of unreachable agent entries past the cutoff
   */
  listUnreachableBefore(cutoffIso: string): AgentRegistryEntry[] {
    const rows = this.db
      .select()
      .from(agents)
      .where(and(eq(agents.status, 'unreachable'), lt(agents.updatedAt, cutoffIso)))
      .all();
    return rows.map((row) => this.rowToEntry(row));
  }

  /** Row type returned by Drizzle select from agents table. */
  private rowToEntry(row: typeof agents.$inferSelect): AgentRegistryEntry {
    return {
      id: row.id,
      name: row.name,
      displayName: row.displayName ?? undefined,
      description: row.description ?? '',
      runtime: row.runtime as AgentRuntime,
      capabilities: JSON.parse(row.capabilities) as string[],
      behavior: JSON.parse(row.behaviorJson),
      namespace: row.namespace,
      registeredAt: row.registeredAt,
      registeredBy: row.approver ?? 'mesh',
      projectPath: row.projectPath,
      scanRoot: row.scanRoot,
      persona: row.persona ?? undefined,
      personaEnabled: row.personaEnabled,
      isSystem: row.isSystem ?? false,
      color: row.color ?? undefined,
      icon: row.icon ?? undefined,
      model: row.model ?? undefined,
      // Parsed, not cast: a rung a later release drops, or a hand-edited row,
      // means "no preference" rather than travelling into an adapter as a value
      // nothing understands — the same hardening the session settings got.
      effort: EffortLevelSchema.safeParse(row.effort).data,
      // An empty string would be an id nothing can match, so it reads as "no
      // preference" rather than travelling into the launch ladder as a
      // reference that always misses.
      account: row.account || undefined,
      // enabledToolGroups is not persisted in the DB schema, so this cache cannot
      // answer for it and hands back the empty default. **`{}` here does NOT mean
      // "inherit global" any more**: the four documentation keys do inherit, but
      // `roomsManage` (DOR-1611) is a grant where absent means OFF, so an empty
      // object reads as "no grant" for that key.
      //
      // Nothing may make an authorization decision from this value. The tool-group
      // gate reads `.dork/agent.json` directly for exactly that reason — asking
      // here would report every agent as ungranted AND silently ignore a real
      // grant a person had set. A future migration may add a JSON column; until
      // then the manifest file is the only place the answer exists.
      enabledToolGroups: {},
      // mcpServers is manifest-file-only by design (no DB column, no reconciler
      // diff — ADR 260803-233420). The derived cache carries the empty default;
      // the file remains the source of truth for managed servers.
      mcpServers: [],
      // Same shape as the two above: no DB column, so the cache carries the
      // schema default and `.dork/agent.json` remains the source of truth. The
      // one consumer that must be right — `resolve-session-cwd.ts`, which picks
      // the directory a turn runs in — reads the manifest, never this. Anything
      // added later that shows a binding in a LIST view needs a real column
      // first, on the pattern `model`/`effort` set.
      workspace: { mode: 'home' },
    };
  }

  /** Convert a row to an entry with computed health status. */
  private rowToHealthEntry(row: typeof agents.$inferSelect): AgentHealthEntry {
    return {
      ...this.rowToEntry(row),
      lastSeenAt: row.lastSeenAt,
      lastSeenEvent: row.lastSeenEvent,
      // The persisted status column wins: an agent whose path is gone is
      // unreachable regardless of how recently it was last seen. Keeps
      // per-agent health consistent with getAggregateStats().
      healthStatus:
        row.status === 'unreachable' ? 'unreachable' : computeHealthStatus(row.lastSeenAt),
    };
  }
}
