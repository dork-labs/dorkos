/**
 * Every file the engine writes lands in one step, or not at all.
 *
 * ## The window a plain write leaves open
 *
 * The files this engine generates are read by other programs on their own
 * schedule: Codex loads `.codex/hooks.json` when a session starts, Claude Code
 * re-reads `.claude/settings.local.json` when it changes, and a person's editor
 * watches both. `writeFileSync` opens the target with `O_TRUNC`, so between the
 * truncate and the last byte the file on disk is EMPTY or HALF THERE — a config
 * file that is neither the old one nor the new one. A reader that looks in that
 * window sees a broken file and reports it as one.
 *
 * The window is microseconds, and the readers are many. Two DorkOS servers can
 * project into one repo at once (the dev server on :6242 and the built app on
 * :4242 do exactly that on the maintainer's machine); `dorkos harness sync
 * --fix` runs in a terminal beside the running app; an agent's session starts
 * whenever the person presses enter. Nothing serializes those, and nothing can
 * without a lock file this engine has deliberately not taken (see
 * `services/harness/project-with-consent.ts`).
 *
 * Writing to a sibling temp file and renaming it over the target closes the
 * window instead of narrowing it. `rename(2)` is atomic on POSIX and, within one
 * volume, on NTFS: every reader sees either all the old bytes or all the new
 * ones, never a splice and never an empty file. That is the property AP-10
 * needs, and it is the whole of what this module does.
 *
 * ## Deliberately not done
 *
 * - **No `fsync`.** Atomicity here is about what a concurrent READER can
 *   observe, which rename gives on its own. Durability across a power cut is a
 *   different property, it costs a disk flush on every generated file of every
 *   sync, and a projection lost to a crash is rebuilt by the next sync from
 *   sources that were never in memory. If a crash story is ever needed, it goes
 *   here rather than at the call sites.
 * - **No lock.** Two processes writing the same target still race; what they
 *   cannot do any more is leave a reader holding half a file. The end state is
 *   whichever writer renamed last, which is the same bytes either way when both
 *   apply the same plan (the engine's output is deterministic).
 * - **A bounded Windows sharing retry.** The first real Windows concurrency run
 *   found NTFS returning `EPERM` when a reader held the destination during the
 *   rename. {@link renameOverExisting} retries only that measured combination:
 *   Windows, `rename`, and `EPERM`. It never unlinks the destination, never
 *   retries another failure, and gives the original error back after a finite
 *   1,024 ms window.
 *
 * ## The cost of rename: a path-watcher stops seeing the file
 *
 * A rename swaps the directory entry, so the inode a watcher latched onto is no
 * longer the file at that path. Measured here on macOS: `fs.watch(<file>)`
 * reported **0 events across three atomic replaces**, while `fs.watch(<dir>)`
 * saw every one of them (3–4 events each); the same file rewritten with a plain
 * `writeFileSync` did fire the path-watcher. So the very readers this module
 * exists to protect — an editor, a harness re-reading
 * `.claude/settings.local.json` — get a whole file instead of half a file, and
 * in exchange a naive path-watcher may not notice it changed at all.
 *
 * That trade is worth taking: a missed notification is recoverable on the next
 * read, and half a config file is not. It is written down because it is
 * load-bearing for anything DorkOS builds that WATCHES these paths — the
 * `.agents/skills` watcher (DOR-1850) must watch DIRECTORIES, not files, or it
 * will go deaf the first time the engine rewrites what it is watching.
 *
 * ## Two things rename changes, and both are on purpose
 *
 * A rename replaces the DIRECTORY ENTRY, so a **dead symlink** at the target is
 * replaced rather than followed. That is what the apply stage's own call sites
 * already did by hand — an `rmSync` and a comment explaining that
 * `writeFileSync` would otherwise create the file wherever the dead link pointed
 * — and it is what the managed-hook merge should have been doing all along: a
 * plain write there followed the dead link, put the settings somewhere else
 * entirely, and left the path Claude Code reads as broken as it found it.
 *
 * A **live** symlink is still followed, by resolving the target first
 * ({@link writeTargetOf}), so a settings file somebody keeps in a dotfiles
 * checkout is written through as it always was — and the temp file lands beside
 * the REAL file, which is also what keeps the rename on one filesystem. That is
 * about this helper, not about the engine's policy: `applyGenerate` refuses a
 * live link at a generate target long before reaching here
 * (`generate-occupants.ts`), so the only writes that follow one are the two that
 * always did — the settings merge and an ownership sidecar.
 *
 * The target permissions the platform exposes are carried onto the replacement:
 * exact mode bits on POSIX and the writable bit Node exposes on Windows.
 *
 * ## The temp file, and who is allowed to touch it
 *
 * `.<name>.<pid>.<random>.dorkos-tmp`, beside the target because rename cannot
 * cross a filesystem. It is removed on any failure.
 *
 * **A live temp file belongs to whoever is writing it, and nothing else may
 * delete it.** That is not a nicety: two of the engine's own sweeps enumerate
 * the command directories by wildcard and remove any file carrying the
 * generated-command marker that the plan does not name — and a temp holds the
 * whole wrapper, marker included. Left unguarded, one process's sweep unlinks
 * another's in-flight write and that writer's `rename` dies with ENOENT in the
 * middle of `applyPlan`. Every scan that walks a directory the engine writes
 * into therefore asks {@link isAtomicTempName} first (`apply/apply.ts`), and
 * `__tests__/atomic-temp-sweep.test.ts` holds that line.
 *
 * ## The leftover story, decided rather than assumed
 *
 * Only a hard kill between the write and the rename can strand a temp file. The
 * rule is **age**, not ownership, because ownership cannot tell a stranded temp
 * from one a live writer created a microsecond ago:
 *
 * - A temp younger than {@link STALE_TEMP_AGE_MS} is somebody's in-flight write.
 *   Nothing removes it, ever.
 * - An older one is debris, and the orphan sweep takes it — but only in the two
 *   COMMAND directories, which are the only places anything enumerates by
 *   wildcard and so the only places debris can be mistaken for content.
 * - Everywhere else (`.codex/`, `.cursor/`, `.github/hooks/`, `.claude/`, the
 *   repo root) a leftover is inert: those paths are read by name, never scanned,
 *   so a stray dotfile beside them changes nothing. It is left alone rather than
 *   swept, because a sweep there would have to walk directories the engine has
 *   no other reason to walk.
 *
 * {@link STALE_TEMP_AGE_MS} is a **margin, not a guarantee**, and the difference
 * matters: a writer suspended mid-apply, a stalled network mount, or a share
 * whose server clock runs more than a minute behind can all leave a LIVE temp
 * looking older than the threshold — and then the sweep takes it, the writer's
 * rename fails with ENOENT out of `applyPlan`, and that plan is half applied
 * until the next sync completes it. That is the same failure the threshold
 * exists to prevent, pushed out to a case none of these paths have ever hit; the
 * honest fix if it ever does is a liveness signal rather than a bigger number.
 *
 * @module apply/atomic-write
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

/**
 * The suffix every temp file this module creates carries.
 *
 * Exported so a test can assert that a completed write leaves none behind, and
 * so anything that ever sweeps a projection directory can recognise one.
 */
export const ATOMIC_TMP_SUFFIX = '.dorkos-tmp';

/**
 * How old a temp file has to be before it counts as debris rather than as
 * somebody's write in progress.
 *
 * A minute is enormous next to the microseconds a real write takes and small
 * next to how long a stranded file would otherwise sit there. What it must not
 * be is zero: the whole point is that a live writer's temp is untouchable, and
 * any threshold short enough to race one is the bug this exists to prevent.
 */
export const STALE_TEMP_AGE_MS = 60_000;

/**
 * Delays between Windows retries when an atomic rename races an open reader.
 *
 * A real Windows reader can reopen the destination continuously rather than
 * holding it for one known interval. Sixty-four 16 ms scheduler windows give
 * the rename repeated chances to land while keeping the requested-delay budget
 * to 1,024 ms. Scheduler delays can make elapsed time longer. The sequence is
 * exported only so the boundary test can prove the loop stops; callers use
 * {@link writeFileAtomic}.
 *
 * @internal
 */
export const WINDOWS_RENAME_RETRY_DELAYS_MS = Object.freeze(Array.from({ length: 64 }, () => 16));

/** Block this synchronous filesystem operation for a bounded retry delay. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Rename a completed temp file over its target, with the measured Windows retry. */
function renameOverExisting(tmp: string, target: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmp, target);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const delay = WINDOWS_RENAME_RETRY_DELAYS_MS[attempt];
      if (process.platform !== 'win32' || code !== 'EPERM' || delay === undefined) throw error;
      sleepSync(delay);
    }
  }
}

/**
 * Whether a directory entry is one of this module's temp files.
 *
 * Every scan that walks a directory the engine writes into has to ask this
 * before deciding anything about the entry — a temp carries the whole content
 * of the file it is about to become, marker and all, so every ownership
 * predicate in the engine says "mine" about somebody else's in-flight write.
 *
 * @param name - The entry's base name.
 * @returns `true` when it is an atomic-write temp file.
 */
export function isAtomicTempName(name: string): boolean {
  return name.endsWith(ATOMIC_TMP_SUFFIX);
}

/**
 * Whether a temp file is old enough to be debris a crash left behind.
 *
 * @param absPath - Absolute path of the temp file.
 * @param now - The current time, injectable so a test need not sleep.
 * @returns `true` when it has sat there longer than {@link STALE_TEMP_AGE_MS};
 *   `false` for a fresh one, and for one that has already gone.
 */
export function isStaleAtomicTemp(absPath: string, now = Date.now()): boolean {
  try {
    return now - statSync(absPath).mtimeMs > STALE_TEMP_AGE_MS;
  } catch {
    return false; // gone, or unreadable: not ours to delete either way
  }
}

/**
 * Where the bytes actually belong: the target itself, or — when a LIVE symlink
 * occupies it — whatever that link resolves to.
 *
 * Resolving is what preserves the behaviour a plain `writeFileSync` had, which
 * followed such a link and wrote through it. A DEAD link resolves to nothing and
 * falls back to the path itself, so the rename replaces the link, which is what
 * the apply stage wants of a link pointing at a file that is not there.
 *
 * @param absPath - the absolute path the caller asked to write.
 * @returns the path to write and rename onto.
 */
function writeTargetOf(absPath: string): string {
  try {
    return realpathSync(absPath);
  } catch {
    return absPath; // absent, or a dead link: the entry itself is the target
  }
}

/** The permission bits already on a path, or `undefined` when nothing is there. */
function existingMode(absPath: string): number | undefined {
  try {
    return statSync(absPath).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Write a file so that no reader can ever observe it half-written.
 *
 * Creates the parent directory, writes the bytes to a sibling temp file, and
 * renames it over the target. A reader concurrent with this call sees either the
 * old file or the new one.
 *
 * @param absPath - absolute path of the file to write.
 * @param content - the exact bytes to write.
 * @throws Whatever the underlying write or rename throws, with the temp file
 *   already cleaned up — a directory at the target (EISDIR/ENOTEMPTY), a
 *   permission error, a full disk.
 */
export function writeFileAtomic(absPath: string, content: string): void {
  const target = writeTargetOf(absPath);
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  const tmp = join(
    dir,
    `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}${ATOMIC_TMP_SUFFIX}`
  );
  try {
    writeFileSync(tmp, content);
    const mode = existingMode(target);
    if (mode !== undefined) chmodSync(tmp, mode);
    renameOverExisting(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
