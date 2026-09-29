/**
 * The one rule for "which project is this folder in" (spec `flow-multiproject`
 * §6.1, invariant 5).
 *
 * A project is a git main checkout. A folder belongs to the main checkout its
 * git common dir names: `git rev-parse --path-format=absolute --git-common-dir`
 * points at the ORIGINAL repository's `.git` from a linked worktree (including
 * one under `~/.dork/workspaces/`) and at the checkout's own `.git` from the
 * checkout or any subfolder, so the root is that directory's parent. A bare
 * repository has no `.git` directory at all: its common dir IS the repository,
 * so a worktree of it maps to the bare repository itself. (The bare folder on
 * its own is no project: the hardened runner sets `safe.bareRepository=explicit`,
 * so git never reads a bare repository it merely stumbled on.) A folder that holds several repositories but sits in
 * none is "no project", by construction: git answers "not a repository".
 *
 * Three places used to derive a main checkout on their own, and they
 * disagreed: `flow-run-link.ts` always took the parent, `worktree-scan.ts`
 * stripped only a trailing `.git`, and none canonicalized. Both now call this
 * module, and `__tests__/single-root-rule.test.ts` fails if any other server
 * file runs `--git-common-dir` again. The one carve-out is
 * `rooms/repo/room-repo-git.ts`, which answers a different question (a room's
 * private repository, with a ceiling so git cannot climb out of it).
 *
 * Input and output both go through `canonicalDirectory`, so a folder and a
 * symlink to it are one project.
 *
 * @module services/projects/resolve-project-root
 */
import path from 'node:path';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';

import { runGit } from '../workspace/providers/git.js';

/** How long a folder that is in no repository stays "no project" before git is asked again. */
export const NEGATIVE_ROOT_TTL_MS = 60_000;

/** Timeout for the one `git rev-parse`, which can run while a request waits. */
const GIT_TIMEOUT_MS = 5_000;

/**
 * The main checkout a git common dir belongs to.
 *
 * The parent of the common dir when its basename is `.git` (a checkout, or any
 * worktree of it); otherwise the common dir itself (a bare repository).
 *
 * @param commonDir - Absolute path printed by `git rev-parse --git-common-dir`.
 * @returns The root, or `null` for empty output.
 */
export function projectRootFromCommonDir(commonDir: string): string | null {
  const trimmed = commonDir.trim();
  if (trimmed.length === 0) return null;
  return path.basename(trimmed) === '.git' ? path.dirname(trimmed) : trimmed;
}

/** The collaborators a {@link ProjectRootResolver} uses; tests replace them. */
export interface ProjectRootDeps {
  /** The repo's git runner (`services/workspace/providers/git.ts`). */
  runGit: typeof runGit;
  /** The clock, in epoch ms. */
  now: () => number;
  /** Canonical spelling of a directory (`@dorkos/shared/canonical-directory`). */
  canonical: (directory: string) => string;
}

/** A resolver with its own cache. */
export interface ProjectRootResolver {
  /**
   * The main checkout `cwd` belongs to, or `null` when it is in no repository.
   * Positive answers are cached for the process; `null` for 60 seconds.
   *
   * @param cwd - Any absolute folder.
   */
  resolve(cwd: string): Promise<string | null>;
  /**
   * The cached answer for `cwd` without running git: the root, `null` for a
   * cached "no project", or `undefined` when nothing is cached (or a cached
   * "no project" has expired).
   *
   * @param cwd - Any absolute folder.
   */
  peek(cwd: string): string | null | undefined;
  /**
   * The same git call and rule with no cache, for a caller that walks folders
   * that are not session cwds and keeps its own concurrency cap.
   *
   * @param cwd - Any absolute folder.
   */
  readUncached(cwd: string): Promise<string | null>;
}

const defaultDeps: ProjectRootDeps = {
  runGit,
  now: Date.now,
  canonical: canonicalDirectory,
};

/**
 * Build a resolver with its own cache. The server uses the module's default
 * instance ({@link resolveProjectRoot}); a fresh one is what a restart looks like.
 *
 * @param overrides - Collaborators to replace (tests).
 */
export function createProjectRootResolver(
  overrides: Partial<ProjectRootDeps> = {}
): ProjectRootResolver {
  const deps: ProjectRootDeps = { ...defaultDeps, ...overrides };
  /**
   * Canonical cwd to its lookup. The PROMISE is cached, so concurrent callers
   * on a cold server share one `git` per folder. `settled` and `retryAt` are
   * filled once the lookup finishes.
   */
  const byCwd = new Map<
    string,
    { root: Promise<string | null>; settled?: { root: string | null }; retryAt?: number }
  >();

  async function readUncached(cwd: string): Promise<string | null> {
    const dir = deps.canonical(cwd);
    // A relative folder would be read against the server's own working
    // directory, which is not the folder anybody meant.
    if (!path.isAbsolute(dir)) return null;
    try {
      const commonDir = await deps.runGit(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        dir,
        { timeoutMs: GIT_TIMEOUT_MS }
      );
      const root = projectRootFromCommonDir(commonDir);
      return root === null ? null : deps.canonical(root);
    } catch {
      return null;
    }
  }

  function live(cwd: string) {
    const entry = byCwd.get(cwd);
    if (!entry) return undefined;
    if (entry.retryAt !== undefined && deps.now() >= entry.retryAt) return undefined;
    return entry;
  }

  function resolve(cwd: string): Promise<string | null> {
    const key = deps.canonical(cwd);
    const cached = live(key);
    if (cached) return cached.root;
    const entry: {
      root: Promise<string | null>;
      settled?: { root: string | null };
      retryAt?: number;
    } = {
      root: readUncached(key).then((root) => {
        entry.settled = { root };
        if (root === null) entry.retryAt = deps.now() + NEGATIVE_ROOT_TTL_MS;
        return root;
      }),
    };
    byCwd.set(key, entry);
    return entry.root;
  }

  function peek(cwd: string): string | null | undefined {
    return live(deps.canonical(cwd))?.settled?.root;
  }

  return { resolve, peek, readUncached };
}

const defaultResolver = createProjectRootResolver();

/**
 * The git main checkout a folder belongs to, or null when it is in no repo.
 * Worktrees and subfolders map to their main checkout. Cached per canonical cwd.
 *
 * @param cwd - Any absolute folder.
 */
export function resolveProjectRoot(cwd: string): Promise<string | null> {
  return defaultResolver.resolve(cwd);
}

/**
 * The cached root for `cwd`, without running git. See {@link ProjectRootResolver.peek}.
 *
 * @param cwd - Any absolute folder.
 */
export function peekProjectRoot(cwd: string): string | null | undefined {
  return defaultResolver.peek(cwd);
}

/**
 * {@link resolveProjectRoot}'s git call and rule, uncached. For the workspace
 * scan, which walks folders that are not session cwds and caps its own
 * concurrency.
 *
 * @param cwd - Any absolute folder.
 */
export function readProjectRootUncached(cwd: string): Promise<string | null> {
  return defaultResolver.readUncached(cwd);
}
