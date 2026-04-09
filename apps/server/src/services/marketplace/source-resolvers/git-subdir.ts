/**
 * git-subdir source resolver. Performs a partial sparse clone to fetch only
 * a subdirectory of a monorepo, with a fallback ladder for older self-hosted
 * git servers that do not support `--filter` or sparse-checkout.
 *
 * The canonical sparse-clone sequence (4 steps):
 *
 * 1. `git clone --filter=blob:none --no-checkout --depth=1 <cloneUrl> <destDir>`
 * 2. `git -C <destDir> sparse-checkout init --cone`
 * 3. `git -C <destDir> sparse-checkout set <subpath>`
 * 4. `git -C <destDir> checkout <ref>` (or `<sha>` if pinned)
 *
 * Fallback ladder:
 *
 * - **Step 1**: try the canonical sequence above.
 * - **Step 2**: on `--filter` failure (older self-hosted git servers), drop
 *   `--filter=blob:none` and use `--no-checkout --depth=1` + sparse-checkout
 *   only. Bandwidth higher, correctness preserved.
 * - **Step 3**: on `--no-checkout` + sparse-checkout failure (git < 2.25),
 *   fall back to `git clone --depth=1` + `rm -rf` of every directory outside
 *   the target subpath. Logs a warning.
 *
 * Minimum supported git version is 2.25 (Jan 2020). DorkOS Docker base
 * images and CI runners ship 2.43+.
 *
 * @module services/marketplace/source-resolvers/git-subdir
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import type { ResolvedSourceDescriptor } from '@dorkos/marketplace';
import type { FetchedPackage, FetchPackageOptions, FetcherDeps } from '../package-fetcher.js';

/**
 * Resolve a git-subdir plugin source. Pre-resolves the commit SHA via
 * `deps.resolveCommitSha`, consults the cache, and falls through the
 * sparse-clone fallback ladder on any partial-clone unsupported error.
 *
 * @param resolved - The resolved git-subdir source descriptor.
 * @param opts - Original {@link FetchPackageOptions}.
 * @param deps - Injected fetcher dependencies (cache, clone primitive, logger).
 */
export async function gitSubdirResolver(
  resolved: Extract<ResolvedSourceDescriptor, { type: 'git-subdir' }>,
  opts: FetchPackageOptions,
  deps: FetcherDeps
): Promise<FetchedPackage> {
  const ref = resolved.sha ?? resolved.ref ?? 'main';
  const commitSha = await deps.resolveCommitSha(resolved.cloneUrl, ref);

  if (!opts.force) {
    const cached = await deps.cache.getPackage(opts.packageName, commitSha);
    if (cached) {
      return {
        path: path.join(cached.path, resolved.subpath),
        commitSha,
        fromCache: true,
      };
    }
  }

  const destDir = await deps.cache.putPackage(opts.packageName, commitSha);

  try {
    await sparseClone({
      cloneUrl: resolved.cloneUrl,
      subpath: resolved.subpath,
      ref,
      destDir,
    });
  } catch (err) {
    if (isFilterUnsupportedError(err)) {
      deps.logger.warn('[git-subdir] partial clone unsupported, falling back to shallow clone', {
        cloneUrl: resolved.cloneUrl,
        error: stringifyError(err),
      });
      await fallbackShallowClone({
        cloneUrl: resolved.cloneUrl,
        subpath: resolved.subpath,
        ref,
        destDir,
      });
    } else if (isSparseCheckoutUnsupportedError(err)) {
      deps.logger.warn(
        '[git-subdir] sparse-checkout unsupported, falling back to full clone + cleanup',
        {
          cloneUrl: resolved.cloneUrl,
          error: stringifyError(err),
        }
      );
      await fallbackFullCloneWithCleanup({
        cloneUrl: resolved.cloneUrl,
        subpath: resolved.subpath,
        ref,
        destDir,
      });
    } else {
      throw err;
    }
  }

  return {
    path: path.join(destDir, resolved.subpath),
    commitSha,
    fromCache: false,
  };
}

/** Options shared by every clone helper in this module. */
interface CloneStepOptions {
  cloneUrl: string;
  subpath: string;
  ref: string;
  destDir: string;
}

/**
 * Run the canonical 4-step sparse-clone sequence. Throws a {@link GitSpawnError}
 * on any subprocess failure so the caller can categorize the error against
 * the fallback ladder heuristics.
 *
 * @internal
 */
async function sparseClone(opts: CloneStepOptions): Promise<void> {
  await runGit(
    ['clone', '--filter=blob:none', '--no-checkout', '--depth=1', opts.cloneUrl, opts.destDir],
    undefined
  );
  await runGit(['sparse-checkout', 'init', '--cone'], opts.destDir);
  await runGit(['sparse-checkout', 'set', opts.subpath], opts.destDir);
  await runGit(['checkout', opts.ref], opts.destDir);
}

/**
 * Fallback ladder step 2 — drop `--filter=blob:none` for git servers that
 * do not support partial clones, but keep sparse-checkout for the
 * subdirectory restriction.
 *
 * @internal
 */
async function fallbackShallowClone(opts: CloneStepOptions): Promise<void> {
  await runGit(['clone', '--no-checkout', '--depth=1', opts.cloneUrl, opts.destDir], undefined);
  await runGit(['sparse-checkout', 'init', '--cone'], opts.destDir);
  await runGit(['sparse-checkout', 'set', opts.subpath], opts.destDir);
  await runGit(['checkout', opts.ref], opts.destDir);
}

/**
 * Fallback ladder step 3 — for git versions older than 2.25 that lack
 * sparse-checkout entirely. Performs a full shallow clone, then removes
 * every directory outside the target `subpath` so the cache footprint stays
 * bounded.
 *
 * @internal
 */
async function fallbackFullCloneWithCleanup(opts: CloneStepOptions): Promise<void> {
  await runGit(['clone', '--depth=1', opts.cloneUrl, opts.destDir], undefined);
  await runGit(['checkout', opts.ref], opts.destDir);
  await pruneOutsideSubpath(opts.destDir, opts.subpath);
}

/**
 * Remove every top-level entry under `destDir` that is not part of the
 * `subpath` chain. Preserves the `.git` directory so subsequent
 * `git checkout` calls still work.
 *
 * @internal
 */
async function pruneOutsideSubpath(destDir: string, subpath: string): Promise<void> {
  const firstSegment = subpath.split('/').filter(Boolean)[0];
  if (!firstSegment) return;
  const entries = await readdir(destDir);
  await Promise.all(
    entries.map(async (entry) => {
      if (entry === '.git' || entry === firstSegment) return;
      await rm(path.join(destDir, entry), { recursive: true, force: true });
    })
  );
}

/**
 * True when the captured stderr matches the heuristic for "this git server
 * does not support partial (`--filter`) clones".
 *
 * @internal
 */
export function isFilterUnsupportedError(err: unknown): boolean {
  const stderr = stringifyError(err).toLowerCase();
  if (!stderr.includes('filter')) return false;
  return (
    stderr.includes('unsupported') ||
    stderr.includes('does not support') ||
    stderr.includes('not supported') ||
    stderr.includes('uploadpack.allowfilter')
  );
}

/**
 * True when the captured stderr matches the heuristic for "this git binary
 * is too old for sparse-checkout".
 *
 * @internal
 */
export function isSparseCheckoutUnsupportedError(err: unknown): boolean {
  const stderr = stringifyError(err).toLowerCase();
  if (!stderr.includes('sparse-checkout')) return false;
  return (
    stderr.includes('unknown') || stderr.includes('not a git command') || stderr.includes('usage:')
  );
}

/**
 * Structured error thrown by {@link runGit} so callers (and the fallback
 * heuristics) can read both `stderr` and `code` from the captured spawn.
 */
export class GitSpawnError extends Error {
  constructor(
    message: string,
    public readonly stderr: string,
    public readonly code: number | null
  ) {
    super(message);
    this.name = 'GitSpawnError';
  }
}

/**
 * Spawn `git` with the given args. Resolves with combined stderr on success;
 * rejects with a {@link GitSpawnError} carrying stderr + exit code on
 * non-zero exit. The `cwd` argument is `undefined` for the initial clone
 * (which targets a not-yet-existing destination directory) and the cloned
 * directory for every follow-up command.
 *
 * @internal
 */
async function runGit(args: string[], cwd: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    // Widen to ChildProcess so `.on()` resolves unambiguously regardless of
    // which @types/node version is picked up. Newer @types/node (25.x) moved
    // ChildProcess to an interface-merge pattern with InternalEventEmitter,
    // which can confuse tsc when the narrow ChildProcessByStdio subtype is
    // inferred from a stdio tuple under certain install topologies.
    const child: ChildProcess = spawn('git', args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (err: Error) => {
      reject(new GitSpawnError(err.message, stderr, null));
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        const trimmedStderr = stderr.trim();
        const detail = trimmedStderr ? `: ${trimmedStderr}` : '';
        reject(
          new GitSpawnError(
            `git ${args.join(' ')} exited with code ${code ?? 'null'}${detail}`,
            stderr,
            code
          )
        );
      }
    });
  });
}

/**
 * Coerce any thrown value into a string suitable for the heuristic checks.
 * Reads `stderr` from {@link GitSpawnError}, falls back to `Error.message`,
 * then to `String(value)`.
 *
 * @internal
 */
function stringifyError(err: unknown): string {
  if (err instanceof GitSpawnError) return `${err.message}\n${err.stderr}`;
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Test-only export bag for unit-test introspection. */
export const _internal = {
  isFilterUnsupportedError,
  isSparseCheckoutUnsupportedError,
  GitSpawnError,
};

// Suppress unused-symbol warning when only the type is needed by callers.
export type { Logger };
