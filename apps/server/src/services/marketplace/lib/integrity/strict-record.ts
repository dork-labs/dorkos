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
 * background sweep after boot and the "Check files" action use.
 *
 * @module services/marketplace/lib/integrity/strict-record
 */
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  INSTALL_METADATA_POSIX_PATH,
  INSTALLED_FILES_PATH,
  matchesUserEditable,
} from '@dorkos/marketplace';
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
import { rememberCheck } from './check-results.js';
import { addedEffectFiles } from './verify-install.js';

/** The prefix of every scratch folder a strict rebuild stages into, for leftover cleanup. */
export const STRICT_RECORD_TEMP_PREFIX = 'dorkos-strict-record-';

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

/** Whether `root` is a legacy install, or why it needs no rebuild. */
async function legacyState(
  root: string
): Promise<'legacy' | 'linked' | 'has-record' | 'not-installed'> {
  if ((await lstat(root).catch(() => undefined))?.isSymbolicLink()) return 'linked';
  if (await exists(fsPath(root, INSTALLED_FILES_PATH))) return 'has-record';
  if (!(await hasPackageIdentity(root))) return 'not-installed';
  return 'legacy';
}

/**
 * Rebuild the installed-files record of the legacy install at `root`, or
 * write nothing. See the module header for the rules.
 *
 * The fetch and the staging run before the install lock is taken, so a slow
 * network never holds up an install of the same package. Only the re-check,
 * the comparison and the write run under the lock.
 *
 * @param root - The install folder.
 * @param deps - The fetcher and a logger.
 * @returns What happened; only `rebuilt` changed anything on disk.
 */
export async function rebuildRecordStrict(
  root: string,
  deps: StrictRecordDeps
): Promise<StrictRebuildResult> {
  const before = await legacyState(root);
  if (before !== 'legacy') return { outcome: 'not-needed', why: before };

  let metadata: InstallMetadata | null = null;
  try {
    metadata = await readInstallMetadataStrict(root);
  } catch (err) {
    deps.logger.warn('[marketplace/strict-record] unreadable install sidecar', {
      root,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const remember = (result: StrictRebuildResult): StrictRebuildResult => {
    rememberCheck(root, metadata?.name ?? path.basename(root), result);
    return result;
  };
  const source = fetchableSourceOf(metadata);
  if (!source) return remember({ outcome: 'no-source' });

  const scratch = await mkdtemp(path.join(tmpdir(), STRICT_RECORD_TEMP_PREFIX));
  try {
    const fetched = path.join(scratch, 'installed');
    try {
      await stageInstalledCommit(source, fetched, deps);
    } catch (err) {
      return remember({
        outcome: 'fetch-failed',
        message: err instanceof Error ? err.message : String(err),
      });
    }
    const userEditable = await userEditableOf(fetched);
    const record = await computeInstalledFiles(fetched, {
      identity: recordIdentityOf(metadata, path.basename(root), 'plugin'),
      userEditable,
      npmRan: await exists(path.join(root, 'node_modules')),
    });

    return remember(
      await withInstallTargetLock(root, async (): Promise<StrictRebuildResult> => {
        // Re-checked under the lock: an install, update or uninstall that held
        // it may have changed what stands here.
        const now = await legacyState(root);
        if (now !== 'legacy') return { outcome: 'not-needed', why: now };
        // An older DorkOS sharing this data directory does not honour the lock:
        // if it reinstalled the package while the fetch ran, the sidecar names
        // another commit and the fetched tree is no longer the installed one.
        const current = fetchableSourceOf(await readInstallMetadataStrict(root).catch(() => null));
        if (
          current?.commitSha !== source.commitSha ||
          JSON.stringify(current.sourceKey) !== JSON.stringify(source.sourceKey)
        ) {
          return { outcome: 'mismatch', differing: [INSTALL_METADATA_POSIX_PATH] };
        }

        const differing: string[] = [];
        for (const [p, hash] of Object.entries(record.files)) {
          if (matchesUserEditable(p, userEditable)) continue;
          const { kind } = await lstatChain(root, p);
          if (kind !== 'file' || (await cachedHashFile(fsPath(root, p))) !== hash)
            differing.push(p);
        }
        // The live folder must also hold nothing extra where a package keeps
        // what it runs: an unrecorded skill or hook would otherwise verify
        // clean while it runs. This also catches a case-only rename, whose
        // live spelling is unrecorded.
        differing.push(...(await addedEffectFiles(root, record)));
        if (differing.length > 0) {
          deps.logger.info('[marketplace/strict-record] the installed commit does not match', {
            root,
            differing: differing.length,
          });
          return {
            outcome: 'mismatch',
            differing: [...new Set(differing)].sort().slice(0, STRICT_MISMATCH_LIST_LIMIT),
          };
        }

        await writeInstalledFiles(root, record);
        deps.logger.info('[marketplace/strict-record] rebuilt a record from the installed commit', {
          root,
          files: Object.keys(record.files).length,
        });
        return { outcome: 'rebuilt', files: Object.keys(record.files).length };
      })
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * One sentence a person reads about a strict rebuild of `name`'s record: the
 * answer the "Check files" action (DOR-2320) gives in the app and the CLI.
 *
 * @param name - The package name.
 * @param result - What {@link rebuildRecordStrict} returned.
 */
export function describeStrictRebuild(name: string, result: StrictRebuildResult): string {
  switch (result.outcome) {
    case 'rebuilt':
      return `Checked ${name}. Its files match the version you installed, so updates will keep your edits.`;
    case 'not-needed':
      return `${name}'s files are already checked.`;
    case 'no-source':
      return `${name} was installed from a folder on this computer, so there's no version to compare it with. Reinstall it so updates keep your edits.`;
    case 'fetch-failed':
      return `Couldn't fetch the version of ${name} you installed (${result.message}). Try again when you're online.`;
    case 'mismatch':
      return `Some of ${name}'s files differ from the version you installed, so DorkOS can't tell your edits from the package's files. Its next update still keeps your copies.`;
  }
}
