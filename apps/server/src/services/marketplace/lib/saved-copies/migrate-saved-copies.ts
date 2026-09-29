/**
 * Make the copies earlier versions saved aside inert (DOR-2340).
 *
 * Before DOR-2340 an update kept a saved copy's execute bits, saved a program
 * from `bin/` beside itself on the agent's `PATH`, and saved a folder beside
 * its original, where it still loaded as a skill or command. This pass fixes
 * what those versions left, once per install root, and never touches a
 * person's own folders:
 *
 * - A folder under a kept-copy name (`X.dork-old`) is moved under
 *   `.dork/saved` only when BOTH hold: it sits inside a location a package
 *   runs from (the defaults and every location its plugin.json declares), and
 *   `X` is the package's (the record lists `X` or something under it). A
 *   folder a person named that way themselves stays where it is.
 * - A saved file in `bin/` moves under `.dork/saved` when the file it was
 *   saved from (`bin/X`) is the package's; a person's own is only made inert.
 * - Every other saved file inside those locations loses its execute bits.
 *
 * A root with no record is left alone (nothing says what is the package's).
 * The kept-file list (DOR-2322) follows every move. The record's
 * `savedCopies` says a root is done, so later boots do not walk it again, and
 * an uninstall that removes the record leaves nothing of it behind. Each root
 * is handled under its install lock, so no install races it.
 *
 * @module services/marketplace/lib/saved-copies/migrate-saved-copies
 */
import { lstat, mkdir, readdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { EFFECT_BEARING_PATHS, KEPT_COPY_BASENAME } from '@dorkos/marketplace';
import type { Logger } from '@dorkos/shared/logger';
import {
  readInstalledFiles,
  writeInstalledFiles,
  type InstalledFiles,
} from '../records/installed-files.js';
import { declaredLocationsOf } from '../integrity/strict-differences.js';
import {
  freeSavedFileName,
  freeSavedFolderName,
  makeInert,
  SAVED_COPIES_DIR,
  savedCopyMustMove,
} from './saved-copies.js';

/** Folders never walked: dependencies and git's own. */
const NOT_WALKED = new Set(['node_modules', '.git']);

/** What one root's pass did. */
export interface RootMigration {
  /** Saved folders and `bin/` files moved under `.dork/saved`. */
  moved: number;
  /** Why nothing was done, when nothing was. */
  skipped?: 'no-record' | 'already-done';
}

/** What one pass over many roots changed. */
export interface SavedCopiesMigration {
  /** Entries moved under `.dork/saved`. */
  moved: number;
  /** Roots migrated on this pass. */
  migrated: number;
  /** Install roots that could not be checked; retried next boot. */
  failed: number;
}

/**
 * Hooks around one root's pass, for consent that must follow it: `before`
 * runs first under the lock and its answer is handed to `after`.
 */
export interface MigrationHooks<T> {
  /** Read what must be carried over, before anything moves. */
  before(root: string): Promise<T>;
  /** Carry it over, after the root was migrated. */
  after(root: string, carried: T): Promise<void>;
}

/** Join a root and a POSIX path. */
function fsPath(root: string, posixPath: string): string {
  return path.join(root, ...posixPath.split('/'));
}

/** Whether `p` is `prefix` or under it. */
function isAtOrUnder(p: string, prefix: string): boolean {
  return p === prefix || p.startsWith(`${prefix}/`);
}

/** Whether every segment of `rel` under `root` is a real folder, not a link. */
async function isRealDir(root: string, rel: string): Promise<boolean> {
  const segments = rel.split('/');
  for (let i = 1; i <= segments.length; i++) {
    const stats = await lstat(fsPath(root, segments.slice(0, i).join('/'))).catch(() => undefined);
    if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) return false;
  }
  return true;
}

/** `X` for a kept-copy name `X.dork-old[.n]` / `X.dork-new[.n]`. */
function originalName(name: string): string {
  return name.replace(KEPT_COPY_BASENAME, '');
}

/** Whether the record lists `p` or anything under it. */
function recorded(record: InstalledFiles, p: string): boolean {
  return Object.keys(record.files).some((f) => isAtOrUnder(f, p));
}

/**
 * Migrate one install root whose record lacks the mark. See the module doc
 * for the rules.
 *
 * @param root - An install root.
 * @param record - Its record, read under the root's install lock.
 * @returns What moved.
 */
async function migrateRoot(root: string, record: InstalledFiles): Promise<RootMigration> {
  const locations = [
    ...new Set([...Object.values(EFFECT_BEARING_PATHS), ...(await declaredLocationsOf(root))]),
  ].filter((l) => !isAtOrUnder(l, SAVED_COPIES_DIR));
  const toMove: { from: string; isDir: boolean }[] = [];
  const walked = new Set<string>();
  const walk = async (rel: string): Promise<void> => {
    if (walked.has(rel)) return;
    walked.add(rel);
    let entries;
    try {
      entries = await readdir(fsPath(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) continue;
      const kept = KEPT_COPY_BASENAME.test(entry.name);
      if (entry.isDirectory()) {
        if (NOT_WALKED.has(entry.name)) continue;
        if (kept) {
          // Only the package's own folder, saved aside by an update, moves.
          if (recorded(record, `${rel}/${originalName(entry.name)}`)) {
            toMove.push({ from: child, isDir: true });
          }
          continue;
        }
        await walk(child);
      } else if (entry.isFile() && kept) {
        // A saved program leaves bin/ only when it was the package's.
        const packages = recorded(record, `${rel}/${originalName(entry.name)}`);
        if (savedCopyMustMove(child, false) && packages) toMove.push({ from: child, isDir: false });
        else await makeInert(fsPath(root, child));
      }
    }
  };
  for (const location of locations) {
    if (await isRealDir(root, location)) await walk(location);
  }

  let unproven = record.unproven ? { ...record.unproven.files } : undefined;
  for (const { from, isDir } of toMove) {
    const to = isDir ? await freeSavedFolderName(root, from) : await freeSavedFileName(root, from);
    await mkdir(path.dirname(fsPath(root, to)), { recursive: true });
    await rename(fsPath(root, from), fsPath(root, to));
    await makeInert(fsPath(root, to));
    if (unproven) {
      // The kept-file list (DOR-2322) names where each file sits now.
      const next: Record<string, string> = {};
      for (const [at, was] of Object.entries(unproven)) {
        next[isAtOrUnder(at, from) ? `${to}${at.slice(from.length)}` : at] = was;
      }
      unproven = next;
    }
  }
  await writeInstalledFiles(root, {
    ...record,
    ...(unproven && record.unproven && { unproven: { ...record.unproven, files: unproven } }),
    savedCopies: 1,
  });
  return { moved: toMove.length };
}

/**
 * Run {@link migrateRoot} over every install root, each under `lock`, with
 * `hooks` around each root that is actually migrated. Best-effort: a root that
 * fails is logged, counted and retried next boot.
 *
 * @param roots - Install roots (the installed list's `installPath`s).
 * @param lock - Runs a step under the root's install lock.
 * @param logger - Where moves and failures are reported.
 * @param hooks - Consent to carry across a root's pass.
 */
export async function migrateSavedCopies<T>(
  roots: readonly string[],
  lock: <R>(root: string, fn: () => Promise<R>) => Promise<R>,
  logger: Pick<Logger, 'info' | 'warn'>,
  hooks?: MigrationHooks<T>
): Promise<SavedCopiesMigration> {
  const result: SavedCopiesMigration = { moved: 0, migrated: 0, failed: 0 };
  for (const root of new Set(roots)) {
    if ((await lstat(root).catch(() => undefined))?.isDirectory() !== true) continue;
    try {
      const done = await lock(root, async () => {
        const record = await readInstalledFiles(root);
        if (record === null) return { moved: 0, skipped: 'no-record' } as RootMigration;
        if (record.savedCopies === 1) return { moved: 0, skipped: 'already-done' } as RootMigration;
        const carried = hooks ? await hooks.before(root) : undefined;
        const migration = await migrateRoot(root, record);
        if (hooks) await hooks.after(root, carried as T);
        return migration;
      });
      if (done.skipped !== undefined) continue;
      result.migrated++;
      result.moved += done.moved;
      if (done.moved > 0) {
        logger.info(
          `[marketplace/saved-copies] moved ${done.moved} saved cop${done.moved === 1 ? 'y' : 'ies'} in ${root} under ${SAVED_COPIES_DIR}, where nothing runs or loads them`
        );
      }
    } catch (err) {
      result.failed++;
      logger.warn(
        `[marketplace/saved-copies] could not check the saved copies in ${root}: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return result;
}
