/**
 * The strict rebuild of a legacy install's installed-files record (DOR-2197,
 * DOR-2320; spec `marketplace-install-verification` §5).
 *
 * An install made before DOR-2245 has no record, so DorkOS cannot tell its
 * files from the person's. This gives it one, with rules that never guess:
 *
 * - it runs under the install lock, and re-checks inside it that the install
 *   is still legacy (an update that ran meanwhile wrote a record);
 * - it fetches the exact commit the install's sidecar names, stages it the way
 *   that install saw it (`stageInstalledCommit`), and computes its record;
 * - it writes that record only when every file in it is a regular file in the
 *   live folder with the same bytes (files the package marks `userEditable`
 *   may differ: they are the person's to edit);
 * - offline, with nothing to fetch, or on any mismatch, it writes nothing.
 *
 * There is deliberately no byte-matching fallback. The update and uninstall
 * paths' own rebuild (`rebuildInstalledFiles`) still has one; this is what the
 * background sweep after boot and the "Prepare" action use.
 *
 * @module services/marketplace/lib/integrity/strict-record
 */
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INSTALLED_FILES_PATH, matchesUserEditable } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { readInstallMetadataStrict, type InstallMetadata } from '../../installed-metadata.js';
import type { PackageFetcher } from '../../package-fetcher.js';
import { withInstallTargetLock } from '../../transaction.js';
import { computeInstalledFiles, lstatChain, writeInstalledFiles } from '../installed-files.js';
import {
  fetchableSourceOf,
  recordIdentityOf,
  stageInstalledCommit,
  userEditableOf,
} from '../legacy-record.js';
import { hasPackageIdentity } from '../locate-install.js';
import { cachedHashFile } from './file-hash-cache.js';

/** Most differing paths a mismatch names. */
export const STRICT_MISMATCH_LIST_LIMIT = 50;

/** What a strict rebuild did. Only `rebuilt` wrote anything. */
export type StrictRebuildResult =
  | { outcome: 'rebuilt'; files: number }
  | { outcome: 'not-needed'; why: 'has-record' | 'not-installed' | 'linked' }
  | { outcome: 'no-source' }
  | { outcome: 'fetch-failed'; message: string }
  | { outcome: 'mismatch'; differing: string[] };

/** What {@link rebuildRecordStrict} needs. */
export interface StrictRecordDeps {
  /** Fetches the commit an install recorded. */
  fetcher: Pick<PackageFetcher, 'fetchAtCommit'>;
  logger: Logger;
}

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/** Whether `p` exists, without following a final link. */
async function exists(p: string): Promise<boolean> {
  return (await lstat(p).catch(() => undefined)) !== undefined;
}

/**
 * Rebuild the installed-files record of the legacy install at `root`, or
 * write nothing. See the module header for the rules.
 *
 * @param root - The install folder.
 * @param deps - The fetcher and a logger.
 * @returns What happened; only `rebuilt` changed anything on disk.
 */
export async function rebuildRecordStrict(
  root: string,
  deps: StrictRecordDeps
): Promise<StrictRebuildResult> {
  if ((await lstat(root).catch(() => undefined))?.isSymbolicLink()) {
    return { outcome: 'not-needed', why: 'linked' };
  }
  return withInstallTargetLock(root, async () => {
    // Re-checked under the lock: an install, update or uninstall that held it
    // may have changed what stands here.
    if (await exists(fsPath(root, INSTALLED_FILES_PATH))) {
      return { outcome: 'not-needed', why: 'has-record' };
    }
    if (!(await hasPackageIdentity(root))) return { outcome: 'not-needed', why: 'not-installed' };

    let metadata: InstallMetadata | null = null;
    try {
      metadata = await readInstallMetadataStrict(root);
    } catch (err) {
      deps.logger.warn('[marketplace/strict-record] unreadable install sidecar', {
        root,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    const source = fetchableSourceOf(metadata);
    if (!source) return { outcome: 'no-source' };

    const scratch = await mkdtemp(path.join(tmpdir(), 'dorkos-strict-record-'));
    try {
      const fetched = path.join(scratch, 'installed');
      try {
        await stageInstalledCommit(source, fetched, deps);
      } catch (err) {
        return {
          outcome: 'fetch-failed',
          message: err instanceof Error ? err.message : String(err),
        };
      }
      const userEditable = await userEditableOf(fetched);
      const record = await computeInstalledFiles(fetched, {
        identity: recordIdentityOf(metadata, path.basename(root), 'plugin'),
        userEditable,
        npmRan: await exists(path.join(root, 'node_modules')),
      });

      const differing: string[] = [];
      for (const [p, hash] of Object.entries(record.files).sort(([a], [b]) => (a < b ? -1 : 1))) {
        if (matchesUserEditable(p, userEditable)) continue;
        const { kind } = await lstatChain(root, p);
        if (kind !== 'file' || (await cachedHashFile(fsPath(root, p))) !== hash) differing.push(p);
      }
      if (differing.length > 0) {
        deps.logger.info('[marketplace/strict-record] the installed commit does not match', {
          root,
          differing: differing.length,
        });
        return { outcome: 'mismatch', differing: differing.slice(0, STRICT_MISMATCH_LIST_LIMIT) };
      }

      await writeInstalledFiles(root, record);
      deps.logger.info('[marketplace/strict-record] rebuilt a record from the installed commit', {
        root,
        files: Object.keys(record.files).length,
      });
      return { outcome: 'rebuilt', files: Object.keys(record.files).length };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
}
