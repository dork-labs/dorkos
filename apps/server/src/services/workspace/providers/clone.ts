/**
 * `clone` WorkspaceProvider — provisions an isolated checkout via a fresh
 * `git clone`. Works when DorkOS manages a repo the user has not checked out
 * locally (Symphony-style), at the cost of a full clone vs the worktree's shared
 * object store.
 *
 * @module server/services/workspace/providers/clone
 */
import { existsSync, promises as fs } from 'node:fs';
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
  auditRepoConfig,
  computeDirtyState,
  fullChatAuditReporter,
  PERSON_REPO_GIT_CONFIG,
  runGit,
} from './git.js';

/** Provisions workspaces as fresh clones of a source repo URL or path. */
export class CloneProvider implements WorkspaceProvider {
  readonly type = 'clone' as const;

  /**
   * Bind the provider to one workspace root.
   *
   * @param root - The workspace root; every checkout path must canonicalize under it.
   */
  constructor(private readonly root: string) {}

  async create(req: WorkspaceCreateRequest): Promise<ProviderResult> {
    await validateBoundary(req.path, this.root);
    assertSafeWorkspaceSource(req.source);
    // The person's own repository: their hooks run, as for their own git.
    // `--end-of-options`: the source and path are values, never flags.
    // For anyone but a person, no hook runs: not a template's, and not one a
    // `core.hooksPath` names (DOR-2335).
    const config = req.personGit ? PERSON_REPO_GIT_CONFIG : internalGitConfig();
    // A source on this machine is read by the clone: its settings are audited
    // first (DOR-3343). The clone keeps the server's environment, since an
    // address needs its transports and saved logins.
    // Below Full a failed audit refuses; a chat set to Full autonomy has no
    // limits, so it is let through with one Activity line.
    const onUnsafe = fullChatAuditReporter(req, `made the workspace ${req.projectKey}/${req.key}`);
    if (existsSync(req.source)) await auditRepoConfig(req.source, onUnsafe);
    await runGit(['clone', '--end-of-options', req.source, req.path], this.root, { config });
    // The clone's own settings are audited before its first command in it (DOR-3343).
    await runGit(['checkout', '-b', req.branch], req.path, {
      config,
      audit: [req.path],
      ...(onUnsafe ? { onUnsafe } : {}),
    });
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
