/**
 * `clone` WorkspaceProvider — provisions an isolated checkout via a fresh
 * `git clone`. Works when DorkOS manages a repo the user has not checked out
 * locally (Symphony-style), at the cost of a full clone vs the worktree's shared
 * object store.
 *
 * @module server/services/workspace/providers/clone
 */
import { promises as fs } from 'node:fs';
import { validateBoundary } from '../../../lib/boundary.js';
import type {
  Workspace,
  WorkspaceProvider,
  WorkspaceCreateRequest,
  ProviderResult,
  DirtyState,
} from '@dorkos/shared/workspace';
import { runGit, computeDirtyState } from './git.js';

/** Provisions workspaces as fresh clones of a source repo URL or path. */
export class CloneProvider implements WorkspaceProvider {
  readonly type = 'clone' as const;

  /** @param root - The workspace root; every checkout path must canonicalize under it. */
  constructor(private readonly root: string) {}

  async create(req: WorkspaceCreateRequest): Promise<ProviderResult> {
    await validateBoundary(req.path, this.root);
    await runGit(['clone', req.source, req.path], this.root);
    await runGit(['checkout', '-b', req.branch], req.path);
    return { path: req.path, branch: req.branch };
  }

  async remove(workspace: Workspace, _opts: { force: boolean }): Promise<void> {
    // Caller has already passed the dirty gate; a clone is a plain directory.
    await fs.rm(workspace.path, { recursive: true, force: true });
  }

  isDirty(workspace: Workspace): Promise<DirtyState> {
    return computeDirtyState(workspace.path);
  }
}
