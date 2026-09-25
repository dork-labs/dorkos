/**
 * Make the copies earlier versions saved aside inert (DOR-2340).
 *
 * Before DOR-2340 an update kept a saved copy's execute bits, and saved a
 * folder beside its original, where it still loaded as a skill or command.
 * Once per boot, for every install root: a folder under a kept-copy name
 * (`skills/mine.dork-old/`) moves under `.dork/saved`, and every saved file
 * loses its execute bits. Idempotent: a second pass finds nothing to do.
 * Each root is handled under its install lock, so no install races it.
 *
 * @module services/marketplace/lib/saved-copies/migrate-saved-copies
 */
import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { PACKAGE_DATA_DIR } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { freeSavedFolderName, makeInert, SAVED_COPIES_DIR } from './saved-copies.js';

/** A basename that is a kept copy's (`x.dork-old`, `x.dork-new.2`), any case. */
const KEPT_COPY_BASENAME = /\.dork-(?:old|new)(?:\.\d+)?$/i;

/** Folders never walked: dependencies, git's own, and the package's data. */
const NOT_WALKED = new Set(['node_modules', '.git']);

/** What one pass changed. */
export interface SavedCopiesMigration {
  /** Saved folders moved under `.dork/saved`. */
  moved: number;
  /** Install roots that could not be fully checked; retried next boot. */
  failed: number;
}

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/**
 * Move one root's saved folders under `.dork/saved` and clear every saved
 * copy's execute bits.
 *
 * @param root - An install root.
 * @returns How many folders moved.
 */
export async function migrateRoot(root: string): Promise<number> {
  const savedFolders: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(rel === '' ? root : fsPath(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (NOT_WALKED.has(entry.name)) continue;
        if (child === PACKAGE_DATA_DIR) continue;
        if (child === SAVED_COPIES_DIR) {
          await makeInert(fsPath(root, child));
          continue;
        }
        if (KEPT_COPY_BASENAME.test(entry.name)) {
          savedFolders.push(child);
          continue;
        }
        await walk(child);
      } else if (entry.isFile() && KEPT_COPY_BASENAME.test(entry.name)) {
        await makeInert(fsPath(root, child));
      }
    }
  };
  await walk('');
  for (const folder of savedFolders) {
    const to = await freeSavedFolderName(root, folder);
    await mkdir(path.dirname(fsPath(root, to)), { recursive: true });
    await rename(fsPath(root, folder), fsPath(root, to));
    await makeInert(fsPath(root, to));
  }
  return savedFolders.length;
}

/**
 * Run {@link migrateRoot} over every install root, each under `lock`.
 * Best-effort: a root that fails is logged, counted and retried next boot.
 *
 * @param roots - Install roots (the installed list's `installPath`s).
 * @param lock - Runs a step under the root's install lock.
 * @param logger - Where moves and failures are reported.
 */
export async function migrateSavedCopies(
  roots: readonly string[],
  lock: <T>(root: string, fn: () => Promise<T>) => Promise<T>,
  logger: Pick<Logger, 'info' | 'warn'>
): Promise<SavedCopiesMigration> {
  const result: SavedCopiesMigration = { moved: 0, failed: 0 };
  for (const root of new Set(roots)) {
    if ((await lstat(root).catch(() => undefined))?.isDirectory() !== true) continue;
    try {
      const moved = await lock(root, () => migrateRoot(root));
      if (moved > 0) {
        logger.info(
          `[marketplace/saved-copies] moved ${moved} saved folder(s) in ${root} under ${SAVED_COPIES_DIR}, where nothing loads them`
        );
      }
      result.moved += moved;
    } catch (err) {
      result.failed++;
      logger.warn(
        `[marketplace/saved-copies] could not check the saved copies in ${root}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return result;
}
