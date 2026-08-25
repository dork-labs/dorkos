/**
 * Filesystem operations for convention files (SOUL.md, NOPE.md, MEMORY.md).
 *
 * Node.js-only — uses `node:path` and `node:fs/promises`. Writes go through
 * `./atomic-write.js`, so this module and the memory engine serialise against
 * each other on the same file rather than racing.
 * For browser-safe constants and pure helpers, use `@dorkos/shared/convention-files`.
 *
 * @module shared/convention-files-io
 */
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { withFileLock } from './atomic-write.js';
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
 * Write a convention file to disk, atomically and serialised against every
 * other writer of the same file in this process.
 *
 * **This used to be a bare `fs.writeFile`, and against `MEMORY.md` that
 * destroyed data.** The memory engine does a read-modify-write under
 * {@link withFileLock}; this writer held no lock and truncated in place, so the
 * two interleaved on one file with no mutual exclusion. `fs.writeFile` opens
 * with `O_TRUNC`, which means there is a real window in which the file is
 * ZERO BYTES on disk — and if the engine's read landed in that window it saw an
 * empty memory, appended one note to nothing, and committed the truncation as a
 * successful save. Measured before this fix: ~3.5% of interleaves (7 of 200)
 * lost every note in the file, silently, reporting `{ saved: true }`.
 *
 * Routing through `withFileLock` fixes both halves at once. The lock gives
 * mutual exclusion with the engine — same path, same key, so the editor and
 * `memory_write` queue behind each other instead of overlapping — and the
 * writer it hands back publishes through a unique temp file and an atomic
 * rename, so no reader ever observes a partial or empty file.
 *
 * `SOUL.md` and `NOPE.md` inherit the same guarantee. They were never
 * read-modify-written concurrently, so they were not losing data, but they were
 * equally capable of being read half-written by a turn assembling its prompt.
 *
 * Safe to call from anywhere: no caller of this function runs inside a
 * `withFileLock` critical section (checked across the monorepo), so the
 * non-reentrancy guard cannot fire here.
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
  await withFileLock(filePath, (write) => write(content));
}
