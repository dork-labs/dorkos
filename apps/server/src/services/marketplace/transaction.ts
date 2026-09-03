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
 * ## Why the whole transaction is serialised per target (DOR-711)
 *
 * Each step above is sound on its own, and together they were still not safe
 * for two transactions aimed at one directory. The backup a rollback restores
 * is a snapshot of whatever stood at the target when THIS transaction took it,
 * and the rollback puts it back without asking whether the target is still the
 * one it moved aside. Two installs of the same package interleaved like this:
 *
 * 1. A moves the existing target aside as A's backup
 * 2. B finds no target (A took it) and proceeds with no backup of its own
 * 3. B renames its staged content into place and **succeeds**
 * 4. A's `activate` fails; A's rollback removes the target — B's freshly
 *    installed content — and restores A's now-stale backup
 *
 * A failed install had destroyed a successful one, and both callers saw the
 * response they expected. So every transaction now runs inside
 * {@link withInstallTargetLock}: the move-aside, the activation and the
 * rollback are one critical section, and the interleave above cannot be
 * constructed. Serialisation is per target — two installs of different
 * packages still run concurrently. The uninstall flow, which runs the same
 * move-aside-and-restore dance through its own staging path, takes the same
 * lock, so an install and an uninstall of one package cannot interleave
 * either.
 *
 * ## The key is canonical, not the caller's spelling
 *
 * {@link withFileLock} keys on `path.resolve`, which normalises `..` and
 * relative segments but does NOT follow symlinks — and its own module header
 * says callers must not lean on the key normalising for them. A project-scope
 * install target is built by joining a caller-supplied `projectPath`, and one
 * directory reachable by two spellings (`/work/proj` and a symlink
 * `/work/current` pointing at it) is two lock keys and therefore no lock at
 * all: the full destruction above reproduces straight through it. So the key
 * is realpath-resolved here ({@link canonicalTargetKey}) before the lock is
 * taken, which makes it a property of the filesystem rather than of the
 * request body. The `POST /api/marketplace/packages/:name/install` route now
 * also passes the canonical `projectPath` that its boundary check already
 * resolved, so the two agree; this resolution is the belt to that braces, and
 * it covers every other caller — MCP tools, Shape fork, schedule
 * materialisation — without each having to remember.
 *
 * ## Residual: this is an in-process mutex
 *
 * The scope is deliberate and matches the deployment: marketplace installs run
 * in the server, and the CLI is a thin HTTP client into the same
 * `MarketplaceInstaller` instance (`contributing/marketplace-installs.md` §2),
 * so two concurrent installs are normally two requests in one process.
 *
 * One case is outside that and is a named residual rather than a covered one.
 * A project-scope install writes under `{projectPath}/.dork/`, which is keyed
 * to the project rather than to a `dorkHome` — two servers with different data
 * directories opened on the same project (the dogfood setup runs exactly two:
 * dev on :6242 and the built app on :4242) each hold their own lock map and
 * cannot see the other's. Note that the acceptance `atomic-write.ts` offers
 * for its own two cross-process edges does NOT transfer here: there, losing
 * mutual exclusion degrades to last-writer-wins over a whole file, never
 * corruption. Here it degrades to the destruction this module exists to
 * prevent — a failed install rolling back over a successful one. Closing it
 * needs an on-disk lock, which is a separate decision (stale-holder reaping is
 * the part that is easy to get wrong) and is not made here.
 *
 * This design supersedes the git backup-branch rollback of ADR-0231: it is
 * scoped to the actual install location (not `process.cwd()`), it restores
 * gitignored files under `.dork/` that a `git reset` cannot touch, and it has
 * no destructive `git reset --hard`. See ADR-0304.
 *
 * @module services/marketplace/transaction
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withFileLock } from '@dorkos/shared/atomic-write';
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
 * Resolve an install target to the lock key that identifies it uniquely.
 *
 * `path.resolve` alone is not enough: it normalises `..` but not symlinks, so
 * two spellings of one directory would take two different locks and serialise
 * against nothing (see the module header). The target itself usually does not
 * exist yet — a fresh install is a rename ONTO it — so this realpaths the
 * deepest ancestor that does exist and re-joins the missing tail, the same rule
 * `lib/boundary.ts` applies to a path it is validating.
 *
 * Best-effort by construction. An ancestor that cannot be read (EACCES, or a
 * platform that refuses `realpath` here) falls back to the resolved-but-not-
 * canonical path, which is exactly the key this used before and never worse.
 *
 * @param target - The transaction's install target, absolute or relative.
 * @returns The canonical absolute path to lock on.
 * @internal
 */
async function canonicalTargetKey(target: string): Promise<string> {
  const absolute = path.resolve(target);
  const missingTail: string[] = [];
  let current = absolute;

  for (;;) {
    try {
      const real = await realpath(current);
      return path.join(real, ...missingTail.reverse());
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return absolute;
      const parent = path.dirname(current);
      // `dirname` is a fixed point at the filesystem root; nothing above it
      // exists to resolve, so the resolved path is the best key available.
      if (parent === current) return absolute;
      missingTail.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Run `fn` with exclusive access to a marketplace install target, serialised
 * against every other holder of that same directory.
 *
 * This is the seam that makes the engine's move-aside-and-restore dance safe
 * under concurrency (DOR-711 — the module header has the interleaving it
 * prevents). {@link runTransaction} takes it for every install, and the
 * uninstall flow takes it for its own staging-and-restore path, so the two
 * cannot interleave against one package either.
 *
 * The key is realpath-resolved ({@link canonicalTargetKey}), so two spellings
 * of one directory are one lock. Non-reentrant: calling this for a target the
 * current async context already holds throws rather than deadlocking.
 *
 * @param target - Absolute path to the install target to serialise on.
 * @param fn - The critical section.
 * @returns Whatever `fn` returns.
 */
export async function withInstallTargetLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const key = await canonicalTargetKey(target);
  // The writer `withFileLock` hands its callback is deliberately unused: this
  // caller serialises a directory-level rename dance, not a file write.
  return withFileLock(key, fn);
}

/**
 * Run a file-scoped marketplace install transaction, serialised against every
 * other transaction aimed at the same `target`.
 *
 * Lifecycle: create temp staging dir → `stage` → (if `target` exists, move it
 * aside to a sibling backup) → `activate` → cleanup. On a `stage` error the
 * staging dir is removed and `target` is left untouched. On an `activate`
 * error any partially-written `target` is removed, the backup (if one was
 * taken) is restored onto `target`, and the staging dir is removed before the
 * original error is re-raised.
 *
 * The whole lifecycle — staging included — runs inside
 * {@link withInstallTargetLock}, so a second transaction against that
 * directory (or an uninstall of the same package) waits rather than
 * interleaving with this one's backup and rollback (DOR-711; see the module
 * header for the interleaving this prevents). Transactions against different
 * targets are unaffected and still run concurrently.
 *
 * Do not call this from inside another transaction on the same `target`: the
 * lock is deliberately non-reentrant and throws instead of deadlocking. No
 * caller nests today — the installer materialises a package's schedules after
 * its flow's transaction has settled, not inside it.
 *
 * @param opts - Transaction options ({@link TransactionOptions})
 * @returns The result returned from `activate`.
 */
export async function runTransaction<T>(opts: TransactionOptions<T>): Promise<T> {
  return withInstallTargetLock(opts.target, () => runTransactionUnlocked(opts));
}

/**
 * The transaction lifecycle itself, with no serialisation of its own.
 *
 * Split out from {@link runTransaction} purely so the public entry point is one
 * readable `withFileLock` call; nothing may call this directly, because the
 * lock is what makes the backup-and-restore dance safe under concurrency.
 *
 * @internal
 */
async function runTransactionUnlocked<T>(opts: TransactionOptions<T>): Promise<T> {
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
