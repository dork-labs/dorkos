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
 * ## Cost
 *
 * A cached lookup runs at most {@link MAX_CONCURRENT_ROOT_LOOKUPS} `git` calls at
 * once; the rest wait their turn. The live session stream asks about every
 * folder it stamps, so a burst across many cold folders would otherwise start
 * one `git` per folder at the same moment. The queue is per resolver and shared
 * by every caller of the server's one resolver: the stream's background
 * lookups and a request's lookups (a list route stamping `project`) wait in
 * the same line, first come first served, so a cold burst can delay a request
 * by a few `git` calls but never starts more than four at once.
 *
 * A folder git says is in no repository ("not a git repository") is asked
 * again after {@link NEGATIVE_ROOT_TTL_MS}, then twice as long after each
 * further such answer, up to {@link MAX_NEGATIVE_ROOT_TTL_MS}, so a folder
 * that is plainly not a repository stops costing a `git` a minute. A folder
 * that becomes one (`git init`) is noticed within that ceiling. Any other
 * failure (a timeout, a missing folder, git not installed) still answers "no
 * project" but is asked again after the base minute, never backed off: it says
 * nothing about the folder.
 *
 * @module services/projects/resolve-project-root
 */
import path from 'node:path';
import { canonicalDirectory } from '@dorkos/shared/canonical-directory';

import { Slots } from '../../lib/concurrency/slots.js';
import { GitRepoConfigUnsafeError, runSafeGit } from '@dorkos/shared/safe-git';

/** How long a folder in no repository first stays "no project" before git is asked again. */
export const NEGATIVE_ROOT_TTL_MS = 60_000;

/** The longest a folder in no repository stays "no project", after repeated misses. */
export const MAX_NEGATIVE_ROOT_TTL_MS = 10 * 60_000;

/** The most cached lookups that run `git` at once, per resolver. */
export const MAX_CONCURRENT_ROOT_LOOKUPS = 4;

/**
 * The locale every root lookup runs git in, so git's messages read the same
 * on a translated git. {@link isNotARepository} no longer reads them.
 */
export const ROOT_LOOKUP_GIT_ENV: Readonly<Record<string, string>> = { LC_ALL: 'C', LANG: 'C' };

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
  /** The audited git runner (`@dorkos/shared/safe-git`, DOR-3343). */
  runGit: typeof runSafeGit;
  /** The clock, in epoch ms. */
  now: () => number;
  /** Canonical spelling of a directory (`@dorkos/shared/canonical-directory`). */
  canonical: (directory: string) => string;
}

/** A resolver with its own cache. */
export interface ProjectRootResolver {
  /**
   * The main checkout `cwd` belongs to, or `null` when it is in no repository.
   * Positive answers are cached for the process; git's "not a git repository"
   * for 60 seconds, doubling after each further one up to
   * {@link MAX_NEGATIVE_ROOT_TTL_MS}; any other failure for 60 seconds. At most
   * {@link MAX_CONCURRENT_ROOT_LOOKUPS} run `git` at once.
   *
   * @param cwd - Any absolute folder.
   */
  resolve(cwd: string): Promise<string | null>;
  /**
   * The same cached answer as {@link resolve}, keeping a repository git would
   * not be run in apart from "in no repository" ({@link ProjectRootLookup}).
   *
   * @param cwd - Any absolute folder.
   */
  lookup(cwd: string): Promise<ProjectRootLookup>;
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

/**
 * Whether a failed `git rev-parse` was git itself answering that the folder is
 * in no repository it will read, as opposed to a timeout, a missing `git` or a
 * repository the audited runner refused. Only that answer says something
 * about the folder worth backing off on.
 *
 * Decided by git's exit code, 128, never by its wording (DOR-3343): git says
 * "or any of the parent directories" on one machine and "or any parent up to
 * mount point" on another, and refuses an implicit bare repository with a
 * third. A process git ran but that was killed for its timeout has no code.
 *
 * @param err - What the git runner threw.
 */
export function isNotARepository(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, killed } = err as { code?: unknown; killed?: unknown };
  return code === 128 && killed !== true;
}

/**
 * What a folder's lookup found (DOR-3343): its project's main checkout, no
 * repository at all, or a repository the audited git runner refused to read
 * because a settings file there names a program (`GitRepoConfigUnsafeError`).
 *
 * `refused` is never "no repository". Only chat start and account eligibility
 * read it as "no project" (`projectOfFolder`), so the chat runs in its folder
 * and no git runs; every git read in such a folder is refused by the runner.
 */
export type ProjectRootLookup =
  { kind: 'project'; root: string } | { kind: 'none' } | { kind: 'refused' };

/** The root a lookup found, or null for no project and for a refused repository. */
function rootOf(found: ProjectRootLookup): string | null {
  return found.kind === 'project' ? found.root : null;
}

/** One cached lookup. See {@link createProjectRootResolver}. */
interface RootLookup {
  found: Promise<ProjectRootLookup>;
  settled?: { root: string | null };
  retryAt?: number;
  misses: number;
}

/**
 * How long the `misses`-th "no project" in a row is kept: the base TTL,
 * doubled per further miss, never past {@link MAX_NEGATIVE_ROOT_TTL_MS}.
 *
 * @param misses - Consecutive "no project" answers, at least 1.
 */
export function negativeTtl(misses: number): number {
  return Math.min(NEGATIVE_ROOT_TTL_MS * 2 ** Math.max(0, misses - 1), MAX_NEGATIVE_ROOT_TTL_MS);
}

const defaultDeps: ProjectRootDeps = {
  runGit: runSafeGit,
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
  const lookups = new Slots(MAX_CONCURRENT_ROOT_LOOKUPS);
  /**
   * Canonical cwd to its lookup. The PROMISE is cached, so concurrent callers
   * on a cold server share one `git` per folder. `settled` and `retryAt` are
   * filled once the lookup finishes; `misses` counts the "no project" answers
   * in a row, which sets how long the next one is kept.
   */
  const byCwd = new Map<string, RootLookup>();

  /** What the folder is in, and whether git or the audit actually answered (so a miss may back off). */
  async function lookUp(cwd: string): Promise<{ found: ProjectRootLookup; answered: boolean }> {
    const dir = deps.canonical(cwd);
    // A relative folder would be read against the server's own working
    // directory, which is not the folder anybody meant.
    if (!path.isAbsolute(dir)) return { found: { kind: 'none' }, answered: true };
    try {
      const commonDir = await deps.runGit(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        dir,
        { timeoutMs: GIT_TIMEOUT_MS, env: ROOT_LOOKUP_GIT_ENV }
      );
      const root = projectRootFromCommonDir(commonDir);
      return {
        found: root === null ? { kind: 'none' } : { kind: 'project', root: deps.canonical(root) },
        answered: true,
      };
    } catch (err) {
      if (err instanceof GitRepoConfigUnsafeError)
        return { found: { kind: 'refused' }, answered: true };
      return { found: { kind: 'none' }, answered: isNotARepository(err) };
    }
  }

  async function readUncached(cwd: string): Promise<string | null> {
    return rootOf((await lookUp(cwd)).found);
  }

  function live(cwd: string) {
    const entry = byCwd.get(cwd);
    if (!entry) return undefined;
    if (entry.retryAt !== undefined && deps.now() >= entry.retryAt) return undefined;
    return entry;
  }

  function lookup(cwd: string): Promise<ProjectRootLookup> {
    const key = deps.canonical(cwd);
    const cached = live(key);
    if (cached) return cached.found;
    const previousMisses = byCwd.get(key)?.misses ?? 0;
    const entry: RootLookup = {
      misses: previousMisses,
      found: lookups
        .run(() => lookUp(key))
        .then(({ found, answered }) => {
          const root = rootOf(found);
          entry.settled = { root };
          // A found root is kept for the process, so only a miss needs a retry.
          // A refused repository is retried too: its settings may be fixed.
          if (root === null) {
            if (answered) entry.misses = previousMisses + 1;
            entry.retryAt =
              deps.now() + (answered ? negativeTtl(entry.misses) : NEGATIVE_ROOT_TTL_MS);
          }
          return found;
        }),
    };
    byCwd.set(key, entry);
    return entry.found;
  }

  function resolve(cwd: string): Promise<string | null> {
    return lookup(cwd).then(rootOf);
  }

  function peek(cwd: string): string | null | undefined {
    return live(deps.canonical(cwd))?.settled?.root;
  }

  return { resolve, lookup, peek, readUncached };
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
 * A folder's lookup, keeping a refused repository apart from no repository.
 * See {@link ProjectRootResolver.lookup}.
 *
 * @param cwd - Any absolute folder.
 */
export function lookupProjectRoot(cwd: string): Promise<ProjectRootLookup> {
  return defaultResolver.lookup(cwd);
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
