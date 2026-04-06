/**
 * Atomic transaction engine for marketplace package installs.
 *
 * Provides {@link runTransaction} — a generic stage → activate → cleanup or
 * rollback wrapper used by every install/uninstall/update flow. Failures
 * during `stage` or `activate` always remove the staging directory; if a
 * git backup branch was created, the user's working tree is restored to
 * it. Cleanup errors on the success path are logged but never fail the
 * transaction (the install already succeeded — the leftover temp dir is a
 * janitorial concern, not a correctness one).
 *
 * @module services/marketplace/transaction
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Backup branch name prefix used for git rollback safety nets. */
const BACKUP_BRANCH_PREFIX = 'dorkos-rollback';

/** Staging directory prefix passed to `mkdtemp`. */
const STAGING_DIR_PREFIX = 'dorkos-install-';

/**
 * Options for {@link runTransaction}. The `stage` callback prepares the
 * package contents in an isolated temp directory; `activate` performs the
 * single mutating operation (typically an atomic rename onto the install
 * root). The transaction guarantees `stage` runs before `activate` and
 * that the staging directory is cleaned up afterward — on success or
 * failure.
 */
export interface TransactionOptions<T> {
  /**
   * Human-readable transaction name. Used as the staging directory suffix
   * (`dorkos-install-${name}-XXXXXX`) and the backup branch suffix.
   */
  name: string;
  /**
   * When true, attempt to create a git backup branch in `process.cwd()`
   * before staging. The branch is restored if `stage` or `activate`
   * throws. No-op when CWD is not a git repository.
   */
  rollbackBranch: boolean;
  /** Prepare package contents in the supplied staging directory. */
  stage: (staging: { path: string }) => Promise<void>;
  /** Perform the activation step (e.g. atomic rename onto install root). */
  activate: (staging: { path: string }) => Promise<T>;
}

/**
 * Run a marketplace install transaction.
 *
 * Lifecycle: create temp staging dir → optional git backup branch →
 * `stage` → `activate` → cleanup. On any thrown error from `stage` or
 * `activate`, the staging dir is removed and the backup branch (if any)
 * is restored before the original error is re-raised.
 *
 * @param opts - Transaction options ({@link TransactionOptions})
 * @returns The result returned from `activate`, augmented with the
 *   `rollbackBranch` name when one was created.
 */
export async function runTransaction<T>(
  opts: TransactionOptions<T>
): Promise<T & { rollbackBranch?: string }> {
  const stagingDir = await mkdtemp(path.join(tmpdir(), `${STAGING_DIR_PREFIX}${opts.name}-`));
  const backupBranch = opts.rollbackBranch ? await maybeCreateBackupBranch(opts.name) : undefined;

  try {
    await opts.stage({ path: stagingDir });
    const result = await opts.activate({ path: stagingDir });
    await runSuccessCleanup(stagingDir);
    return { ...result, rollbackBranch: backupBranch };
  } catch (err) {
    await runFailureRollback(stagingDir, backupBranch);
    throw err;
  }
}

/**
 * Create a backup branch only when CWD is a git repository.
 *
 * @internal
 */
async function maybeCreateBackupBranch(name: string): Promise<string | undefined> {
  const cwd = process.cwd();
  const inRepo = await _internal.isGitRepo(cwd);
  if (!inRepo) return undefined;
  return _internal.createBackupBranch(name);
}

/**
 * Remove the staging directory after a successful activation. Errors are
 * logged but never thrown — the install already completed.
 *
 * @internal
 */
async function runSuccessCleanup(stagingDir: string): Promise<void> {
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
 * Remove the staging directory and restore the backup branch on failure.
 * Each step is wrapped defensively so a cleanup error never masks the
 * original transaction error.
 *
 * @internal
 */
async function runFailureRollback(
  stagingDir: string,
  backupBranch: string | undefined
): Promise<void> {
  try {
    await _internal.cleanupStaging(stagingDir);
  } catch (cleanupErr) {
    console.warn(
      `[marketplace/transaction] cleanup failed during rollback: ${
        cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr)
      }`
    );
  }
  if (!backupBranch) return;
  try {
    await _internal.rollbackToBranch(backupBranch);
  } catch (rollbackErr) {
    console.warn(
      `[marketplace/transaction] rollback to ${backupBranch} failed: ${
        rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)
      }`
    );
  }
}

/**
 * Detect whether the supplied directory is inside a git working tree.
 *
 * Shells out to `git rev-parse --is-inside-work-tree` via `execFile`
 * (no shell, so no injection surface). Any non-zero exit, missing
 * binary, or unparseable output is treated as "not a git repo".
 *
 * @internal
 */
async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      timeout: 5_000,
    });
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * Create a uniquely-named backup branch in `process.cwd()` pointing at
 * the current HEAD. The branch is created with `git branch <name>` so
 * it does not check anything out — the working tree is unchanged.
 *
 * @internal
 */
async function createBackupBranch(name: string): Promise<string> {
  const branch = `${BACKUP_BRANCH_PREFIX}-${name}-${Date.now()}`;
  await execFileAsync('git', ['branch', branch], {
    cwd: process.cwd(),
    timeout: 5_000,
  });
  return branch;
}

/**
 * Restore the working tree to the supplied backup branch via
 * `git reset --hard <branch>`, then delete the temporary branch.
 *
 * @internal
 */
async function rollbackToBranch(branch: string): Promise<void> {
  const cwd = process.cwd();
  await execFileAsync('git', ['reset', '--hard', branch], { cwd, timeout: 10_000 });
  await execFileAsync('git', ['branch', '-D', branch], { cwd, timeout: 5_000 }).catch(() => {
    // Branch deletion is best-effort — the reset already succeeded.
  });
}

/**
 * Remove the staging directory recursively. Extracted as a helper so
 * tests can spy on cleanup failures without monkey-patching `node:fs`.
 *
 * @internal
 */
async function cleanupStaging(stagingDir: string): Promise<void> {
  await rm(stagingDir, { recursive: true, force: true });
}

/**
 * @internal Test-only export. The supported transactional API is
 * {@link runTransaction}; these helpers are exposed only so tests can
 * stub git interactions and cleanup behaviour with `vi.spyOn`.
 */
export const _internal = {
  isGitRepo,
  createBackupBranch,
  rollbackToBranch,
  cleanupStaging,
};
