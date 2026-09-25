/**
 * Whether an install's files still match what was installed (DOR-2197).
 *
 * The installed-files record (DOR-2245) lists every file the package shipped
 * with its SHA-256, taken as the install activated, so it is the answer to
 * "is this still what was installed?". This reads the live folder against it:
 *
 * - a recorded file that differs is `changed`; one that is gone, or is no
 *   longer a regular file reached through real directories, is `missing`;
 * - a recorded file the package marks `userEditable` is the person's to edit:
 *   an edit is `customized` and a deletion is nothing (spec row 3a);
 * - an unrecorded file at or under a path a package keeps what it runs in
 *   (`EFFECT_BEARING_PATHS`: skills, hooks, servers, …) is `added`, because
 *   Harness Sync projects it; unrecorded files anywhere else are the person's.
 *
 * Read-only and lock-free: a concurrent install can make one answer stale, and
 * the next call corrects it. Hashes go through {@link cachedHashFile}, which
 * is the record's own `hashFile` behind a stat-keyed memo.
 *
 * @module services/marketplace/lib/integrity/verify-install
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { INSTALLED_FILES_PATH, matchesUserEditable, validUserEditable } from '@dorkos/marketplace';
import type { InstallCheckInfo, InstallIntegrity } from '@dorkos/shared/marketplace-schemas';
import { readInstallMetadataStrict } from '../../installed-metadata.js';
import { fetchableSourceOf } from '../legacy-record.js';
import { lastCheck } from './check-results.js';
import { lstatChain, readInstalledFiles } from '../installed-files.js';
import { cachedHashFile } from './file-hash-cache.js';
import { addedEffectFiles } from './strict-differences.js';

/**
 * Whether "Check files" can record a legacy install's files (its sidecar names
 * an exact commit to fetch) and what the last attempt said.
 */
async function checkInfoOf(root: string): Promise<InstallCheckInfo> {
  const metadata = await readInstallMetadataStrict(root).catch(() => null);
  const last = lastCheck(root);
  return {
    source: fetchableSourceOf(metadata) ? 'fetchable' : 'local',
    ...(last && { last }),
  };
}

/** Most paths any one list in an {@link InstallIntegrity} carries. */
export const INTEGRITY_LIST_LIMIT = 50;

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/**
 * Verify the install at `root` against its installed-files record.
 *
 * @param root - The install folder.
 * @returns What {@link InstallIntegrity} documents.
 */
export async function verifyInstall(root: string): Promise<InstallIntegrity> {
  const rootStats = await lstat(root).catch(() => undefined);
  if (rootStats?.isSymbolicLink()) return { status: 'unknown', reason: 'linked' };
  const record = await readInstalledFiles(root);
  if (!record) {
    const hasFile =
      (await lstat(fsPath(root, INSTALLED_FILES_PATH)).catch(() => undefined)) !== undefined;
    if (hasFile) return { status: 'unknown', reason: 'unreadable-record' };
    return { status: 'unknown', reason: 'no-record', check: await checkInfoOf(root) };
  }
  // Guessed by matching bytes, so it speaks for nothing yet (DOR-2322).
  if (record.inferred) {
    return { status: 'unknown', reason: 'inferred', check: await checkInfoOf(root) };
  }

  const changed: string[] = [];
  const missing: string[] = [];
  const customized: string[] = [];
  const userEditable = validUserEditable(record.userEditable);
  for (const [p, hash] of Object.entries(record.files)) {
    const editable = matchesUserEditable(p, userEditable);
    const { kind } = await lstatChain(root, p);
    if (kind !== 'file') {
      // An editable file that is gone is the person's call (row 3a); one they
      // replaced with a folder or a link is still their change to it.
      if (!editable) missing.push(p);
      else if (kind !== 'missing') customized.push(p);
      continue;
    }
    if ((await cachedHashFile(fsPath(root, p))) === hash) continue;
    (editable ? customized : changed).push(p);
  }
  // Files an update kept unproven are neither the person's additions nor
  // known to be the package's: named on their own, never as `added`.
  const unprovenPaths = Object.keys(record.unproven?.files ?? {});
  const added = (await addedEffectFiles(root, record)).filter((p) => !unprovenPaths.includes(p));
  const stillThere: string[] = [];
  for (const p of unprovenPaths) {
    if ((await lstatChain(root, p)).kind !== 'missing') stillThere.push(p);
  }

  let truncated = false;
  const cap = (list: string[]): string[] => {
    const sorted = [...list].sort();
    if (sorted.length > INTEGRITY_LIST_LIMIT) truncated = true;
    return sorted.slice(0, INTEGRITY_LIST_LIMIT);
  };
  const lists = {
    changed: cap(changed),
    missing: cap(missing),
    added: cap(added),
    customized: cap(customized),
  };
  const unproven =
    stillThere.length > 0
      ? {
          unproven: {
            files: cap(stillThere),
            check: {
              source: record.unproven?.from ? ('fetchable' as const) : ('local' as const),
              ...(lastCheck(root) && { last: lastCheck(root)! }),
            },
          },
        }
      : {};
  const extra = truncated ? { truncated: true as const } : {};
  if (lists.changed.length + lists.missing.length + lists.added.length === 0) {
    return { status: 'clean', customized: lists.customized, ...unproven, ...extra };
  }
  return { status: 'modified', ...lists, ...unproven, ...extra };
}

/** How many installs {@link withIntegrity} verifies at once, like update checks. */
export const VERIFY_CONCURRENCY = 4;

/**
 * Each installation with its {@link InstallIntegrity} added, verified at most
 * {@link VERIFY_CONCURRENCY} at a time, in the order given.
 *
 * @param installations - Installed packages, each naming its `installPath`.
 */
export async function withIntegrity<T extends { installPath: string }>(
  installations: readonly T[]
): Promise<(T & { integrity: InstallIntegrity })[]> {
  const out: (T & { integrity: InstallIntegrity })[] = new Array(installations.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < installations.length) {
      const i = next++;
      out[i] = {
        ...installations[i],
        integrity: await verifyInstall(installations[i].installPath),
      };
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(VERIFY_CONCURRENCY, installations.length) }, worker)
  );
  return out;
}
