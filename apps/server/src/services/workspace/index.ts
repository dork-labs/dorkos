/**
 * Workspace subsystem barrel + factory (DOR-84).
 *
 * `createWorkspaceSubsystem` wires the store, allocator, providers, service, and
 * reconciler from resolved config; `set/getWorkspaceManager` provide the
 * module-singleton the routes read (mirrors the `runtimeRegistry` access idiom).
 *
 * @module server/services/workspace
 */
import path from 'node:path';
import type { Db } from '@dorkos/db';
import type { UserConfig } from '@dorkos/shared/config-schema';
import type { AttachedSession, WorkspaceManager } from '@dorkos/shared/workspace';
import { WorkspaceStore } from './workspace-store.js';
import { PortAllocator } from './port-allocator.js';
import { WorktreeProvider } from './providers/worktree.js';
import { CloneProvider } from './providers/clone.js';
import { WorkspaceService } from './workspace-service.js';
import { WorkspaceReconciler } from './workspace-reconciler.js';

/** The resolved `workspace` config section. */
export type WorkspaceConfig = UserConfig['workspace'];

/** The wired workspace subsystem. */
export interface WorkspaceSubsystem {
  service: WorkspaceService;
  reconciler: WorkspaceReconciler;
  store: WorkspaceStore;
  root: string;
}

/**
 * Wire the workspace subsystem from config + the DB handle.
 *
 * @param opts.db - The consolidated DB handle.
 * @param opts.dorkHome - The resolved data dir (root = `<dorkHome>/workspaces` unless overridden).
 * @param opts.config - The resolved `workspace` config section.
 * @param opts.listAttachedSessions - Resolver for sessions bound to a workspace path.
 */
export function createWorkspaceSubsystem(opts: {
  db: Db;
  dorkHome: string;
  config: WorkspaceConfig;
  listAttachedSessions?: (workspacePath: string) => AttachedSession[] | Promise<AttachedSession[]>;
}): WorkspaceSubsystem {
  const root = opts.config.rootPath ?? path.join(opts.dorkHome, 'workspaces');
  const store = new WorkspaceStore(opts.db, root);
  const allocator = new PortAllocator(
    { portBase: opts.config.portBase, portBlockSize: opts.config.portBlockSize },
    () => store.list().map((w) => w.portBase)
  );
  const providers = {
    worktree: new WorktreeProvider(root),
    clone: new CloneProvider(root),
  };
  const service = new WorkspaceService({
    store,
    allocator,
    providers,
    config: {
      defaultProvider: opts.config.defaultProvider,
      portBlockSize: opts.config.portBlockSize,
      retentionCap: opts.config.retentionCap,
    },
    listAttachedSessions: opts.listAttachedSessions,
  });
  const reconciler = new WorkspaceReconciler(store);
  return { service, reconciler, store, root };
}

let active: WorkspaceManager | null = null;

/** Register the active WorkspaceManager at bootstrap. */
export function setWorkspaceManager(manager: WorkspaceManager): void {
  active = manager;
}

/** Read the active WorkspaceManager (throws if bootstrap has not run). */
export function getWorkspaceManager(): WorkspaceManager {
  if (!active) throw new Error('WorkspaceManager not initialized');
  return active;
}

export { WorkspaceService } from './workspace-service.js';
export { WorkspaceStore } from './workspace-store.js';
export { WorkspaceReconciler } from './workspace-reconciler.js';
