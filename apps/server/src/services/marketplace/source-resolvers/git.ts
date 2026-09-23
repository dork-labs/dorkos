/**
 * The git source resolver: one path for every source form git fetches from —
 * `github` (`{ repo, ref?, sha? }`), `url` (any https, ssh or scp-style git
 * address: GitLab, Bitbucket, Azure DevOps, a self-hosted Gitea), and
 * `git-subdir` (one directory of a monorepo, fetched sparse).
 *
 * The three differ only in where the clone URL comes from and whether a
 * subpath is kept, and `sourceKeyOf` already owns both, along with the pin
 * precedence (`sha > ref > HEAD`). So the commit an install records, the one
 * the update check looks up, and the tree that is fetched all come from the
 * same key (DOR-2248). How the tree is fetched and verified is
 * `lib/git-tree.ts`, behind {@link FetcherDeps.fetchGitTree}.
 *
 * @module services/marketplace/source-resolvers/git
 */
import path from 'node:path';
import { sourceKeyOf, type GitSourceDescriptor } from '@dorkos/marketplace';
import type { FetchedPackage, FetchPackageOptions, FetcherDeps } from '../package-fetcher.js';

/**
 * Fetch a git source's tree through the cache and return the package's
 * directory in it: the entry itself for a whole-repo source, the subpath
 * inside it for `git-subdir`.
 *
 * @param resolved - A `github`, `url` or `git-subdir` descriptor from
 *   `resolvePluginSource`.
 * @param opts - The original {@link FetchPackageOptions}; `packageName` and
 *   `force` are forwarded.
 * @param deps - Injected fetcher dependencies.
 */
export async function gitResolver(
  resolved: GitSourceDescriptor,
  opts: FetchPackageOptions,
  deps: FetcherDeps
): Promise<FetchedPackage> {
  const key = sourceKeyOf(resolved);
  const fetched = await deps.fetchGitTree({
    packageName: opts.packageName,
    cloneUrl: key.cloneUrl,
    ref: key.ref,
    subpath: key.subpath,
    force: opts.force,
  });
  return key.subpath === '' ? fetched : { ...fetched, path: path.join(fetched.path, key.subpath) };
}
