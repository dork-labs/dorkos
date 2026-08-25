/**
 * Crash-safe, race-safe file writes: a unique temp file, an atomic rename, and
 * per-path serialisation around both.
 *
 * Writing to a temp file and renaming it into place is the right pattern — the
 * marketplace install engine does it deliberately (ADR-0304) — because
 * `rename(2)` is atomic on a single filesystem, so a reader never observes a
 * half-written file.
 *
 * Doing it with a *fixed* temp name is not, and the failure is worse than it
 * looks. When two writers target one destination via `dest + '.tmp'`:
 *
 * 1. A writes its bytes to `dest.tmp`
 * 2. B overwrites `dest.tmp` with B's bytes
 * 3. A renames `dest.tmp` → `dest` — **A has published B's data as its own**
 * 4. B renames `dest.tmp` → `dest` — the temp file is gone: `ENOENT`
 *
 * Step 4 is loud (a 500). Step 3 is silent: the write reports success and the
 * wrong bytes land. Measured on this codebase with two concurrent writers, step
 * 4 hit every trial and step 3 hit ~88% of them.
 *
 * Two defences are needed, and each covers what the other cannot:
 *
 * - **A unique temp name** ({@link writeFileAtomic} uses pid + UUID) means no
 *   writer can ever clobber or unlink another's temp file. This alone removes
 *   step 4 and the torn-write window.
 * - **Per-path serialisation** ({@link withFileLock}) means two writers are
 *   never mid-transaction against one destination. This is what removes step 3,
 *   and a unique temp name does *not* give it to you: it merely makes both
 *   writes succeed with the last rename winning. For a read-modify-write store
 *   that is still a lost update — two callers each add a key, one key survives.
 *
 * ## Why an in-process mutex, and not a lock file
 *
 * The lock is a promise chain in this process's memory. That is sufficient
 * here, and deliberately so:
 *
 * - **No shipping non-server process writes any file routed through this
 *   module.** That is the load-bearing claim, and it is narrower than "one
 *   process per `dorkHome`": the instance lock
 *   (`apps/server/src/lib/instance-lock.ts`) is advisory — its own ADR notes
 *   it does not stop anything else from writing under `~/.dork` — and real
 *   non-server writers exist there (the CLI migrates `config.json` and opens
 *   `dork.db`, the logger writes before the lock is even taken, the Obsidian
 *   plugin writes runtime caches in-process). None of those files come through
 *   here. Anyone routing a new file through this module owns checking that no
 *   second process writes it.
 * - **Two known cross-process edges, both accepted.** Local-scope extension
 *   data lives under `{cwd}/.dork/`, keyed to the project rather than to a
 *   `dorkHome` — two servers with different data directories opened on the
 *   same project can both write it. And an agent's `MEMORY.md` is a file the
 *   operator is invited to edit by hand, so an editor holding a stale copy is
 *   a second writer by design rather than by accident. Both degrade to
 *   last-writer-wins per the next bullet, never to corruption; what an operator
 *   can lose in the second case is one note saved during the seconds their
 *   editor held the file open.
 * - **A crashed holder cannot wedge the next run.** An in-memory lock dies with
 *   the process that held it, so there is no stale-lock reaper to get wrong —
 *   the failure mode that makes on-disk lock files subtle.
 * - **The residual risk is bounded, not silent corruption.** If a file routed
 *   through here is ever written by two processes, the unique temp name plus
 *   atomic rename still guarantee every reader sees a whole, valid file. What
 *   is lost is mutual exclusion, degrading to last-writer-wins — never a torn
 *   or crossed file.
 *
 * ## Deadlock and leak safety
 *
 * - **Non-reentrant, enforced.** Nesting {@link withFileLock} on the same path
 *   inside a held critical section would silently deadlock — the inner call
 *   would queue behind the outer one forever — so re-entry is detected via
 *   async-context tracking and throws immediately instead. The callback is
 *   handed the writer to use precisely so it never needs to re-enter. Nesting
 *   locks on two *different* paths is not detected: it is safe only in a
 *   consistent order, and nothing here needs it — treat it as forbidden by
 *   convention.
 * - **The lock is always released.** The chain advances on rejection as well as
 *   resolution, so a throwing critical section frees the path rather than
 *   wedging every later writer.
 * - **The map does not grow without bound.** A path's entry is deleted once its
 *   queue drains, so keying by path (per extension, per session) cannot leak.
 * - **Keying is lexical.** Paths are compared after `resolve()`, which does not
 *   follow symlinks or fold case — two aliases of one file would split the
 *   lock. Unreachable today: every caller derives its path from the single
 *   `dork-home.ts` string (or one `cwd`), so no aliased spellings exist. Keep
 *   it that way rather than leaning on the key normalising for you.
 *
 * ## Durability
 *
 * Neither the temp file nor its directory is fsynced. The guarantee is
 * process-crash safety: the rename either happened or it did not, and readers
 * always see a complete file. On power loss the rename may be lost and the
 * previous contents survive — old data, never torn data. This matches the
 * durability bar everywhere else in this repo; an opt-in fsync for the
 * credential file is a possible follow-up, not a present behaviour.
 *
 * @module shared/atomic-write
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

/**
 * Tail of the pending write queue for each destination path, keyed by resolved
 * absolute path. The stored promise never rejects, so one failed write cannot
 * poison the writers queued behind it.
 */
const pathLocks = new Map<string, Promise<void>>();

/**
 * Lock keys held by the current async context. Lets a nested
 * {@link withFileLock} on an already-held path throw immediately instead of
 * queueing behind its own caller and deadlocking silently.
 */
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();

/**
 * Number of paths currently holding or queueing a lock.
 *
 * @internal Exported so tests can prove the map drains rather than leaking an
 *   entry per path written.
 */
export function pendingLockCount(): number {
  return pathLocks.size;
}

/** Options shared by {@link writeFileAtomic} and the writer given to {@link withFileLock}. */
export interface AtomicWriteOptions {
  /**
   * Permission bits for the destination file. Applied when creating the temp
   * file and re-asserted after the rename, because a pre-existing file's
   * permissions survive `rename` and the temp file's creation mode is subject
   * to the process umask. Omit to accept the platform default.
   */
  mode?: number;
}

/**
 * Write `data` to `filePath` without holding the path lock.
 *
 * Safe to call concurrently — the temp name is unique per call — but offers no
 * mutual exclusion. Every public entry point in this module wraps it in the
 * path lock; it is separated only so {@link withFileLock} can expose a writer
 * that cannot self-deadlock.
 *
 * @param filePath - Absolute destination path. Parent directories are created.
 * @param data - File contents, written as UTF-8.
 * @param options - Optional permission bits.
 */
async function writeUnlocked(
  filePath: string,
  data: string,
  options?: AtomicWriteOptions
): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  // Unique per call and a sibling of the destination, so the rename stays on
  // one filesystem (and therefore atomic). The pid keeps it legible if a hard
  // crash ever leaves one behind; the UUID is what makes collision impossible.
  const tempPath = join(dir, `.${basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);

  try {
    await writeFile(tempPath, data, {
      encoding: 'utf-8',
      ...(options?.mode !== undefined ? { mode: options.mode } : {}),
    });
    await rename(tempPath, filePath);
    if (options?.mode !== undefined) await chmod(filePath, options.mode);
  } catch (err) {
    // Never leave a stray temp file behind on a failed write. The destination
    // is untouched either way: the rename either happened or it did not.
    await rm(tempPath, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Run `fn` with exclusive access to `filePath`, serialised against every other
 * caller of this module for the same path.
 *
 * Use this for read-modify-write updates, where the read must be inside the
 * critical section — {@link writeFileAtomic} alone would still lose updates,
 * because two callers can each read the old contents before either writes.
 *
 * `fn` receives the atomic writer for `filePath`; use it rather than calling
 * {@link writeFileAtomic}, which would wait on the lock `fn` already holds.
 *
 * @param filePath - Absolute path to serialise on.
 * @param fn - Critical section. Receives the atomic writer for `filePath`.
 * @returns Whatever `fn` returns.
 * @throws Immediately when called for a path the current async context already
 *   holds — re-entry would queue behind its own caller and deadlock silently.
 */
export function withFileLock<T>(
  filePath: string,
  fn: (write: (data: string, options?: AtomicWriteOptions) => Promise<void>) => Promise<T>
): Promise<T> {
  const key = resolve(filePath);

  const alreadyHeld = heldLocks.getStore();
  if (alreadyHeld?.has(key)) {
    throw new Error(
      `Re-entrant withFileLock on '${key}': this async context already holds the lock, ` +
        'so waiting for it would deadlock. Use the writer your critical section was given.'
    );
  }

  const previous = pathLocks.get(key) ?? Promise.resolve();

  const write = (data: string, options?: AtomicWriteOptions): Promise<void> =>
    writeUnlocked(filePath, data, options);

  // Chain onto the previous holder regardless of how it settled, so a failed
  // write releases the path instead of wedging everyone queued behind it. The
  // critical section runs inside an async context that records the held key,
  // which is what lets the re-entry guard above fire.
  const result = previous.then(() =>
    heldLocks.run(new Set(alreadyHeld ?? []).add(key), () => fn(write))
  );

  // The stored tail must never reject, or the next waiter's `.then` would
  // inherit an unhandled rejection.
  const tail = result.then(
    () => {},
    () => {}
  );
  pathLocks.set(key, tail);

  return result.finally(() => {
    // Only the last writer in the queue clears the entry; if someone chained on
    // behind us the map already holds their tail, and dropping it would let a
    // third writer bypass the queue entirely.
    if (pathLocks.get(key) === tail) pathLocks.delete(key);
  });
}

/**
 * Write `data` to `filePath` atomically, serialised against concurrent writers
 * of the same path.
 *
 * The whole-file counterpart to {@link withFileLock}: use it when the new
 * contents do not depend on the current contents. Parent directories are
 * created. A reader either sees the previous file or this one, never a mix.
 *
 * @param filePath - Absolute destination path.
 * @param data - File contents, written as UTF-8.
 * @param options - Optional permission bits.
 */
export function writeFileAtomic(
  filePath: string,
  data: string,
  options?: AtomicWriteOptions
): Promise<void> {
  return withFileLock(filePath, (write) => write(data, options));
}
