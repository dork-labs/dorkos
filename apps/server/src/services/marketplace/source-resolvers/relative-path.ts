/**
 * Relative-path source resolver. Resolves a plugin already present in the
 * cloned marketplace tree. No clone, no fetch — just a path join + exists
 * check.
 *
 * Returned descriptors carry the sentinel commit SHA `'relative-path'`,
 * which {@link MarketplaceCache} short-circuits so relative-path plugins
 * are never written to the content-addressable package cache (they live
 * inside an already-cached marketplace clone).
 *
 * @module services/marketplace/source-resolvers/relative-path
 */
import path from 'node:path';
import { access } from 'node:fs/promises';
import type { ResolvedSourceDescriptor } from '@dorkos/marketplace';
import type { FetchedPackage, FetchPackageOptions } from '../package-fetcher.js';
import { PackageNotFoundError } from '../errors.js';

/** Sentinel commit SHA used for relative-path resolutions. */
export const RELATIVE_PATH_SENTINEL_SHA = 'relative-path';

/**
 * Resolve a relative-path plugin source against an already-cloned
 * marketplace tree.
 *
 * @param resolved - The resolved source descriptor (a relative-path entry).
 * @param opts - The original {@link FetchPackageOptions} request — only
 *   `packageName` is read for the error message; nothing else is consulted.
 * @returns A {@link FetchedPackage} pointing at the joined directory.
 * @throws {PackageNotFoundError} when the joined path does not exist on disk.
 */
export async function relativePathResolver(
  resolved: Extract<ResolvedSourceDescriptor, { type: 'relative-path' }>,
  // The opts parameter is part of the resolver contract but unused in the
  // relative-path path — kept for symmetry with the other resolvers.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  opts: FetchPackageOptions
): Promise<FetchedPackage> {
  const fullPath = path.join(resolved.marketplaceRoot, resolved.path);
  try {
    await access(fullPath);
  } catch {
    throw new PackageNotFoundError(
      `Plugin path ${resolved.path} not found in marketplace root ${resolved.marketplaceRoot}`
    );
  }
  return { path: fullPath, commitSha: RELATIVE_PATH_SENTINEL_SHA, fromCache: true };
}
