/**
 * Filesystem operations for convention files (SOUL.md, NOPE.md, MEMORY.md).
 *
 * Node.js-only — uses `node:path` and `node:fs/promises`.
 * For browser-safe constants and pure helpers, use `@dorkos/shared/convention-files`.
 *
 * @module shared/convention-files-io
 */
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import type { ConventionFileName } from './convention-files.js';
import { MANIFEST_DIR } from './manifest.js';

/**
 * Read a convention file from disk. Returns null if not found.
 *
 * @param projectPath - Absolute path to the agent's project directory
 * @param filename - Convention file name, from `CONVENTION_FILES`
 */
export async function readConventionFile(
  projectPath: string,
  filename: ConventionFileName
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
 * @param filename - Convention file name, from `CONVENTION_FILES`
 * @param content - File content to write
 */
export async function writeConventionFile(
  projectPath: string,
  filename: ConventionFileName,
  content: string
): Promise<void> {
  const filePath = join(projectPath, MANIFEST_DIR, filename);
  await writeFile(filePath, content, 'utf-8');
}
