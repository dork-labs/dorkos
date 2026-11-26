/**
 * Read a folder that may not exist.
 *
 * @module services/marketplace/lib/safe-readdir
 */
import { readdir } from 'node:fs/promises';

/**
 * `fs.readdir` that swallows ENOENT so callers can walk optional trees.
 *
 * @param dir - The folder to read.
 */
export async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
