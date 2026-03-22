/**
 * Filesystem operations for convention files (SOUL.md, NOPE.md).
 *
 * Node.js-only — uses `node:path` and `node:fs/promises`.
 * For browser-safe constants and pure helpers, use `@dorkos/shared/convention-files`.
 *
 * @module shared/convention-files-io
 */
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { MANIFEST_DIR } from './manifest.js';

/**
 * Read a convention file from disk. Returns null if not found.
 *
 * @param projectPath - Absolute path to the agent's project directory
 * @param filename - Convention file name ('SOUL.md' or 'NOPE.md')
 */
export async function readConventionFile(
  projectPath: string,
  filename: 'SOUL.md' | 'NOPE.md'
): Promise<string | null> {
  try {
    const filePath = join(projectPath, MANIFEST_DIR, filename);
    return await readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Write a convention file to disk.
 *
 * @param projectPath - Absolute path to the agent's project directory
 * @param filename - Convention file name ('SOUL.md' or 'NOPE.md')
 * @param content - File content to write
 */
export async function writeConventionFile(
  projectPath: string,
  filename: 'SOUL.md' | 'NOPE.md',
  content: string
): Promise<void> {
  const filePath = join(projectPath, MANIFEST_DIR, filename);
  await writeFile(filePath, content, 'utf-8');
}
