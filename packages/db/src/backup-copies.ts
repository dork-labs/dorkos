/**
 * The person's view of the dork.db backup folder (DOR-4253): list every copy a
 * DorkOS writer made, and let the person remove or move the older ones that
 * automatic retention never touches.
 *
 * Only names a writer produced are ever listed or acted on: `dork-auto-…` copies
 * DorkOS manages, and the older `dork-…` copies written before that prefix.
 * Every action re-checks the file right before it touches it, the same way
 * {@link pruneSnapshots} does: a regular file (never a symlink) in the real
 * backup folder, unchanged since it was read, with no write in progress.
 *
 * @module backup-copies
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { hasWriteInProgress, sameDirectory } from './snapshot-retention.js';

/** What a copy was taken for. */
export type BackupCopyKind = 'daily' | 'pre-upgrade';

/** One backup copy as the person sees it. */
export interface BackupCopy {
  /** The file's name inside the backup folder. */
  name: string;
  /** What the copy was taken for. */
  kind: BackupCopyKind;
  /** True for `dork-auto-` copies, which DorkOS prunes on its own. */
  managed: boolean;
  /** Size on disk, in bytes. */
  sizeBytes: number;
  /** When the copy was taken, from its name (UTC). */
  createdAt: string;
  /** A write is in progress next to it, so it can't be removed or moved now. */
  busy: boolean;
}

/** Every copy in the folder, newest first, and their total size. */
export interface BackupCopyList {
  copies: BackupCopy[];
  totalBytes: number;
}

/**
 * A copy DorkOS manages: `dork-auto-YYYYMMDD-daily.db` or
 * `dork-auto-YYYYMMDD-HHMMSS-pre-<migration tag>.db` (the writers in `backup.ts`).
 */
const MANAGED_NAME = /^dork-auto-(\d{8})-(?:daily|(\d{6})-pre-(?:\d{4}|\d{14})_[a-z0-9_]+)\.db$/;
/**
 * An older copy, from before the `dork-auto-` prefix: `dork-YYYYMMDD-daily.db`
 * or `dork-YYYYMMDD-HHMMSS-pre-<migration tag>.db`. The tag is held to the
 * characters a migration tag has, so no other file can pass for one.
 */
const OLDER_NAME = /^dork-(\d{8})-(?:daily|(\d{6})-pre-[A-Za-z0-9_]+)\.db$/;

/** A copy's kind, management and time from its name, or null for any other file. */
function parseName(
  name: string
): { kind: BackupCopyKind; managed: boolean; createdAt: string } | null {
  const managed = MANAGED_NAME.exec(name);
  const match = managed ?? OLDER_NAME.exec(name);
  if (!match) return null;
  const day = match[1];
  const clock = match[2] ?? '000000';
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4, 6)}.000Z`;
  const time = Date.parse(iso);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== iso) return null;
  return { kind: match[2] ? 'pre-upgrade' : 'daily', managed: managed !== null, createdAt: iso };
}

/** The backup folder's identity, or null when it is missing or not a real folder. */
function openFolder(dir: string): { realDir: string; identity: fs.Stats } | null {
  try {
    const identity = fs.lstatSync(dir);
    if (!identity.isDirectory()) return null;
    return { realDir: fs.realpathSync(dir), identity };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** A regular, non-symlinked file at its own real path, or null. */
function regularFile(file: string): fs.Stats | null {
  try {
    const identity = fs.lstatSync(file);
    return identity.isFile() && fs.realpathSync(file) === file ? identity : null;
  } catch {
    return null;
  }
}

/**
 * List every writer-named copy in the backup folder, newest first.
 *
 * A missing folder lists nothing. A symlinked folder lists nothing either: it
 * is not the folder DorkOS writes. Files that are not regular, or whose name no
 * writer produces, are never listed.
 *
 * @param dir - The backup folder (`<dorkHome>/backups`)
 */
export function listBackupCopies(dir: string): BackupCopyList {
  const folder = openFolder(dir);
  if (!folder) return { copies: [], totalBytes: 0 };
  const copies: BackupCopy[] = [];
  for (const name of fs.readdirSync(folder.realDir)) {
    const parsed = parseName(name);
    if (!parsed) continue;
    const file = path.join(folder.realDir, name);
    const identity = regularFile(file);
    if (!identity) continue;
    copies.push({ name, ...parsed, sizeBytes: identity.size, busy: hasWriteInProgress(file) });
  }
  copies.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.name.localeCompare(a.name));
  return { copies, totalBytes: copies.reduce((sum, copy) => sum + copy.sizeBytes, 0) };
}

/** Why a Remove or Move did not happen. */
export type BackupCopyRefusal =
  /** No such older copy (or the folder is gone). */
  | 'not_found'
  /** DorkOS manages this copy; retention removes it on its own. */
  | 'managed'
  /** A write is in progress next to it. */
  | 'busy'
  /** It changed, or the folder did, between the check and the action. */
  | 'changed';

/** The older copy to act on, checked as it stands now. */
interface Target {
  dir: string;
  realDir: string;
  folder: fs.Stats;
  file: string;
  identity: fs.Stats;
}

/** Resolve a name to an older copy the person may act on, or why not. */
function olderCopy(dir: string, name: string): Target | BackupCopyRefusal {
  const parsed = parseName(name);
  if (!parsed) return 'not_found';
  if (parsed.managed) return 'managed';
  const folder = openFolder(dir);
  if (!folder) return 'not_found';
  const file = path.join(folder.realDir, name);
  const identity = regularFile(file);
  if (!identity) return 'not_found';
  if (hasWriteInProgress(file)) return 'busy';
  return { dir, realDir: folder.realDir, folder: folder.identity, file, identity };
}

/** Unlink the copy only if neither it nor its folder changed since `target` was read. */
function unlinkUnchanged(target: Target): 'removed' | BackupCopyRefusal {
  if (!sameDirectory(target.dir, target.realDir, target.folder)) return 'changed';
  const now = regularFile(target.file);
  if (
    !now ||
    now.dev !== target.identity.dev ||
    now.ino !== target.identity.ino ||
    now.size !== target.identity.size ||
    now.mtimeMs !== target.identity.mtimeMs
  )
    return 'changed';
  if (hasWriteInProgress(target.file)) return 'busy';
  fs.unlinkSync(target.file);
  return 'removed';
}

/**
 * Remove one older copy. DorkOS-managed copies are refused: retention owns them.
 *
 * @param dir - The backup folder
 * @param name - The copy's file name, exactly as listed
 */
export function removeOlderBackupCopy(dir: string, name: string): 'removed' | BackupCopyRefusal {
  const target = olderCopy(dir, name);
  return typeof target === 'string' ? target : unlinkUnchanged(target);
}

/** Why a Move did not happen, beyond the shared refusals. */
export type BackupMoveRefusal =
  | BackupCopyRefusal
  /** The destination is not an existing folder. */
  | 'destination_invalid'
  /** The destination is the backup folder itself. */
  | 'destination_is_backups'
  /** A file with that name is already in the destination. */
  | 'destination_exists'
  /** The copy did not match in size, or failed SQLite's integrity check. */
  | 'verify_failed'
  /** The destination's disk is full. */
  | 'destination_full'
  /** The destination can't be written: no permission, or a read-only disk. */
  | 'destination_not_writable'
  /** The copy could not be written there for another reason. */
  | 'copy_failed';

/**
 * The worker that runs SQLite's `integrity_check` off the main thread. On a big
 * older copy on a slow disk the check takes seconds to minutes, and run here it
 * would stall every request and live stream. CommonJS, because an eval worker
 * runs as a script; the driver path comes from the main thread so it resolves
 * the same `better-sqlite3` the server already loads.
 */
const INTEGRITY_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
let ok = false;
try {
  const Database = require(workerData.driver);
  const db = new Database(workerData.file, { readonly: true, fileMustExist: true, timeout: 0 });
  try {
    const rows = db.pragma('integrity_check');
    ok = rows.length === 1 && rows[0] && rows[0].integrity_check === 'ok';
  } finally {
    db.close();
  }
} catch {
  ok = false;
}
parentPort.postMessage(ok === true);
`;

/**
 * Whether a SQLite file passes `PRAGMA integrity_check`, opened read-only in a
 * worker thread. Anything that keeps the check from answering (the driver
 * can't be found, the worker fails) counts as not passing: the original stays.
 */
function passesIntegrityCheck(file: string): Promise<boolean> {
  let driver: string;
  try {
    driver = createRequire(import.meta.url).resolve('better-sqlite3');
  } catch {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const worker = new Worker(INTEGRITY_WORKER, { eval: true, workerData: { driver, file } });
    worker.once('message', (ok: unknown) => resolve(ok === true));
    worker.once('error', () => resolve(false));
    worker.once('exit', () => resolve(false));
  });
}

/** Which refusal a failed copy is, by the system's error code. */
function copyFailure(err: unknown): BackupMoveRefusal {
  switch ((err as NodeJS.ErrnoException).code) {
    case 'EEXIST':
      return 'destination_exists';
    case 'ENOSPC':
    case 'EDQUOT':
      return 'destination_full';
    case 'EACCES':
    case 'EPERM':
    case 'EROFS':
      return 'destination_not_writable';
    default:
      return 'copy_failed';
  }
}

/** The result of a Move: where the copy now lives, or why it stayed put. */
export type BackupMoveResult =
  { status: 'moved'; destinationPath: string } | { status: BackupMoveRefusal };

/**
 * Move one older copy to a folder the person chose.
 *
 * The copy is written without overwriting anything, then checked: the same
 * size, and SQLite's `integrity_check` answers `ok`. Only then is the original
 * removed, and only if it is unchanged. A check that fails deletes the new
 * file and leaves the original where it was. Whether the destination is a
 * place this person may write is the caller's decision (the server's boundary).
 *
 * @param dir - The backup folder
 * @param name - The copy's file name, exactly as listed
 * @param destinationDir - An existing absolute folder outside the backup folder
 */
export async function moveOlderBackupCopy(
  dir: string,
  name: string,
  destinationDir: string
): Promise<BackupMoveResult> {
  const target = olderCopy(dir, name);
  if (typeof target === 'string') return { status: target };
  if (!path.isAbsolute(destinationDir)) return { status: 'destination_invalid' };
  let realDestination: string;
  try {
    if (!fs.statSync(destinationDir).isDirectory()) return { status: 'destination_invalid' };
    realDestination = fs.realpathSync(destinationDir);
  } catch {
    return { status: 'destination_invalid' };
  }
  if (realDestination === target.realDir) return { status: 'destination_is_backups' };
  const destinationPath = path.join(realDestination, name);
  try {
    await fs.promises.copyFile(target.file, destinationPath, fs.constants.COPYFILE_EXCL);
  } catch (err) {
    const status = copyFailure(err);
    // Never overwriting means a file left at this path can only be our partial copy.
    if (status !== 'destination_exists') await fs.promises.rm(destinationPath, { force: true });
    return { status };
  }
  const copied = regularFile(destinationPath);
  if (
    !copied ||
    copied.size !== target.identity.size ||
    !(await passesIntegrityCheck(destinationPath))
  ) {
    await fs.promises.rm(destinationPath, { force: true });
    return { status: 'verify_failed' };
  }
  const removed = unlinkUnchanged(target);
  if (removed !== 'removed') {
    // The original changed under us: keep it, and drop the copy of its old bytes.
    await fs.promises.rm(destinationPath, { force: true });
    return { status: removed };
  }
  return { status: 'moved', destinationPath };
}
