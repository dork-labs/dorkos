/**
 * Sorting the files an update kept because nothing proved whose they were
 * (DOR-2322; spec `marketplace-install-verification` §13): the "Check files"
 * action on an install whose record lists `unproven` files.
 *
 * @module services/marketplace/lib/integrity/unproven-sort
 */
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Logger } from '@dorkos/shared/logger';
import type { PackageFetcher } from '../../package-fetcher.js';
import { withInstallTargetLock } from '../../transaction.js';
import {
  hashFile,
  lstatChain,
  readInstalledFiles,
  writeInstalledFiles,
} from '../installed-files.js';
import { stageInstalledCommit } from '../legacy-record.js';
import { STRICT_RECORD_TEMP_PREFIX } from './strict-differences.js';
import type { StrictRebuildResult } from './strict-record.js';

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/** Remove the now-empty folders above `posixPath`, up to (never including) `root`. */
async function removeEmptyParents(root: string, posixPath: string): Promise<void> {
  const segments = posixPath.split('/').slice(0, -1);
  while (segments.length > 0) {
    try {
      await rmdir(fsPath(root, segments.join('/')));
    } catch {
      return; // Not empty, or gone: either way, stop.
    }
    segments.pop();
  }
}

/**
 * Sort the files an update kept because nothing proved whose they were: the
 * "Check files" action on an install whose record lists `unproven` files.
 *
 * The earlier version the record names is fetched and staged before the
 * install lock is taken. Under the lock, each kept file that is a regular file
 * with exactly the bytes that version had at its old path, and that the
 * current version does not ship, is a leftover an online update would have
 * removed: it is removed. Every other kept file is the person's and stays. The
 * list is then dropped from the record. Nothing is removed when the earlier
 * version cannot be fetched, or the record changed meanwhile.
 *
 * @param root - The install folder.
 * @param deps - The fetcher and a logger.
 * @returns `sorted` with what was removed and kept, or why nothing was.
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
      const removed: string[] = [];
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
        await rm(fsPath(root, where));
        await removeEmptyParents(root, where);
        removed.push(where);
      }
      const { unproven: _sorted, ...rest } = record;
      await writeInstalledFiles(root, rest);
      deps.logger.info('[marketplace/unproven] sorted the files an update kept', {
        root,
        removed: removed.length,
        kept: kept.length,
      });
      return { outcome: 'sorted', removed, kept };
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
