/**
 * File-scoped transaction engine for marketplace package installs.
 *
 * Provides {@link runTransaction}: a generic stage then activate then commit or
 * rollback wrapper used by every install flow. The transactional guarantee is
 * entirely filesystem-scoped and git-free: `stage` builds the package contents
 * in an isolated temp directory, and `activate` performs the mutating
 * operation (typically an atomic rename onto the install target). Before
 * `activate` runs the transaction writes a record beside the target — the
 * existing target moved aside as a backup, or a marker saying there was none —
 * and commits by renaming or removing that record once `activate` returns
 * (`./install-recovery.ts` has the record grammar).
 *
 * On a `stage` failure the target is never touched (no record was written
 * yet). On an `activate` failure the record is rolled back — the partial
 * target removed and the backup, if any, put back — before the original error
 * is re-raised; a rollback error is logged, never allowed to mask it. On
 * success the committed backup and the staging directory are removed, and a
 * failure there is logged but never fails the install.
 *
 * ## Why a crash cannot lose the previous install (DOR-2273)
 *
 * A crash can land between any two of those steps, and cleanup code does not
 * run after a crash. So recovery reads the record instead: every transaction
 * first settles whatever an earlier, interrupted transaction left beside its
 * target, and the server does the same for every global install root at
 * startup and every registered project once Mesh is up
 * (`./backup-janitor.ts`). An uncommitted record is rolled back, a committed
 * one deleted — so a backup is only ever deleted once the install that
 * replaced it finished.
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
 * An operation built OUT of those primitives holds the target across all of
 * them, because the gap between two separately-locked halves is a window like
 * any other. `MarketplaceInstaller.update()` is the one that exists — an
 * uninstall, a by-hand removal of the data-only install root, then a fresh
 * install — and it takes {@link withInstallTargetLock} once around the lot
 * (DOR-1722). The lock is re-entrant within one async context so the halves
 * can keep taking it for themselves; see the note on that function.
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
 * The transaction records narrow it (DOR-2273). Each names the process that
 * wrote it, so a transaction that finds another live process's record beside
 * its target refuses to start instead of moving that process's half-activated
 * target aside, and crash recovery never undoes a record whose writer is
 * still running. The check runs twice — before staging and again right
 * before the record is written, because staging includes an `npm install`
 * that can take minutes, time enough for the other server to write a record
 * of its own. What is left is the gap between that second check and the
 * rename that writes this transaction's record: two servers would have to
 * both check the same project's same package within that gap.
 *
 * ## The update window belongs to DOR-2245
 *
 * `MarketplaceInstaller.update()` is an uninstall, a removal of the data-only
 * install root, then an install. The uninstall stages the live install (and
 * the preserved `.dork/data/` and secrets) under the system temp directory,
 * where no record describes it, so a crash between the uninstall and this
 * transaction's commit still loses the package and leaves that data only in
 * the temp directory. Crash recovery here covers installs, not that window;
 * DOR-2245 replaces the temp-dir uninstall with an in-place one that writes a
 * journal recovery can finish.
 *
 * ## What a rollback does not undo
 *
 * Rolling back — after a failed `activate`, a failed commit, or a crash —
 * restores the target directory. It does not undo what `activate` did outside
 * it: a Mesh registration, the agent-created hook, an extension enabled. The
 * crash path matches the failure path here; the adapter flow keeps its own
 * compensation, and the Mesh reconciler drops a registration whose directory
 * went away.
 *
 * This design supersedes the git backup-branch rollback of ADR-0231: it is
 * scoped to the actual install location (not `process.cwd()`), it restores
 * gitignored files under `.dork/` that a `git reset` cannot touch, and it has
 * no destructive `git reset --hard`. See ADR-0304.
 *
 * @module services/marketplace/transaction
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { withFileLock } from '@dorkos/shared/atomic-write';
import {
  beginInstallRecord,
  commitInstallRecord,
  discardCommittedRecord,
  discardSupersededRecords,
  recoverInterruptedInstall,
  rollBackInstallRecord,
  settleableBy,
  type InstallRecord,
} from './install-recovery.js';

/** Staging directory prefix passed to `mkdtemp`. */
const STAGING_DIR_PREFIX = 'dorkos-install-';

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
   * `activate` runs, so a failed or interrupted activation restores it
   * byte-for-byte.
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
 * Install targets the current async context already holds, by canonical key.
 *
 * What makes {@link withInstallTargetLock} re-entrant: an inner call for a key
 * an OUTER call in the same context is already holding runs inline instead of
 * queueing behind its own caller. `withFileLock` throws in that situation
 * rather than deadlocking, which is the right default for a file writer but is
 * not what a composite operation needs — see the re-entrancy note on
 * {@link withInstallTargetLock}.
 *
 * @internal
 */
const heldInstallTargets = new AsyncLocalStorage<ReadonlySet<string>>();

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
 * of one directory are one lock.
 *
 * **Re-entrant for anything the holder's async context reaches (DOR-1722).** A
 * composite operation needs to hold a target across several primitives that
 * each take this lock for themselves: `MarketplaceInstaller.update()` is an
 * uninstall followed by an install, and until it held both halves under one
 * lock, an install landing between them was deleted by the by-hand removal
 * that sits in that gap. So an inner call whose key an outer call in the same
 * context already holds runs inline, and every nested taker of that target is
 * covered by the outer hold. That is exclusion-preserving for nested work: the
 * outer hold is what keeps other contexts out, and one async context cannot
 * race itself.
 *
 * The grant is carried by `AsyncLocalStorage`, so read it as "every
 * continuation the holder's context propagates to" and NOT as "the dynamic
 * extent of the hold" — the two differ, and only in one direction. A
 * continuation that escapes the critical section (a `setTimeout` scheduled
 * inside it, an unawaited promise) still carries the store after the lock is
 * released, and a take from there runs inline against a target this context no
 * longer holds. Note the failure direction: `withFileLock` has the same
 * property and an escape there THROWS its re-entry error, loudly; here the
 * same escape is silent, so it fails open. No marketplace caller schedules
 * work that outlives its critical section, and whoever writes one owns taking
 * the lock from a context that does not already hold it.
 *
 * Locks on two DIFFERENT targets may nest (an install materialises a package's
 * schedules through a transaction of its own, keyed on the skills directory
 * rather than on the install root). Nothing acquires those two in the opposite
 * order, so there is no cycle to deadlock on — but a new nesting is a new
 * ordering, and whoever adds one owns checking that.
 *
 * **Exclusion, not fairness.** Two callers that start in the same tick reach
 * the lock through {@link canonicalTargetKey}'s `realpath` walk, and those
 * calls settle in libuv threadpool order, so the one called first is not
 * reliably the one that acquires first. Nothing needs that ordering — two
 * concurrent installs of one package are two independent requests, and either
 * one landing last is correct — but a caller or a test that assumes it is
 * assuming a guarantee this does not make (measured at ~1 run in 5 flipped;
 * DOR-1725). To order two of these deterministically, start the second only
 * after the first has provably entered its critical section.
 *
 * @param target - Absolute path to the install target to serialise on.
 * @param fn - The critical section.
 * @returns Whatever `fn` returns.
 */
export async function withInstallTargetLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
  const key = await canonicalTargetKey(target);
  const held = heldInstallTargets.getStore();
  // Already ours: run inline. Queueing here would wait on this context's own
  // outer hold, which is the deadlock `withFileLock`'s re-entry guard exists to
  // turn into a throw.
  if (held?.has(key)) return fn();
  const nowHeld = new Set(held ?? []).add(key);
  // The writer `withFileLock` hands its callback is deliberately unused: this
  // caller serialises a directory-level rename dance, not a file write.
  return withFileLock(key, () => heldInstallTargets.run(nowHeld, fn));
}

/**
 * Run a file-scoped marketplace install transaction, serialised against every
 * other transaction aimed at the same `target`.
 *
 * Lifecycle: settle any interrupted earlier transaction on `target` → create
 * temp staging dir → `stage` → write the record (move an existing `target`
 * aside as a backup, or mark it absent) → `activate` → commit the record →
 * cleanup. On a `stage` error the staging dir is removed and `target` is left
 * untouched. On an `activate` or commit error the record is rolled back
 * (partial `target` removed, backup restored) and the staging dir is removed
 * before the original error is re-raised.
 *
 * The whole lifecycle — staging included — runs inside
 * {@link withInstallTargetLock}, so a second transaction against that
 * directory (or an uninstall of the same package) waits rather than
 * interleaving with this one's backup and rollback (DOR-711; see the module
 * header for the interleaving this prevents). Transactions against different
 * targets are unaffected and still run concurrently.
 *
 * Calling this from inside a critical section that already holds `target` is
 * allowed and runs inline ({@link withInstallTargetLock} is re-entrant within
 * one async context) — that is how `MarketplaceInstaller.update()` holds one
 * target across its uninstall and its install. It is not a way to nest two
 * transactions against one directory: the inner one would run with the outer
 * one's backup already taken, which is the interleaving the lock exists to
 * prevent, and no caller does it.
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
  // Phase 0: settle what an interrupted earlier transaction left beside the
  // target, so this one moves aside the last committed install and never a
  // half-written one (DOR-2273). Throws rather than stacking a second record
  // on top of one it could not roll back, or one another live process owns.
  await settleInterruptedInstall(opts.target);

  const stagingDir = await mkdtemp(path.join(tmpdir(), `${STAGING_DIR_PREFIX}${opts.name}-`));

  // Phase 1: stage. No record is written yet, so a stage failure leaves the
  // target untouched and only the staging dir needs cleaning up.
  try {
    await opts.stage({ path: stagingDir });
  } catch (err) {
    await runStageFailureCleanup(stagingDir);
    throw err;
  }

  // Phase 2: check again, then write the record — the existing target moved
  // aside, or a marker that there was none. Staging can take minutes (npm),
  // long enough for another server to have started on this target; moving
  // its half-activated target aside as our backup would destroy its install.
  // From the record on, a crash is rolled back.
  let record: InstallRecord;
  let superseded: InstallRecord[];
  try {
    superseded = (await settleInterruptedInstall(opts.target)).kept;
    record = await _internal.beginRecord(opts.target);
  } catch (err) {
    await runStageFailureCleanup(stagingDir);
    throw err;
  }

  // Phase 3: activate, then commit. A failure in either rolls the record back
  // before re-raising the original error.
  let result: T;
  let committed: InstallRecord | undefined;
  try {
    result = await opts.activate({ path: stagingDir });
    committed = await _internal.commitRecord(record);
  } catch (err) {
    await runRollback(stagingDir, opts.target, record);
    throw err;
  }
  await runSuccessCleanup(stagingDir, committed);
  await releaseSupersededRecords(superseded);
  return result;
}

/** What {@link settleInterruptedInstall} leaves for its caller. */
export interface SettledInstallTarget {
  /**
   * Records recovery could not safely settle and kept (a backup from before
   * commit records existed, beside a target that exists). Pass them to
   * {@link releaseSupersededRecords} once the caller's own change to the
   * target has finished.
   */
  kept: InstallRecord[];
}

/**
 * Settle whatever an interrupted install left beside `target`, before a new
 * change to it starts (DOR-2273): an uncommitted install is undone, and the
 * leftovers of a finished one deleted. Every install does this (twice: see
 * the module header), and so does uninstall, so neither acts on a
 * half-written package.
 *
 * The caller must hold `target`'s {@link withInstallTargetLock}, so nothing in
 * this process is still writing the records it reads.
 *
 * @param target - Absolute path of the install target.
 * @returns The records recovery kept, for the caller to release once its
 *   change finishes.
 * @throws When an interrupted install cannot be undone, or when another
 *   running DorkOS app may be mid-install on `target`; nothing was changed.
 */
export async function settleInterruptedInstall(target: string): Promise<SettledInstallTarget> {
  let report;
  try {
    report = await recoverInterruptedInstall(target);
  } catch (err) {
    throw new Error(
      `An earlier install at ${target} was interrupted and could not be undone, so nothing was changed: ${errMessage(err)}`,
      { cause: err }
    );
  }
  if (report.inFlight.length > 0) {
    const now = Date.now();
    const minutes = Math.max(1, Math.ceil((settleableBy(report.inFlight, now) - now) / 60_000));
    throw new Error(
      `Another DorkOS app may be changing ${target} right now, so nothing was changed. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
    );
  }
  for (const { record, outcome } of report.settled) {
    console.warn(
      `[marketplace/transaction] settled an interrupted install at ${target} (${record.kind} record ${record.path}: ${outcome})`
    );
  }
  for (const record of report.kept) {
    console.warn(
      `[marketplace/transaction] kept ${record.path} beside ${target}: it predates commit records, so nothing proves which copy is whole`
    );
  }
  for (const { record, error } of report.discardFailures) {
    console.warn(
      `[marketplace/transaction] failed to remove finished install leftovers ${record.path}: ${errMessage(error)}`
    );
  }
  return { kept: report.kept };
}

/**
 * Delete the records {@link settleInterruptedInstall} kept, now that the
 * caller's own change to the target has finished and superseded them.
 * Best-effort: a failure is logged, and the record stays kept.
 *
 * @param kept - {@link SettledInstallTarget.kept} from the settle that ran first.
 */
export async function releaseSupersededRecords(kept: readonly InstallRecord[]): Promise<void> {
  for (const { record, error } of await discardSupersededRecords(kept)) {
    console.warn(
      `[marketplace/transaction] failed to remove superseded install record ${record.path}: ${errMessage(error)}`
    );
  }
}

/**
 * Clean up after a committed install: delete the superseded backup (if one
 * was taken) and the staging directory. Both are best-effort — the install is
 * already committed, and a leftover backup is settled by the next recovery.
 *
 * @internal
 */
async function runSuccessCleanup(
  stagingDir: string,
  committed: InstallRecord | undefined
): Promise<void> {
  if (committed) {
    try {
      await discardCommittedRecord(committed);
    } catch (err) {
      console.warn(
        `[marketplace/transaction] failed to remove target backup ${committed.path}: ${errMessage(err)}`
      );
    }
  }
  try {
    await _internal.cleanupStaging(stagingDir);
  } catch (err) {
    console.warn(
      `[marketplace/transaction] failed to remove staging dir ${stagingDir}: ${errMessage(err)}`
    );
  }
}

/**
 * Remove the staging directory after a failure before activation. No record
 * is on disk, so the target is untouched. Wrapped defensively so a cleanup
 * error never masks the original error.
 *
 * @internal
 */
async function runStageFailureCleanup(stagingDir: string): Promise<void> {
  try {
    await _internal.cleanupStaging(stagingDir);
  } catch (cleanupErr) {
    console.warn(
      `[marketplace/transaction] cleanup failed after stage error: ${errMessage(cleanupErr)}`
    );
  }
}

/**
 * Undo an uncommitted transaction after `activate` or the commit failed: roll
 * the record back (the same rollback crash recovery runs) and remove the
 * staging directory. A rollback failure is logged, never thrown, so it cannot
 * mask the original error — and it leaves the record on disk, so the next
 * recovery of this target finishes the job instead of losing the backup.
 *
 * @internal
 */
async function runRollback(
  stagingDir: string,
  target: string,
  record: InstallRecord
): Promise<void> {
  try {
    await rollBackInstallRecord(target, record);
  } catch (rollbackErr) {
    console.warn(
      `[marketplace/transaction] failed to roll back ${target} from ${record.path}; the next install or restart will retry: ${errMessage(rollbackErr)}`
    );
  }
  try {
    await _internal.cleanupStaging(stagingDir);
  } catch (cleanupErr) {
    console.warn(
      `[marketplace/transaction] cleanup failed during rollback: ${errMessage(cleanupErr)}`
    );
  }
}

/**
 * Render an unknown caught value as a log-friendly message.
 *
 * @internal
 */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
 * @internal Test-only export. The supported transactional API is
 * {@link runTransaction}; these helpers are exposed only so tests can stub
 * steps with `vi.spyOn` (e.g. to stop a transaction at a crash point, or to
 * simulate a cleanup failure without corrupting the runner's temp dir).
 */
export const _internal = {
  beginRecord: beginInstallRecord,
  commitRecord: commitInstallRecord,
  cleanupStaging,
};
