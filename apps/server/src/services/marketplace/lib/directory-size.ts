/**
 * Recursive on-disk size of a directory tree.
 *
 * Shared by the cache status endpoint and the package cache's sweep, which
 * reports the space it gave back.
 *
 * @module services/marketplace/lib/directory-size
 */
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Sum the size of every regular file under `root`. Anything that vanishes
 * mid-walk (a concurrent clear or sweep) counts as nothing.
 *
 * @param root - Absolute path of the directory to measure.
 * @returns Total bytes, or `0` when `root` does not exist.
 */
export async function directorySize(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = join(dir, entry);
      try {
        const info = await stat(entryPath);
        if (info.isDirectory()) {
          await walk(entryPath);
        } else if (info.isFile()) {
          total += info.size;
        }
      } catch {
        // Removed while we walked — nothing left to count.
      }
    }
  };
  await walk(root);
  return total;
}
