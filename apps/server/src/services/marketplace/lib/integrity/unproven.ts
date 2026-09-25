/**
 * Files an update or uninstall of an older install kept because nothing proved
 * whose they were (DOR-2322; spec `marketplace-install-verification` §13).
 *
 * When an install made before DorkOS recorded package files is changed and
 * the version it came from cannot be checked, its rebuilt record lists the
 * files it could not tie to the package as `unproven`. They are kept as the
 * person's, and this module says so in one plain sentence.
 *
 * @module services/marketplace/lib/integrity/unproven
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
  type UnprovenFiles,
} from '../installed-files.js';
import { stageInstalledCommit } from '../legacy-record.js';
import { STRICT_RECORD_TEMP_PREFIX } from './strict-differences.js';
import type { StrictRebuildResult } from './strict-record.js';

/** Most kept files one {@link describeUnproven} sentence names. */
export const UNPROVEN_NAMED_LIMIT = 10;

/**
 * One sentence about the files an update or uninstall kept because nothing
 * proved whose they were: why, which (up to {@link UNPROVEN_NAMED_LIMIT}), and
 * what the person can do next. After an update the package is still there, so
 * Check files can sort them once the old version can be fetched; after an
 * uninstall, the files are simply the person's to keep or delete.
 *
 * @param name - The package name.
 * @param why - Why nothing could be proven.
 * @param kept - The kept files, as paths relative to the install folder.
 * @param after - What just ran.
 */
export function describeUnproven(
  name: string,
  why: UnprovenFiles['why'],
  kept: readonly string[],
  after: 'update' | 'uninstall'
): string {
  const sorted = [...kept].sort();
  const n = sorted.length;
  const files = n === 1 ? '1 file' : `${n} files`;
  const them = n === 1 ? 'it' : 'them';
  const was = n === 1 ? 'was' : 'were';
  const shown = `${sorted.slice(0, UNPROVEN_NAMED_LIMIT).join(', ')}${n > UNPROVEN_NAMED_LIMIT ? ', …' : ''}`;
  const whose = after === 'update' ? 'yours or left over from that version' : `yours or ${name}'s`;
  const cause =
    why === 'fetch-failed'
      ? `DorkOS couldn't download the version of ${name} you had, so it couldn't tell whether ${files} ${was} ${whose}.`
      : why === 'mismatch'
        ? `The version of ${name} DorkOS downloaded didn't match the files you had, so it couldn't tell whether ${files} ${was} yours.`
        : `${name} was installed from a folder on this computer, so DorkOS had no earlier version to compare with and couldn't tell whether ${files} ${was} yours.`;
  const next =
    after === 'uninstall' || why === 'no-source'
      ? "Delete any you don't need."
      : why === 'fetch-failed'
        ? `Once you're online, choose Check files on ${name} to sort ${them} out.`
        : `Choose Check files on ${name} to sort ${them} out.`;
  return `${cause} It kept ${them}: ${shown}. ${next}`;
}

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
