/**
 * Sorting the files an update kept because nothing proved whose they were
 * (DOR-2322; spec `marketplace-install-verification` §13): the "Check files"
 * action on an install whose record lists `unproven` files.
 *
 * @module services/marketplace/lib/integrity/unproven-sort
 */
import { mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isReservedPackagePath } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import type { PackageFetcher } from '../../package-fetcher.js';
import { withInstallTargetLock } from '../../transaction.js';
import { readInstalledFiles, writeInstalledFiles } from '../records/installed-files.js';
import { hashFile, lstatChain } from '../records/tree-scan.js';
import { stageInstalledCommit } from '../records/legacy-record.js';
import { STRICT_RECORD_TEMP_PREFIX } from './strict-differences.js';
import type { StrictRebuildResult } from './strict-record.js';
import { freeSavedFileName, makeInert, savedCopyMustMove } from '../saved-copies/saved-copies.js';

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/**
 * Set a leftover aside: move it to a free `.dork-old` name (no loader reads a
 * file under a kept-copy name) and clear its execute bits, so a program
 * left in `bin/` stops being one. A file already under a set-aside name only
 * loses its execute bits. Nothing is deleted, so an edit that lands between
 * the comparison and the move is kept in the moved file.
 *
 * @returns Where it now sits.
 */
async function setAside(root: string, p: string): Promise<string> {
  const basename = p.slice(p.lastIndexOf('/') + 1);
  // A file already under a kept-copy name stays put, unless it is in `bin/`,
  // where anything is on the PATH (DOR-2340).
  const stays = isReservedPackagePath(basename) && !savedCopyMustMove(p, false);
  const savedAs = stays ? p : await freeSavedFileName(root, p);
  if (savedAs !== p) await mkdir(path.dirname(fsPath(root, savedAs)), { recursive: true });
  if (savedAs !== p) await rename(fsPath(root, p), fsPath(root, savedAs));
  await makeInert(fsPath(root, savedAs));
  return savedAs;
}

/**
 * Sort the files an update kept because nothing proved whose they were: the
 * "Check files" action on an install whose record lists `unproven` files.
 *
 * The earlier version the record names is fetched and staged before the
 * install lock is taken. Under the lock, each kept file that is a regular file
 * with exactly the bytes that version had at its old path, and that the
 * current version does not ship, is a leftover an online update would have
 * replaced: it is set aside ({@link setAside}), never deleted. Every other kept
 * file is the person's and stays. The list is then dropped from the record.
 * Nothing moves when the earlier version cannot be fetched, or the record
 * changed meanwhile.
 *
 * @param root - The install folder.
 * @param deps - The fetcher and a logger.
 * @returns `sorted` with what was set aside (and where) and kept, or why nothing moved.
 */
export async function sortUnprovenFiles(
  root: string,
  deps: { fetcher: Pick<PackageFetcher, 'fetchAtCommit'>; logger: Logger }
): Promise<StrictRebuildResult> {
  const unproven = (await readInstalledFiles(root))?.unproven;
  if (!unproven) return { outcome: 'not-needed', why: 'has-record' };
  if (!unproven.from) return { outcome: 'no-source', unproven: true };

  const scratch = await mkdtemp(path.join(tmpdir(), STRICT_RECORD_TEMP_PREFIX));
  try {
    const earlier = path.join(scratch, 'earlier');
    try {
      await stageInstalledCommit(unproven.from, earlier, deps);
    } catch (err) {
      return {
        outcome: 'fetch-failed',
        message: err instanceof Error ? err.message : String(err),
        unproven: true,
      };
    }
    return await withInstallTargetLock(root, async (): Promise<StrictRebuildResult> => {
      // Re-read under the lock: an update that ran meanwhile wrote a new record.
      const record = await readInstalledFiles(root);
      if (!record?.unproven || JSON.stringify(record.unproven) !== JSON.stringify(unproven)) {
        return { outcome: 'not-needed', why: 'has-record' };
      }
      const setAsideFiles: { path: string; savedAs: string }[] = [];
      const kept: string[] = [];
      for (const where of Object.keys(unproven.files).sort()) {
        const origin = unproven.files[where]!;
        const live = await lstatChain(root, where);
        if (live.kind === 'missing') continue; // Already deleted: nothing to sort.
        const leftover =
          live.kind === 'file' &&
          !(where in record.files) &&
          (await lstatChain(earlier, origin)).kind === 'file' &&
          (await hashFile(fsPath(root, where))) === (await hashFile(fsPath(earlier, origin)));
        if (!leftover) {
          kept.push(where);
          continue;
        }
        setAsideFiles.push({ path: where, savedAs: await setAside(root, where) });
      }
      const { unproven: _sorted, ...rest } = record;
      await writeInstalledFiles(root, rest);
      deps.logger.info('[marketplace/unproven] sorted the files an update kept', {
        root,
        setAside: setAsideFiles.length,
        kept: kept.length,
      });
      return { outcome: 'sorted', setAside: setAsideFiles, kept };
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
