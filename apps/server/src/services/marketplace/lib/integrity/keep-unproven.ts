/**
 * "Keep these as mine" (DOR-2341): a person claims the files an update kept
 * because nothing could prove whose they were (DOR-2322), for an install whose
 * earlier version Check files can never fetch (a local folder, or a commit
 * that no longer exists).
 *
 * The record's `unproven` list is dropped. Nothing on disk moves, is renamed,
 * or loses its mode: from then on the files are simply files the person added,
 * which every update keeps and `verifyInstall` lists as added.
 *
 * The acceptance is bound to exactly what the person was shown, by a key
 * ({@link keptFilesKey}) handed out with the integrity answer and sent back
 * with the request: the package the record names, the version its install
 * metadata says, and every kept file still present with its bytes. It is
 * recomputed under the install lock, so an edit, a new kept file, or an update
 * that ran after the person looked is refused rather than accepted unseen.
 *
 * Only a person may run it; the route enforces that. Approving what a global
 * package runs is a separate decision the route records alongside, when the
 * person was shown it.
 *
 * @module services/marketplace/lib/integrity/keep-unproven
 */
import { createHash } from 'node:crypto';
import { readlink } from 'node:fs/promises';
import path from 'node:path';
import { stableStringify } from '@dorkos/shared/capabilities';
import { readInstallMetadata } from '../../installed-metadata.js';
import { withInstallTargetLock } from '../../transaction.js';
import {
  readInstalledFiles,
  writeInstalledFiles,
  type InstalledFiles,
} from '../records/installed-files.js';
import { hashFile, lstatChain } from '../records/tree-scan.js';
import { runningUnproven } from './unproven.js';

/** What {@link keepUnprovenFiles} did. */
export type KeepUnprovenResult =
  | {
      outcome: 'kept';
      /** The kept files that were still there, now the person's. */
      files: string[];
      /** Those of them that sit where a package keeps what it runs. */
      running: string[];
    }
  /** Something differs from the key: nothing was written. */
  | { outcome: 'changed' }
  /** The record lists no kept files (any more). */
  | { outcome: 'not-needed' };

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/**
 * {@link keptFilesKey} over a record already read.
 *
 * @param root - The install folder.
 * @param record - Its record.
 */
export async function keptFilesKeyOf(
  root: string,
  record: InstalledFiles
): Promise<string | undefined> {
  if (!record.unproven) return undefined;
  const files: [string, string][] = [];
  for (const p of Object.keys(record.unproven.files).sort()) {
    const { kind } = await lstatChain(root, p);
    if (kind === 'missing') continue;
    files.push([
      p,
      kind === 'file'
        ? await hashFile(fsPath(root, p))
        : kind === 'symlink'
          ? `symlink:${await readlink(fsPath(root, p))}`
          : kind,
    ]);
  }
  const metadata = await readInstallMetadata(root).catch(() => null);
  return `sha256:${createHash('sha256')
    .update(
      stableStringify({
        package: record.package,
        version: metadata?.contentHash ?? metadata?.version ?? null,
        files,
      }),
      'utf8'
    )
    .digest('hex')}`;
}

/**
 * The key a "Keep these as mine" request must send back: the package, its
 * installed version, and every kept file still present with its bytes (or what
 * it is, when it is not a regular file). `undefined` when nothing is kept.
 *
 * @param root - The install folder.
 */
export async function keptFilesKey(root: string): Promise<string | undefined> {
  const record = await readInstalledFiles(root);
  return record ? keptFilesKeyOf(root, record) : undefined;
}

/**
 * Make the files an update kept unsorted the person's: drop the record's
 * `unproven` list, under the install lock, only when the key still matches.
 * Deletes, moves and renames nothing.
 *
 * @param root - The install folder.
 * @param key - The {@link keptFilesKey} the person was shown.
 * @param whileLocked - Run after the record is written, still under the same
 *   install lock, so nothing can change the install between the keep and it.
 * @returns What was kept, or why nothing was written.
 */
export async function keepUnprovenFiles(
  root: string,
  key: string,
  whileLocked?: () => Promise<void>
): Promise<KeepUnprovenResult> {
  return withInstallTargetLock(root, async (): Promise<KeepUnprovenResult> => {
    const record = await readInstalledFiles(root);
    if (!record?.unproven) return { outcome: 'not-needed' };
    if ((await keptFilesKeyOf(root, record)) !== key) return { outcome: 'changed' };
    const running = await runningUnproven(root, record);
    const files: string[] = [];
    for (const p of Object.keys(record.unproven.files).sort()) {
      if ((await lstatChain(root, p)).kind !== 'missing') files.push(p);
    }
    const { unproven: _theirs, ...rest } = record;
    await writeInstalledFiles(root, rest);
    await whileLocked?.();
    return { outcome: 'kept', files, running };
  });
}
