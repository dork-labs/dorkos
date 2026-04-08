/**
 * GitHub source resolver. Builds the canonical https git URL from
 * `{ source: 'github', repo, ref?, sha? }` and delegates to the existing
 * git clone machinery with optional ref/sha pinning.
 *
 * @module services/marketplace/source-resolvers/github
 */
import type { ResolvedSourceDescriptor } from '@dorkos/marketplace';
import type { FetchedPackage, FetchPackageOptions, FetcherDeps } from '../package-fetcher.js';

/**
 * Resolve a github plugin source by cloning the canonical
 * `https://github.com/<repo>.git` URL at the requested ref or pinned SHA.
 *
 * Pin precedence: `sha > ref > 'main'`.
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
  const ref = resolved.sha ?? resolved.ref ?? 'main';
  return deps.cloneRepository({
    cloneUrl: resolved.cloneUrl,
    ref,
    packageName: opts.packageName,
    force: opts.force,
  });
}
