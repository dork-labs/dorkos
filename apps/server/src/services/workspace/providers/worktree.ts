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
import { internalGitConfig } from '@dorkos/shared/git-hardening';
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
      // A person's own hooks run; for anyone else, git runs none of the
      // source's hooks or fsmonitor in DorkOS's process (DOR-2335). Either
      // way the source's settings are audited first (DOR-3343): every agent
      // worktree of it can write them.
      {
        config: req.personGit ? PERSON_REPO_GIT_CONFIG : internalGitConfig(),
        audit: [req.source],
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
    // `worktree remove` reads the source's settings and the worktree's own
    // (`config.worktree`), which its agent can write: both are audited.
    await runGit([...gitDir, ...args], workspace.source, {
      audit: [workspace.source, workspace.path],
    });
    // `worktree remove` leaves a non-empty dir only on failure; tidy any remnant.
    await fs.rm(workspace.path, { recursive: true, force: true });
  }

  isDirty(workspace: Workspace): Promise<DirtyState> {
    return computeDirtyState(workspace.path);
  }
}
