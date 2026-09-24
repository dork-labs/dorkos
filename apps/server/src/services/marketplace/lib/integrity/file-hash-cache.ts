/**
 * A memo over {@link hashFile} for re-verifying installs cheaply (DOR-2197).
 *
 * Verification hashes every shipped file of every install a list call names,
 * and the Installed view, the CLI and `dorkos doctor --deep` all ask. The file
 * bytes rarely change between two asks, so a hash is reused while the file's
 * `lstat` identity is unchanged: size, mtime, ctime and inode. ctime and the
 * inode catch what size and mtime alone miss: a same-size file renamed over the
 * original, or an in-place write whose mtime was restored with `utimes` (both
 * change ctime; the rename changes the inode).
 *
 * The hash itself is always {@link hashFile}, the per-file SHA-256 the
 * installed-files record is written with: this adds no hash of its own.
 * In memory only, at most {@link HASH_CACHE_LIMIT} entries, least recently
 * used dropped first.
 *
 * @module services/marketplace/lib/integrity/file-hash-cache
 */
import { lstat } from 'node:fs/promises';
import { hashFile } from '../installed-files.js';

/** Most file hashes kept at once. */
export const HASH_CACHE_LIMIT = 20_000;

interface CachedHash {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  hash: string;
}

/** Insertion order is recency order: a hit is deleted and re-set. */
const cache = new Map<string, CachedHash>();

/**
 * The seam tests spy on to count real reads; production calls go through it.
 * `lstat` is wrapped rather than captured so that loading this module never
 * reads the binding: a test that mocks `node:fs/promises` without `lstat`
 * would otherwise fail on import, anywhere this module is reached.
 *
 * @internal
 */
export const _internal = {
  hashFile,
  lstat: (absPath: string) => lstat(absPath),
};

/**
 * {@link hashFile} of `absPath`, reused while the file's `lstat` identity is
 * unchanged. The caller has already established that `absPath` is a regular
 * file reached through real directories (`lstatChain`).
 *
 * @param absPath - The file to hash.
 * @returns `sha256:<hex>`, as the installed-files record spells it.
 */
export async function cachedHashFile(absPath: string): Promise<string> {
  const stats = await _internal.lstat(absPath);
  const hit = cache.get(absPath);
  if (
    hit &&
    hit.size === stats.size &&
    hit.mtimeMs === stats.mtimeMs &&
    hit.ctimeMs === stats.ctimeMs &&
    hit.ino === stats.ino
  ) {
    cache.delete(absPath);
    cache.set(absPath, hit);
    return hit.hash;
  }
  const hash = await _internal.hashFile(absPath);
  cache.delete(absPath);
  cache.set(absPath, {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
    ino: stats.ino,
    hash,
  });
  while (cache.size > HASH_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return hash;
}

/**
 * Forget every cached hash.
 *
 * @internal
 */
export function _resetHashCacheForTests(): void {
  cache.clear();
}
