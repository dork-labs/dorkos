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
import {
  EFFECT_BEARING_PATHS,
  INSTALLED_FILES_PATH,
  isReservedPackagePath,
  matchesUserEditable,
} from '@dorkos/marketplace';
import type { InstallIntegrity } from '@dorkos/shared/marketplace-schemas';
import {
  isNeverCarried,
  lstatChain,
  readInstalledFiles,
  scanTree,
  type InstalledFiles,
} from '../installed-files.js';
import { cachedHashFile } from './file-hash-cache.js';

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
    return { status: 'unknown', reason: hasFile ? 'unreadable-record' : 'no-record' };
  }

  const changed: string[] = [];
  const missing: string[] = [];
  const customized: string[] = [];
  for (const [p, hash] of Object.entries(record.files)) {
    const editable = matchesUserEditable(p, record.userEditable);
    const { kind } = await lstatChain(root, p);
    if (kind !== 'file') {
      if (!editable) missing.push(p);
      continue;
    }
    if ((await cachedHashFile(fsPath(root, p))) === hash) continue;
    (editable ? customized : changed).push(p);
  }
  const added = await addedEffectFiles(root, record);

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
  const extra = truncated ? { truncated: true as const } : {};
  if (lists.changed.length + lists.missing.length + lists.added.length === 0) {
    return { status: 'clean', customized: lists.customized, ...extra };
  }
  return { status: 'modified', ...lists, ...extra };
}

/**
 * Unrecorded files and links at or under an effect-bearing path, found without
 * following any link. The installer's files, reserved paths (data, secrets,
 * `.dork-old` / `.dork-new` copies) and owned paths are never counted. An
 * agent's identity files (`.dork/agent.json`, `.dork/SOUL.md`, …) sit outside
 * every effect-bearing path, so they never reach this check.
 */
async function addedEffectFiles(root: string, record: InstalledFiles): Promise<string[]> {
  const counts = (p: string): boolean =>
    !(p in record.files) && !isReservedPackagePath(p) && !isNeverCarried(p, record.ownedPaths);
  const added = new Set<string>();
  for (const effectPath of new Set(Object.values(EFFECT_BEARING_PATHS))) {
    const { kind } = await lstatChain(root, effectPath);
    if (kind === 'file' || kind === 'symlink') {
      if (counts(effectPath)) added.add(effectPath);
      continue;
    }
    if (kind !== 'dir') continue;
    const scan = await scanTree(fsPath(root, effectPath));
    for (const [rel, entry] of scan.entries) {
      const p = `${effectPath}/${rel}`;
      if ((entry.kind === 'file' || entry.kind === 'symlink') && counts(p)) added.add(p);
    }
  }
  return [...added];
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
