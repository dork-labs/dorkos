import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

/** Three daily recovery points keep recent fallbacks without accumulating full copies. */
const DAILY_SNAPSHOT_LIMIT = 3;
/** Three upgrade recovery points bound disk use even during repeated upgrades. */
const PRE_MIGRATION_SNAPSHOT_LIMIT = 3;
/** Five store recovery points preserve each extension's separate migration history. */
const EXTENSION_SNAPSHOT_LIMIT = 5;

/** New snapshot counts stay bounded; pre-upgrade `dork-` copies are excluded. */
export const SNAPSHOT_RETENTION = {
  /** Keep at most three pre-migration copies within the last seven days. */
  preMigration: PRE_MIGRATION_SNAPSHOT_LIMIT,
  /** Keep the last three daily recovery points, including across offline days. */
  daily: DAILY_SNAPSHOT_LIMIT,
  /** One extension's recovery history is independent of dork.db. */
  extension: EXTENSION_SNAPSHOT_LIMIT,
} as const;

/** A week covers recent upgrades without retaining full database copies indefinitely. */
export const PRE_MIGRATION_MAX_AGE_DAYS = 7;

/**
 * Only new dork-auto names opt in to retention. Never inspect or prune completed
 * legacy dork copies; unfinished copies have separate privacy cleanup.
 * Extension retention is unchanged. Partials never match either writer.
 */
const OWNED_NAME =
  /^(?:dork-auto-(\d{8})-(?:daily|([0-9]{6})-pre-(?:\d{4}|\d{14})_[a-z0-9_]+)|store-(\d{8})-([0-9]{6})-pre-v\d+)\.db$/;

/** The existing log port, shared by snapshot writers and retention. */
export interface SnapshotLog {
  info(message: string): void;
  warn(message: string, meta?: unknown): void;
}

/** Optional age, current-copy protection and log port for a prune. */
export interface PruneSnapshotOptions {
  /** Clock override for age retention. */
  now?: Date;
  /** Delete older copies past this many days, but retain the newest recovery point. */
  maxAgeDays?: number;
  /** A just-written or reused copy to protect even if the clock moved backwards. */
  protectedPath?: string;
  /** Defaults to the process log when no server logger was supplied. */
  log?: SnapshotLog;
}

/** Read the timestamp only from a complete writer-owned filename and a real UTC date. */
function snapshotTime(name: string): number | null {
  const match = OWNED_NAME.exec(name);
  if (!match) return null;
  const day = match[1] ?? match[3];
  const clock = match[2] ?? match[4] ?? '000000';
  const iso = `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${clock.slice(0, 2)}:${clock.slice(2, 4)}:${clock.slice(4, 6)}.000Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time).toISOString() === iso ? time : null;
}

/**
 * Recognize a partial's base filename, including legacy writers, for privacy cleanup.
 * Never use this broader ownership check to prune completed legacy backups.
 *
 * @param name - Filename without any partial or journal suffix
 */
export function isSnapshotPartialBase(name: string): boolean {
  return snapshotTime(name.replace(/^dork-(?=\d{8}-)/, 'dork-auto-')) !== null;
}

/** Distinguish a confirmed incomplete copy from a copy that cannot currently be checked. */
export function inspectSnapshot(
  snapshotPath: string,
  requiredTable?: string
): 'usable' | 'incomplete' | 'unavailable' {
  let snapshot: Database.Database | undefined;
  try {
    if (fs.statSync(snapshotPath).size === 0) return 'incomplete';
    snapshot = new Database(snapshotPath, { readonly: true, timeout: 0 });
    const found = requiredTable
      ? snapshot
          .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
          .get(requiredTable)
      : snapshot
          .prepare(
            `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1`
          )
          .get();
    return found !== undefined ? 'usable' : 'incomplete';
  } catch (err) {
    const code = (err as { code?: string }).code;
    return code === 'SQLITE_NOTADB' || code === 'SQLITE_CORRUPT' ? 'incomplete' : 'unavailable';
  } finally {
    snapshot?.close();
  }
}

/** Identity checked again immediately before unlinking a selected snapshot. */
interface Candidate {
  name: string;
  time: number;
  identity: fs.Stats;
}

/**
 * Refuse folder substitution or a symlink as the snapshot directory itself.
 *
 * @param dir - The snapshot directory as configured
 * @param realDir - Its real path when first read
 * @param identity - Its `lstat` when first read
 */
export function sameDirectory(dir: string, realDir: string, identity: fs.Stats): boolean {
  const current = fs.lstatSync(dir);
  return (
    current.isDirectory() &&
    current.dev === identity.dev &&
    current.ino === identity.ino &&
    fs.realpathSync(dir) === realDir
  );
}

/**
 * A partial sibling or SQLite journal means this name is not eligible for pruning,
 * or for a person's Remove or Move (DOR-4253).
 *
 * @param file - Absolute path of a snapshot copy
 */
export function hasWriteInProgress(file: string): boolean {
  return [
    '.partial',
    '.partial-journal',
    '.partial-wal',
    '.partial-shm',
    '-journal',
    '-wal',
    '-shm',
  ].some((suffix) => {
    try {
      fs.lstatSync(`${file}${suffix}`);
      return true;
    } catch (err) {
      // Absence alone is safe; an unreadable sidecar is a reason to leave the copy alone.
      return (err as NodeJS.ErrnoException).code !== 'ENOENT';
    }
  });
}

/**
 * Prune only completed writer-owned regular files, oldest first within each kind.
 *
 * The newest name and newest usable copy survive even a zero limit or an expired
 * history. Unsafe, changing or busy entries are left alone; refused deletions are
 * logged and retried on a later call. Cleanup must not block a protected migration.
 *
 * @param dir - Snapshot directory (a symlink at this path is refused)
 * @param pattern - The caller's snapshot kind, further restricted to writer-owned names
 * @param keep - Desired count, clamped to at least one usable recovery point
 * @param options - Age policy, current snapshot and logger
 * @returns Only filenames successfully deleted by this call
 */
export function pruneSnapshots(
  dir: string,
  pattern: RegExp,
  keep: number,
  options: PruneSnapshotOptions = {}
): string[] {
  const log = options.log ?? console;
  const deleted: string[] = [];
  try {
    const directory = fs.lstatSync(dir);
    if (!directory.isDirectory()) {
      log.warn('[DB] Snapshot pruning refused a non-directory backup path');
      return deleted;
    }
    const realDir = fs.realpathSync(dir);
    const candidates: Candidate[] = [];
    for (const name of fs.readdirSync(realDir).sort()) {
      pattern.lastIndex = 0;
      const time = snapshotTime(name);
      if (time === null || !pattern.test(name)) continue;
      const file = path.join(realDir, name);
      try {
        const identity = fs.lstatSync(file);
        if (!identity.isFile() || fs.realpathSync(file) !== file) {
          log.warn(`[DB] Snapshot pruning refused a non-regular copy: ${name}`);
          continue;
        }
        if (hasWriteInProgress(file)) continue;
        candidates.push({ name, time, identity });
      } catch (err) {
        log.warn(`[DB] Snapshot pruning could not inspect ${name}`, err);
      }
    }
    const protectedNames = new Set<string>();
    const newest = candidates.at(-1);
    if (newest) protectedNames.add(newest.name);
    if (
      options.protectedPath &&
      path.dirname(path.resolve(options.protectedPath)) === path.resolve(dir)
    ) {
      protectedNames.add(path.basename(options.protectedPath));
    }
    const real: Candidate[] = [];
    const wreckage: Candidate[] = [];
    for (const candidate of candidates) {
      const state = inspectSnapshot(path.join(realDir, candidate.name));
      if (state === 'unavailable') {
        log.warn(`[DB] Snapshot pruning left an unavailable copy alone: ${candidate.name}`);
        continue;
      }
      (state === 'usable' ? real : wreckage).push(candidate);
    }
    const newestUsable = real.at(-1);
    if (newestUsable) protectedNames.add(newestUsable.name);
    const cutoff =
      options.maxAgeDays === undefined
        ? -Infinity
        : (options.now ?? new Date()).getTime() - options.maxAgeDays * 86_400_000;
    const expired = real.filter((copy) => copy.time < cutoff && !protectedNames.has(copy.name));
    const recent = real.filter((copy) => !expired.includes(copy));
    const count = Number.isFinite(keep) ? Math.max(1, Math.floor(keep)) : recent.length;
    let excess = recent.length - count;
    const overLimit = recent.filter((copy) => !protectedNames.has(copy.name) && excess-- > 0);
    const doomed = [...wreckage, ...expired, ...overLimit].filter(
      (copy) => !protectedNames.has(copy.name)
    );
    for (const copy of doomed) {
      const file = path.join(realDir, copy.name);
      try {
        if (!sameDirectory(dir, realDir, directory)) {
          log.warn('[DB] Snapshot pruning stopped because the backup directory changed');
          break;
        }
        const current = fs.lstatSync(file);
        if (
          !current.isFile() ||
          current.dev !== copy.identity.dev ||
          current.ino !== copy.identity.ino ||
          current.size !== copy.identity.size ||
          current.mtimeMs !== copy.identity.mtimeMs ||
          fs.realpathSync(file) !== file ||
          hasWriteInProgress(file)
        ) {
          log.warn(`[DB] Snapshot pruning left a changed or busy copy alone: ${copy.name}`);
          continue;
        }
        fs.unlinkSync(file);
        deleted.push(copy.name);
        log.info(`[DB] Pruned snapshot: ${copy.name}`);
      } catch (err) {
        log.warn(`[DB] Snapshot pruning could not remove ${copy.name}`, err);
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT')
      log.warn('[DB] Snapshot pruning could not read the backup directory', err);
  }
  return deleted;
}
