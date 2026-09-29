/**
 * What an install records about itself (DOR-2245, DOR-2306): where it came
 * from, as the installed-files record keeps it, and the content hash its
 * install metadata carries.
 *
 * @module services/marketplace/installer/metadata
 */
import path from 'node:path';
import type { SourceKey } from '@dorkos/marketplace';
import type { ResolvedPackageSource } from '../package-resolver.js';
import type { RecordSource } from '../lib/records/installed-files.js';
import { packageContentHash } from '../lib/content-hash.js';

/**
 * Where an install came from, as the installed-files record keeps it
 * (DOR-2245): the fetched source key's clone URL, subpath and ref, or the
 * local directory a local install copied. Compared later with the ref ignored.
 *
 * @internal
 */
export function recordSourceOf(
  sourceKey: SourceKey | undefined,
  resolved: ResolvedPackageSource
): RecordSource | undefined {
  if (sourceKey) {
    return { cloneUrl: sourceKey.cloneUrl, subpath: sourceKey.subpath, ref: sourceKey.ref };
  }
  if (resolved.localPath) return { localPath: path.resolve(resolved.localPath) };
  return undefined;
}

/**
 * A staged package's content hash for the install metadata, or nothing when
 * it cannot be hashed (DOR-2306).
 *
 * @param installPath - The staged package root, as it arrived.
 * @internal
 */
export async function recordableContentHash(
  installPath: string
): Promise<{ contentHash?: string }> {
  try {
    return { contentHash: await packageContentHash(installPath) };
  } catch {
    return {};
  }
}
