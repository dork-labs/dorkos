/**
 * The WorkspaceManager service — composes the store (file-first persistence),
 * the port allocator, the providers (worktree/clone), and the lifecycle hooks
 * into the one lifecycle API the routes, Transport, and session-binding path
 * consume.
 *
 * `ensure` is idempotent on `(projectKey, key)` (reuse-or-create);
 * `resolveByPath` powers the session-view workspace indicator; `remove`/`sweep`
 * are dirty-gated (the conservative-cleanup safety invariant).
 *
 * @module server/services/workspace/workspace-service
 */
import { promises as fs } from 'node:fs';
import { ulid } from 'ulidx';
import {
  derivePorts,
  sanitizeWorkspaceKey,
  type Workspace,
  type WorkspaceManager,
  type WorkspaceProvider,
  type WorkspaceProviderType,
  type EnsureWorkspaceRequest,
  type RemoveResult,
  type SweepResult,
  type WorkspaceWithSessions,
  type AttachedSession,
} from '@dorkos/shared/workspace';
import { logger } from '../../lib/logger.js';
import type { WorkspaceStore } from './workspace-store.js';
import type { PortAllocator } from './port-allocator.js';
import { loadWorkspaceHookConfig, runHooks } from './hooks.js';
import { writePortEnv } from './port-env.js';

/** Resolved `workspace` config the service needs. */
export interface WorkspaceServiceConfig {
  defaultProvider: WorkspaceProviderType;
  portBlockSize: number;
  retentionCap: number | null;
}

/** Collaborators injected into the service (real ones wired in `index.ts`). */
export interface WorkspaceServiceDeps {
  store: WorkspaceStore;
  allocator: PortAllocator;
  providers: Record<WorkspaceProviderType, WorkspaceProvider>;
  config: WorkspaceServiceConfig;
  /** Resolve the sessions whose cwd is under a workspace path (cwd-prefix). */
  listAttachedSessions?: (workspacePath: string) => AttachedSession[] | Promise<AttachedSession[]>;
}

const nowIso = (): string => new Date().toISOString();

/** Concrete WorkspaceManager. */
export class WorkspaceService implements WorkspaceManager {
  constructor(private readonly deps: WorkspaceServiceDeps) {}

  async ensure(req: EnsureWorkspaceRequest): Promise<Workspace> {
    const key = sanitizeWorkspaceKey(req.key);
    const existing = this.deps.store.getByKey(req.projectKey, key);
    if (existing && existing.status === 'ready') {
      const touched = { ...existing, lastUsedAt: nowIso() };
      await this.deps.store.write(touched);
      return touched;
    }

    const providerType = req.provider ?? this.deps.config.defaultProvider;
    const provider = this.deps.providers[providerType];
    const path = this.deps.store.checkoutPath(req.projectKey, key);
    const branch = `dork/${key}`;
    const portBase = this.deps.allocator.allocate();
    const ts = nowIso();

    const ws: Workspace = {
      id: ulid(),
      projectKey: req.projectKey,
      key,
      path,
      source: req.source,
      branch,
      provider: providerType,
      status: 'provisioning',
      portBase,
      portBlockSize: this.deps.config.portBlockSize,
      hostname: null,
      url: null,
      pinned: false,
      createdAt: ts,
      lastUsedAt: ts,
    };
    // Persist 'provisioning' first so a crash mid-create is recoverable.
    await this.deps.store.write(ws);

    try {
      await provider.create({ projectKey: req.projectKey, key, path, source: req.source, branch });
      const hookConfig = await loadWorkspaceHookConfig(req.source);
      const ports = derivePorts(portBase);
      const portEnv = {
        DORKOS_PORT: String(ports.DORKOS_PORT),
        VITE_PORT: String(ports.VITE_PORT),
        SITE_PORT: String(ports.SITE_PORT),
      };
      await runHooks('after_create', hookConfig, { cwd: path, env: portEnv });
      await writePortEnv(path, ports);
      const ready: Workspace = { ...ws, status: 'ready', lastUsedAt: nowIso() };
      await this.deps.store.write(ready);
      return ready;
    } catch (err) {
      const failed: Workspace = { ...ws, status: 'failed' };
      await this.deps.store.write(failed);
      logger.error(`[workspace] provisioning failed for ${req.projectKey}/${key}:`, err);
      throw err;
    }
  }

  async list(filter?: { projectKey?: string }): Promise<WorkspaceWithSessions[]> {
    const items = this.deps.store.list(filter);
    return Promise.all(
      items.map(async (ws) => ({
        ...ws,
        sessions: (await this.deps.listAttachedSessions?.(ws.path)) ?? [],
      }))
    );
  }

  async get(id: string): Promise<Workspace | null> {
    return this.deps.store.getById(id);
  }

  async resolveByPath(absPath: string): Promise<Workspace | null> {
    return this.deps.store.findContaining(absPath);
  }

  async remove(id: string, opts: { force: boolean }): Promise<RemoveResult> {
    const ws = this.deps.store.getById(id);
    if (!ws) return { removed: false };

    const provider = this.deps.providers[ws.provider];
    if (!opts.force) {
      const dirty = await provider.isDirty(ws);
      if (dirty.dirty) return { removed: false, blocked: 'dirty', dirty };
    }

    const hookConfig = await loadWorkspaceHookConfig(ws.source);
    await runHooks('before_remove', hookConfig, { cwd: ws.path });
    await this.deps.store.write({ ...ws, status: 'removing' });
    await provider.remove(ws, opts);
    await this.deps.store.remove(ws);
    return { removed: true };
  }

  async setPinned(id: string, pinned: boolean): Promise<Workspace> {
    const ws = this.deps.store.getById(id);
    if (!ws) throw new Error(`Workspace not found: ${id}`);
    const updated = { ...ws, pinned };
    await this.deps.store.write(updated);
    return updated;
  }

  async sweep(): Promise<SweepResult> {
    const removed: string[] = [];
    const skipped: SweepResult['skipped'] = [];
    for (const ws of this.deps.store.list()) {
      if (ws.pinned) {
        skipped.push({ id: ws.id, reason: 'pinned' });
        continue;
      }
      const result = await this.remove(ws.id, { force: false });
      if (result.removed) removed.push(ws.id);
      else if (result.blocked === 'dirty') skipped.push({ id: ws.id, reason: 'dirty' });
    }
    return { removed, skipped };
  }

  /** Best-effort: does this checkout dir still exist on disk? (reconciler helper) */
  static async checkoutExists(workspacePath: string): Promise<boolean> {
    try {
      await fs.access(workspacePath);
      return true;
    } catch {
      return false;
    }
  }
}
