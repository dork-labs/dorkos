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
import nodePath from 'node:path';
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
import { loadWorkspaceHookConfig, runHooks, type WorkspaceHookConfig } from './hooks.js';
import {
  inspectWorkspace,
  type WorkspaceGate,
  type WorkspaceInspection,
} from './workspace-gate.js';
import { writePortEnv } from './port-env.js';
import { assertSafeWorkspaceSource } from './providers/git.js';

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

/** A hook config holding only `commands`, for the one phase `runHooks` is asked to run. */
function hooksConfigOf(
  phase: 'after_create' | 'before_remove',
  commands: readonly string[]
): WorkspaceHookConfig {
  return {
    hooks: {
      after_create: [],
      before_run: [],
      after_run: [],
      before_remove: [],
      [phase]: [...commands],
    },
  };
}

/** Concrete WorkspaceManager. */
export class WorkspaceService implements WorkspaceManager {
  constructor(private readonly deps: WorkspaceServiceDeps) {}

  /**
   * Reuse the ready workspace for `(projectKey, key)`, or make it.
   *
   * Making one goes through `gate` (DOR-2335): a clone is staged under
   * `<root>/.staging/` and read there, and the source's `workspace.json` hooks
   * are read, before anything is recorded, moved into place or run. With no
   * gate, a new workspace is refused, so no caller makes one unseen by
   * forgetting it. Reusing a ready workspace needs none.
   *
   * @param req - What to reuse or make.
   * @param gate - Who has to see what a new workspace brings.
   */
  async ensure(req: EnsureWorkspaceRequest, gate?: WorkspaceGate): Promise<Workspace> {
    const key = sanitizeWorkspaceKey(req.key);
    const existing = this.deps.store.getByKey(req.projectKey, key);
    if (existing && existing.status === 'ready') {
      const touched = { ...existing, lastUsedAt: nowIso() };
      await this.deps.store.write(touched);
      return touched;
    }
    if (!gate) {
      throw new Error(
        'A workspace can only be made through a caller that shows what it brings (DOR-2335).'
      );
    }

    // Refused before anything is recorded or run (DOR-2326); each provider
    // asks again before its own git.
    assertSafeWorkspaceSource(req.source);
    const providerType = req.provider ?? this.deps.config.defaultProvider;
    const provider = this.deps.providers[providerType];
    const path = this.deps.store.checkoutPath(req.projectKey, key);
    const branch = `dork/${key}`;

    // Read what it brings where no session runs, and ask, before a port is
    // taken or a record written: a refusal leaves nothing behind.
    const hookConfig = await loadWorkspaceHookConfig(req.source);
    const staged =
      providerType === 'clone'
        ? await this.stageClone({ projectKey: req.projectKey, key, source: req.source, branch })
        : undefined;
    let approvedHooks: WorkspaceInspection['hooks'];
    try {
      const inspection = await inspectWorkspace({
        source: req.source,
        provider: providerType,
        destination: path,
        ...(staged && { staged }),
        hookConfig,
      });
      await gate(inspection);
      approvedHooks = inspection.hooks;
    } catch (err) {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      throw err;
    }

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
      // Stamped once, here, on the create path only — the reuse branch above
      // returns before this. An `ensure` that could re-own a workspace would
      // let a second caller adopt a checkout the first one is working in.
      owner: req.owner ?? null,
      createdAt: ts,
      lastUsedAt: ts,
    };
    // Persist 'provisioning' first so a crash mid-create is recoverable.
    await this.deps.store.write(ws);

    try {
      if (staged) {
        // The clone that was read is the clone that lands.
        await fs.mkdir(nodePath.dirname(path), { recursive: true });
        await fs.rename(staged, path);
      } else {
        await provider.create({
          projectKey: req.projectKey,
          key,
          path,
          source: req.source,
          branch,
        });
      }
      const ports = derivePorts(portBase);
      const portEnv = {
        DORKOS_PORT: String(ports.DORKOS_PORT),
        VITE_PORT: String(ports.VITE_PORT),
        SITE_PORT: String(ports.SITE_PORT),
      };
      // Only the commands that were shown, never a second read of the source.
      await runHooks('after_create', hooksConfigOf('after_create', approvedHooks.after_create), {
        cwd: path,
        env: portEnv,
      });
      await writePortEnv(path, ports);
      const ready: Workspace = {
        ...ws,
        status: 'ready',
        lastUsedAt: nowIso(),
        removeHooks: approvedHooks.before_remove,
      };
      await this.deps.store.write(ready);
      return ready;
    } catch (err) {
      if (staged) await fs.rm(staged, { recursive: true, force: true });
      const failed: Workspace = { ...ws, status: 'failed' };
      await this.deps.store.write(failed);
      logger.error(`[workspace] provisioning failed for ${req.projectKey}/${key}:`, err);
      throw err;
    }
  }

  async list(filter?: { projectKey?: string }): Promise<WorkspaceWithSessions[]> {
    const items = this.deps.store.list(filter);
    return Promise.all(
      items.map(async (ws) => {
        // Dirty state is best-effort and only meaningful for a ready checkout.
        let dirty: WorkspaceWithSessions['dirty'];
        if (ws.status === 'ready') {
          try {
            dirty = await this.deps.providers[ws.provider].isDirty(ws);
          } catch {
            dirty = undefined;
          }
        }
        return {
          ...ws,
          sessions: (await this.deps.listAttachedSessions?.(ws.path)) ?? [],
          dirty,
        };
      })
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

    // Only the before_remove commands shown when it was made, recorded in its
    // manifest (DOR-2335), never the source's workspace.json as it is now. A
    // workspace made before that record existed runs none: nobody saw them.
    const manifest = await this.deps.store.readManifest(ws.projectKey, ws.key);
    const removeHooks = manifest?.removeHooks;
    if (removeHooks === undefined) {
      const current = await loadWorkspaceHookConfig(ws.source);
      if ((current?.hooks.before_remove.length ?? 0) > 0) {
        logger.warn(
          `[workspace] not running before_remove hooks for ${ws.projectKey}/${ws.key}: ` +
            'nobody reviewed them when it was made'
        );
      }
    }
    await runHooks('before_remove', hooksConfigOf('before_remove', removeHooks ?? []), {
      cwd: ws.path,
    });
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
    const cap = this.deps.config.retentionCap;
    // `retentionCap: null` (the default) disables reclamation entirely.
    if (cap === null) return { removed, skipped };

    // Only ready checkouts are sweep-eligible; provisioning/failed/removing ones
    // belong to ensure()'s recovery path and the reconciler. The newest `cap`
    // workspaces (by lastUsedAt) are retained; older ones are reclaim candidates.
    const ready = this.deps.store
      .list()
      .filter((ws) => ws.status === 'ready')
      .sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));

    for (const ws of ready.slice(cap)) {
      // Ownership first, and structurally rather than by convention: an
      // agent-owned checkout is its agent's home, and reclaiming disk is never
      // a good enough reason to delete somebody's uncommitted work. Protecting
      // it by setting `pinned` instead would make the guarantee depend on
      // whoever provisioned it having remembered — a safety property nobody
      // remembers is not one.
      if (ws.owner) {
        skipped.push({ id: ws.id, reason: 'owned' });
        continue;
      }
      if (ws.pinned) {
        skipped.push({ id: ws.id, reason: 'pinned' });
        continue;
      }
      const sessions = (await this.deps.listAttachedSessions?.(ws.path)) ?? [];
      if (sessions.length > 0) {
        skipped.push({ id: ws.id, reason: 'active' });
        continue;
      }
      const result = await this.remove(ws.id, { force: false });
      if (result.removed) removed.push(ws.id);
      else if (result.blocked === 'dirty') skipped.push({ id: ws.id, reason: 'dirty' });
    }
    return { removed, skipped };
  }

  /**
   * Clone into a staging folder under the workspace root, where no scan lists
   * it, through the clone provider itself (and so its git protections).
   *
   * @returns The staged checkout.
   */
  private async stageClone(req: {
    projectKey: string;
    key: string;
    source: string;
    branch: string;
  }): Promise<string> {
    const staging = nodePath.join(this.deps.store.root, '.staging', ulid());
    await fs.mkdir(nodePath.dirname(staging), { recursive: true });
    try {
      await this.deps.providers.clone.create({ ...req, path: staging });
    } catch (err) {
      await fs.rm(staging, { recursive: true, force: true });
      throw err;
    }
    return staging;
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
