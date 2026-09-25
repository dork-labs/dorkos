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
 * A record that fallback only guessed (`inferred`) counts as no record yet, so
 * both run this on it (DOR-2322). A record that lists files an update kept
 * because nothing proved whose they were (`unproven`) is sorted only when a
 * person asks (`sortUnproven`, the "Check files" action): see `./unproven-sort.ts`.
 *
 * @module services/marketplace/lib/integrity/strict-record
 */
import { lstat, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { INSTALL_METADATA_POSIX_PATH, INSTALLED_FILES_PATH } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import { readInstallMetadataStrict, type InstallMetadata } from '../../installed-metadata.js';
import type { PackageFetcher } from '../../package-fetcher.js';
import { withInstallTargetLock } from '../../transaction.js';
import {
  computeInstalledFiles,
  readInstalledFiles,
  writeInstalledFiles,
} from '../installed-files.js';
import {
  fetchableSourceOf,
  recordIdentityOf,
  stageInstalledCommit,
  userEditableOf,
} from '../legacy-record.js';
import { hasPackageIdentity } from '../locate-install.js';
import { rememberCheck } from './check-results.js';
import { STRICT_RECORD_TEMP_PREFIX, strictDifferences } from './strict-differences.js';

export { STRICT_RECORD_TEMP_PREFIX };
import { sortUnprovenFiles } from './unproven-sort.js';

/** Most differing paths a mismatch names. */
export const STRICT_MISMATCH_LIST_LIMIT = 50;

/**
 * What a strict rebuild did. Only `rebuilt` and `sorted` changed anything.
 * `unproven` on `no-source` and `fetch-failed` says the attempt was to sort an
 * update's kept files rather than to record an older install.
 */
export type StrictRebuildResult =
  | { outcome: 'rebuilt'; files: number }
  | { outcome: 'sorted'; setAside: { path: string; savedAs: string }[]; kept: string[] }
  | { outcome: 'not-needed'; why: 'has-record' | 'not-installed' | 'linked' }
  | { outcome: 'no-source'; unproven?: true }
  | { outcome: 'fetch-failed'; message: string; unproven?: true }
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
 * Whether `root` is a legacy install (no record, or one only guessed), holds
 * files an update kept unproven, or why it needs nothing.
 *
 * @param root - The install folder.
 */
export async function legacyState(
  root: string
): Promise<'legacy' | 'unproven' | 'linked' | 'has-record' | 'not-installed'> {
  if ((await lstat(root).catch(() => undefined))?.isSymbolicLink()) return 'linked';
  if (await exists(fsPath(root, INSTALLED_FILES_PATH))) {
    const record = await readInstalledFiles(root);
    if (record?.inferred) return (await hasPackageIdentity(root)) ? 'legacy' : 'not-installed';
    if (record?.unproven) return 'unproven';
    return 'has-record';
  }
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
 * @param opts - `sortUnproven`: also sort the files an update kept unproven
 *   (the "Check files" action; it can remove leftovers, so the sweep never asks).
 * @returns What happened; only `rebuilt` and `sorted` changed anything on disk.
 */
export async function rebuildRecordStrict(
  root: string,
  deps: StrictRecordDeps,
  opts: { sortUnproven?: boolean } = {}
): Promise<StrictRebuildResult> {
  const before = await legacyState(root);
  if (before === 'unproven') {
    if (!opts.sortUnproven) return { outcome: 'not-needed', why: 'has-record' };
    const result = await sortUnprovenFiles(root, deps);
    const name = (await readInstalledFiles(root))?.package.name ?? path.basename(root);
    rememberCheck(root, name, result);
    return result;
  }
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
        if (now !== 'legacy')
          return { outcome: 'not-needed', why: now === 'unproven' ? 'has-record' : now };
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

        const differing = await strictDifferences(root, record, userEditable);
        if (differing.length > 0) {
          deps.logger.info('[marketplace/strict-record] the installed commit does not match', {
            root,
            differing: differing.length,
          });
          return {
            outcome: 'mismatch',
            differing: differing.slice(0, STRICT_MISMATCH_LIST_LIMIT),
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
    case 'sorted': {
      const aside = result.setAside.length;
      const kept = result.kept.length;
      if (aside === 0) {
        return `Checked the files ${name} kept: ${kept === 1 ? 'the 1 file is yours, so it stays' : `all ${kept} are yours, so they stay`}.`;
      }
      const where = result.setAside.map((f) => f.savedAs).join(', ');
      return `Checked the files ${name} kept: set aside ${aside} left over from the version you had before (${where})${kept > 0 ? `, and kept ${kept} as yours` : ''}.`;
    }
    case 'not-needed':
      return `${name}'s files are already checked.`;
    case 'no-source':
      return result.unproven
        ? `${name} was installed from a folder on this computer, so there's no earlier version to sort the files it kept against. Delete any you don't need.`
        : `${name} was installed from a folder on this computer, so there's no version to compare it with. Reinstall it so updates keep your edits.`;
    case 'fetch-failed':
      return result.unproven
        ? `Couldn't fetch the version of ${name} you had before (${result.message}), so the files it kept stay as they are. Try again when you're online.`
        : `Couldn't fetch the version of ${name} you installed (${result.message}). Try again when you're online.`;
    case 'mismatch':
      return `Some of ${name}'s files differ from the version you installed, so DorkOS can't tell your edits from the package's files. Its next update still keeps your copies.`;
  }
}
