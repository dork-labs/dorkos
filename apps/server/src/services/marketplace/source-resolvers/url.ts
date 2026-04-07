/**
 * Generic URL source resolver. Supports https://, git@, and .git-optional
 * URLs (Azure DevOps, AWS CodeCommit, self-hosted Gitea/GitLab compatibility).
 *
 * @module services/marketplace/source-resolvers/url
 */
import type { ResolvedSourceDescriptor } from '@dorkos/marketplace';
import type { FetchedPackage, FetchPackageOptions, FetcherDeps } from '../package-fetcher.js';

/**
 * Resolve a generic URL plugin source by cloning the supplied URL at the
 * requested ref or pinned SHA.
 *
 * Pin precedence: `sha > ref > 'main'`. The URL is forwarded as-is so the
 * underlying clone primitive can handle host-specific quirks (no `.git`
 * suffix, ssh URLs, etc.).
 *
 * @param resolved - Resolved url source descriptor.
 * @param opts - Original {@link FetchPackageOptions} (forwarded for `force`).
 * @param deps - Injected fetcher dependencies (clone primitive, logger).
 */
export async function urlResolver(
  resolved: Extract<ResolvedSourceDescriptor, { type: 'url' }>,
  opts: FetchPackageOptions,
  deps: FetcherDeps
): Promise<FetchedPackage> {
  const ref = resolved.sha ?? resolved.ref ?? 'main';
  return deps.cloneRepository({
    cloneUrl: resolved.url,
    ref,
    packageName: opts.packageName,
    force: opts.force,
  });
}
