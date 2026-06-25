/**
 * `worktree` WorkspaceProvider — provisions an isolated checkout via
 * `git worktree add` from an existing local checkout (fast, shared object
 * store). This is what the operator-run `gtr` flow does today, graduated into a
 * server-managed provider.
 *
 * @module server/services/workspace/providers/worktree
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

/** Provisions workspaces as git worktrees of a local source checkout. */
export class WorktreeProvider implements WorkspaceProvider {
  readonly type = 'worktree' as const;

  /** @param root - The workspace root; every checkout path must canonicalize under it. */
  constructor(private readonly root: string) {}

  async create(req: WorkspaceCreateRequest): Promise<ProviderResult> {
    await validateBoundary(req.path, this.root);
    // `git worktree add <path> -b <branch>` runs from the source checkout.
    await runGit(['worktree', 'add', req.path, '-b', req.branch], req.source);
    return { path: req.path, branch: req.branch };
  }

  async remove(workspace: Workspace, opts: { force: boolean }): Promise<void> {
    const args = ['worktree', 'remove', workspace.path];
    if (opts.force) args.push('--force');
    await runGit(args, workspace.source);
    // `worktree remove` leaves a non-empty dir only on failure; tidy any remnant.
    await fs.rm(workspace.path, { recursive: true, force: true });
  }

  isDirty(workspace: Workspace): Promise<DirtyState> {
    return computeDirtyState(workspace.path);
  }
}
