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
import {
  assertSafeWorkspaceSource,
  computeDirtyState,
  isBareRepository,
  PERSON_REPO_GIT_CONFIG,
  runGit,
} from './git.js';

/** Provisions workspaces as git worktrees of a local source checkout. */
export class WorktreeProvider implements WorkspaceProvider {
  readonly type = 'worktree' as const;

  /**
   * Bind the provider to one workspace root.
   *
   * @param root - The workspace root; every checkout path must canonicalize under it.
   */
  constructor(private readonly root: string) {}

  async create(req: WorkspaceCreateRequest): Promise<ProviderResult> {
    await validateBoundary(req.path, this.root);
    assertSafeWorkspaceSource(req.source);
    // `git worktree add -b <branch> <path>` runs from the source checkout, as
    // the person's own git would: their hooks run. A bare source is named
    // with `--git-dir`, because safe.bareRepository=explicit refuses a bare
    // repository git only finds by where it runs (DOR-2326).
    // `--end-of-options` keeps the path a value, never a flag.
    const gitDir = (await isBareRepository(req.source)) ? [`--git-dir=${req.source}`] : [];
    await runGit(
      [...gitDir, 'worktree', 'add', '-b', req.branch, '--end-of-options', req.path],
      req.source,
      {
        config: PERSON_REPO_GIT_CONFIG,
      }
    );
    return { path: req.path, branch: req.branch };
  }

  async remove(workspace: Workspace, opts: { force: boolean }): Promise<void> {
    const args = ['worktree', 'remove', ...(opts.force ? ['--force'] : [])];
    args.push('--end-of-options', workspace.path);
    const gitDir = (await isBareRepository(workspace.source))
      ? [`--git-dir=${workspace.source}`]
      : [];
    await runGit([...gitDir, ...args], workspace.source);
    // `worktree remove` leaves a non-empty dir only on failure; tidy any remnant.
    await fs.rm(workspace.path, { recursive: true, force: true });
  }

  isDirty(workspace: Workspace): Promise<DirtyState> {
    return computeDirtyState(workspace.path);
  }
}
