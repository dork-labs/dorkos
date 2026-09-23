/**
 * Recursive on-disk size of a directory tree.
 *
 * Shared by the cache status endpoint and the package cache's sweep, which
 * reports the space it gave back.
 *
 * @module services/marketplace/lib/directory-size
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Deepest directory the walk descends into. Without following links a tree
 * is finite, so this is a belt: a pathological tree is under-counted rather
 * than walked for ever.
 */
const MAX_DEPTH = 256;

/**
 * Sum the size of every regular file under `root`.
 *
 * Symlinks are never followed or counted. A cached package is a git checkout,
 * and git keeps symlinks: following `a -> .` or `root -> /` would walk for
 * ever (and the sweep awaiting this would never settle). Anything that
 * vanishes mid-walk (a concurrent clear or sweep) counts as nothing.
 *
 * @param root - Absolute path of the directory to measure.
 * @returns Total bytes, or `0` when `root` does not exist.
 */
export async function directorySize(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath, depth + 1);
      } else if (entry.isFile()) {
        try {
          total += (await lstat(entryPath)).size;
        } catch {
          // Removed while we walked — nothing left to count.
        }
      }
    }
  };
  await walk(root, 0);
  return total;
}
