/**
 * File-scoped transaction engine for marketplace package installs.
 *
 * Provides {@link runTransaction}: a generic stage then activate then cleanup or
 * rollback wrapper used by every install flow. The transactional guarantee is
 * entirely filesystem-scoped and git-free: `stage` builds the package contents
 * in an isolated temp directory, and `activate` performs the single mutating
 * operation (typically an atomic rename onto the install target). If the
 * target already exists it is moved aside to a sibling backup before `activate`
 * runs, so a failed activation restores the previous installation byte-for-byte.
 *
 * On success the backup (if any) and the staging directory are removed. On a
 * `stage` failure the target is never touched (no backup was taken yet). On an
 * `activate` failure any partial target is removed and the backup is restored
 * before the original error is re-raised. Every cleanup and restore step is
 * wrapped defensively so a cleanup error never masks the original transaction
 * error. Cleanup errors on the success path are logged but never fail the
 * transaction (the install already succeeded, so a leftover temp dir or backup is
 * a janitorial concern, not a correctness one).
 *
 * This design supersedes the git backup-branch rollback of ADR-0231: it is
 * scoped to the actual install location (not `process.cwd()`), it restores
 * gitignored files under `.dork/` that a `git reset` cannot touch, and it has
 * no destructive `git reset --hard`. See ADR-0304.
 *
 * @module services/marketplace/transaction
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MARKETPLACE_BACKUP_DIR_MARKER } from '@dorkos/shared/marketplace-schemas';
import { atomicMove } from './lib/atomic-move.js';

/** Staging directory prefix passed to `mkdtemp`. */
const STAGING_DIR_PREFIX = 'dorkos-install-';

/**
 * Suffix marker used when moving an existing target aside for backup, e.g.
 * `<target>.dorkos-bak-<timestamp>-<uuid>`. Re-exported so
 * `./backup-janitor.ts` derives the sweep pattern from this single source of
 * truth instead of duplicating the literal.
 */
export const BACKUP_SUFFIX = MARKETPLACE_BACKUP_DIR_MARKER;

/**
 * Options for {@link runTransaction}. The `stage` callback prepares the
 * package contents in an isolated temp directory; `activate` performs the
 * single mutating operation (typically an atomic rename onto `target`). The
 * transaction guarantees `stage` runs before `activate`, that the previous
 * contents of `target` are restored if `activate` throws, and that the staging
 * directory is cleaned up afterward, on success or failure.
 */
export interface TransactionOptions<T> {
  /**
   * Human-readable transaction name. Used as the staging directory suffix
   * (`dorkos-install-${name}-XXXXXX`).
   */
  name: string;
  /**
   * Absolute path to the install target that `activate` writes onto (e.g.
   * `<projectPath>/.dork/plugins/<name>` or `<dorkHome>/plugins/<name>`). When
   * this path already exists it is moved aside to a sibling backup before
   * `activate` runs, so a failed activation restores it byte-for-byte.
   */
  target: string;
  /** Prepare package contents in the supplied staging directory. */
  stage: (staging: { path: string }) => Promise<void>;
  /** Perform the activation step (e.g. atomic rename onto `target`). */
  activate: (staging: { path: string }) => Promise<T>;
}

/**
 * Run a file-scoped marketplace install transaction.
 *
 * Lifecycle: create temp staging dir → `stage` → (if `target` exists, move it
 * aside to a sibling backup) → `activate` → cleanup. On a `stage` error the
 * staging dir is removed and `target` is left untouched. On an `activate`
 * error any partially-written `target` is removed, the backup (if one was
 * taken) is restored onto `target`, and the staging dir is removed before the
 * original error is re-raised.
 *
 * @param opts - Transaction options ({@link TransactionOptions})
 * @returns The result returned from `activate`.
 */
export async function runTransaction<T>(opts: TransactionOptions<T>): Promise<T> {
  const stagingDir = await mkdtemp(path.join(tmpdir(), `${STAGING_DIR_PREFIX}${opts.name}-`));

  // Phase 1: stage. No backup is taken yet, so a stage failure leaves the
  // target untouched and only the staging dir needs cleaning up.
  try {
    await opts.stage({ path: stagingDir });
  } catch (err) {
    await runStageFailureCleanup(stagingDir);
    throw err;
  }

  // Phase 2: move any existing target aside so a failed activation can restore
  // it. `undefined` means the target did not exist (a fresh install).
  const backupPath = await _internal.moveTargetAside(opts.target);

  // Phase 3: activate. On failure, remove the partial target and restore the
  // backup before re-raising the original error.
  try {
    const result = await opts.activate({ path: stagingDir });
    await runSuccessCleanup(stagingDir, backupPath);
    return result;
  } catch (err) {
    await runActivateFailureRollback(stagingDir, opts.target, backupPath);
    throw err;
  }
}

/**
 * Move an existing `target` aside to a uniquely-named sibling backup so a
 * failed activation can restore it. Returns the backup path, or `undefined`
 * when `target` did not exist (a fresh install needs no backup).
 *
 * The backup is a sibling (`<target>.dorkos-bak-<timestamp>-<uuid>`) so it lands
 * on the same filesystem as `target`, keeping both the move-aside and the
 * restore a cheap atomic rename. {@link atomicMove} still guards the
 * cross-device case. The random UUID suffix guarantees a fresh path even under
 * pathological same-millisecond timing, so the move never overwrites a stale
 * backup left behind by a crashed prior install.
 *
 * @internal
 */
async function moveTargetAside(target: string): Promise<string | undefined> {
  if (!(await pathExists(target))) return undefined;
  const backupPath = `${target}${BACKUP_SUFFIX}${Date.now()}-${randomUUID()}`;
  await atomicMove(target, backupPath);
  return backupPath;
}

/**
 * Clean up after a successful activation. Removes the target backup (if one was
 * taken) and the staging directory: the install landed, so the previous
 * contents are no longer needed. Both steps are best-effort: errors are logged
 * but never thrown, because the install already completed.
 *
 * @internal
 */
async function runSuccessCleanup(
  stagingDir: string,
  backupPath: string | undefined
): Promise<void> {
  if (backupPath) {
    try {
      await _internal.removePath(backupPath);
    } catch (err) {
      console.warn(
        `[marketplace/transaction] failed to remove target backup ${backupPath}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }
  try {
    await _internal.cleanupStaging(stagingDir);
  } catch (err) {
    console.warn(
      `[marketplace/transaction] failed to remove staging dir ${stagingDir}: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
  }
}

/**
 * Remove the staging directory after a `stage` failure. No backup was taken
 * yet, so the target is untouched. Wrapped defensively so a cleanup error
 * never masks the original stage error.
 *
 * @internal
 */
async function runStageFailureCleanup(stagingDir: string): Promise<void> {
  try {
    await _internal.cleanupStaging(stagingDir);
  } catch (cleanupErr) {
    console.warn(
      `[marketplace/transaction] cleanup failed after stage error: ${
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      }`
    );
  }
}

/**
 * Restore the target on an `activate` failure. Removes any partially-written
 * target, restores the backup onto it (when one was taken), and removes the
 * staging directory. Each step is wrapped defensively so a cleanup or restore
 * error never masks the original activate error.
 *
 * @internal
 */
async function runActivateFailureRollback(
  stagingDir: string,
  target: string,
  backupPath: string | undefined
): Promise<void> {
  // Only restore the backup when the target was actually moved aside. A fresh
  // install (no backup) just needs the partial target removed.
  if (backupPath) {
    try {
      // `activate` may have partially written the target before throwing; clear
      // it so the restore rename has a clean destination.
      await _internal.removePath(target);
    } catch (removeErr) {
      console.warn(
        `[marketplace/transaction] failed to remove partial target ${target} before restore: ${
          removeErr instanceof Error ? removeErr.message : String(removeErr)
        }`
      );
    }
    try {
      await atomicMove(backupPath, target);
    } catch (restoreErr) {
      console.warn(
        `[marketplace/transaction] failed to restore target backup ${backupPath} to ${target}: ${
          restoreErr instanceof Error ? restoreErr.message : String(restoreErr)
        }`
      );
    }
  } else {
    // Fresh install: remove whatever `activate` managed to write.
    try {
      await _internal.removePath(target);
    } catch (removeErr) {
      console.warn(
        `[marketplace/transaction] failed to remove partial target ${target}: ${
          removeErr instanceof Error ? removeErr.message : String(removeErr)
        }`
      );
    }
  }

  try {
    await _internal.cleanupStaging(stagingDir);
  } catch (cleanupErr) {
    console.warn(
      `[marketplace/transaction] cleanup failed during rollback: ${
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      }`
    );
  }
}

/**
 * Remove the staging directory recursively. Extracted as a helper so tests can
 * spy on cleanup failures without monkey-patching `node:fs`.
 *
 * @internal
 */
async function cleanupStaging(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}

/**
 * Remove an arbitrary path (file or directory) recursively. Used to clear a
 * partially-written target and to reap a target backup on success. Extracted
 * as a helper so tests can spy on it.
 *
 * @internal
 */
async function removePath(target: string): Promise<void> {
  await rm(target, { recursive: true, force: true });
}

/**
 * Returns true when `target` exists on disk (file or directory).
 *
 * @internal
 */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * @internal Test-only export. The supported transactional API is
 * {@link runTransaction}; these helpers are exposed only so tests can stub
 * filesystem interactions with `vi.spyOn` (e.g. to simulate a cleanup or
 * restore failure without corrupting the runner's temp dir).
 */
export const _internal = {
  moveTargetAside,
  cleanupStaging,
  removePath,
};
