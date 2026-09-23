/**
 * GitHub source resolver. Builds the canonical https git URL from
 * `{ source: 'github', repo, ref?, sha? }` and delegates to the existing
 * git clone machinery with optional ref/sha pinning.
 *
 * @module services/marketplace/source-resolvers/github
 */
import { sourceKeyOf, type ResolvedSourceDescriptor } from '@dorkos/marketplace';
import type { FetchedPackage, FetchPackageOptions, FetcherDeps } from '../package-fetcher.js';

/**
 * Resolve a github plugin source by cloning the canonical
 * `https://github.com/<repo>.git` URL at the requested ref or pinned SHA.
 *
 * Pin precedence (`sha > ref > 'main'`) and the clone URL come from
 * `sourceKeyOf`, the one normalizer install and the update check share.
 *
 * @param resolved - Resolved github source descriptor (cloneUrl is pre-built
 *   by `@dorkos/marketplace`'s `resolvePluginSource`).
 * @param opts - The original {@link FetchPackageOptions}; only `packageName`
 *   and `force` are forwarded to the underlying clone primitive.
 * @param deps - Injected fetcher dependencies (cache, logger, clone primitive).
 */
export async function githubResolver(
  resolved: Extract<ResolvedSourceDescriptor, { type: 'github' }>,
  opts: FetchPackageOptions,
  deps: FetcherDeps
): Promise<FetchedPackage> {
  // The key owns the clone URL and the pin precedence, so the commit an
  // install records and the one the update check looks up name one place.
  const key = sourceKeyOf(resolved);
  return deps.cloneRepository({
    cloneUrl: key.cloneUrl,
    ref: key.ref,
    packageName: opts.packageName,
    force: opts.force,
  });
}
