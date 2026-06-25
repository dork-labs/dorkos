/**
 * File-first write-through persistence for workspaces (ADR-0043).
 *
 * The per-workspace sidecar manifest `<root>/<projectKey>/<key>.workspace.json`
 * is the source of truth; the SQLite `workspaces` table is a derived cache. Every
 * mutation writes the manifest atomically (temp + rename) FIRST, then upserts the
 * cache row; removal deletes the manifest first, then the row. The reconciler
 * rebuilds the cache from manifests.
 *
 * @module server/services/workspace/workspace-store
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { workspaces } from '@dorkos/db';
import type { Db } from '@dorkos/db';
import type { Workspace } from '@dorkos/shared/workspace';

/** A row as stored in / read from the `workspaces` cache table. */
type WorkspaceRow = typeof workspaces.$inferSelect;

/** Map a domain entity to a cache row (near-identity; Drizzle handles boolean↔int). */
function toRow(ws: Workspace): typeof workspaces.$inferInsert {
  return { ...ws };
}

/** Map a cache row back to a domain entity, narrowing the stringly-typed enums. */
function fromRow(row: WorkspaceRow): Workspace {
  return {
    ...row,
    provider: row.provider as Workspace['provider'],
    status: row.status as Workspace['status'],
  };
}

/**
 * File-first store for workspace entities. Construct with the DB handle and the
 * resolved workspace root (`config.workspace.rootPath ?? <dorkHome>/workspaces`).
 */
export class WorkspaceStore {
  constructor(
    private readonly db: Db,
    private readonly root: string
  ) {}

  /** Absolute path of a workspace's sidecar manifest (never inside the checkout). */
  manifestPath(projectKey: string, key: string): string {
    return path.join(this.root, projectKey, `${key}.workspace.json`);
  }

  /** The default checkout directory for a workspace key. */
  checkoutPath(projectKey: string, key: string): string {
    return path.join(this.root, projectKey, key);
  }

  /** Write-through: persist the manifest atomically, then upsert the cache row. */
  async write(ws: Workspace): Promise<void> {
    const dir = path.join(this.root, ws.projectKey);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, `.${randomUUID()}.tmp`);
    await fs.writeFile(tmp, JSON.stringify(ws, null, 2) + '\n', 'utf-8');
    await fs.rename(tmp, this.manifestPath(ws.projectKey, ws.key));
    this.upsertRow(ws);
  }

  /** Upsert only the derived cache row (used by the reconciler syncing from disk). */
  upsertRow(ws: Workspace): void {
    this.db
      .insert(workspaces)
      .values(toRow(ws))
      .onConflictDoUpdate({ target: workspaces.id, set: toRow(ws) })
      .run();
  }

  /** Remove the manifest first, then the cache row (ADR-0043 deletion order). */
  async remove(ws: Workspace): Promise<void> {
    await fs.rm(this.manifestPath(ws.projectKey, ws.key), { force: true });
    this.db.delete(workspaces).where(eq(workspaces.id, ws.id)).run();
  }

  /** Drop only the cache row (reconciler use, when a manifest has vanished). */
  removeRow(id: string): void {
    this.db.delete(workspaces).where(eq(workspaces.id, id)).run();
  }

  getById(id: string): Workspace | null {
    const row = this.db.select().from(workspaces).where(eq(workspaces.id, id)).get();
    return row ? fromRow(row) : null;
  }

  getByKey(projectKey: string, key: string): Workspace | null {
    return this.list({ projectKey }).find((ws) => ws.key === key) ?? null;
  }

  list(filter?: { projectKey?: string }): Workspace[] {
    const rows = filter?.projectKey
      ? this.db.select().from(workspaces).where(eq(workspaces.projectKey, filter.projectKey)).all()
      : this.db.select().from(workspaces).all();
    return rows.map(fromRow);
  }

  /**
   * Find the workspace whose checkout contains `absPath` (the cwd→workspace
   * lookup behind the session indicator). Matches on canonical path prefix.
   */
  findContaining(absPath: string): Workspace | null {
    const target = path.resolve(absPath);
    for (const ws of this.list()) {
      const root = path.resolve(ws.path);
      if (target === root || target.startsWith(root + path.sep)) return ws;
    }
    return null;
  }

  /** Read the manifest directly from disk (source of truth) — reconciler use. */
  async readManifest(projectKey: string, key: string): Promise<Workspace | null> {
    try {
      const raw = await fs.readFile(this.manifestPath(projectKey, key), 'utf-8');
      return JSON.parse(raw) as Workspace;
    } catch {
      return null;
    }
  }
}
