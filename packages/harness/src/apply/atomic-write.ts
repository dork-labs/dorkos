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
 * The target's permission bits are carried onto the replacement, so a person who
 * has chmodded their own `.claude/settings.local.json` still has it afterwards.
 *
 * ## The temp file
 *
 * `.<name>.<pid>.<random>.dorkos-tmp`, beside the target because rename cannot
 * cross a filesystem. It is removed on any failure. Only a hard kill between the
 * write and the rename can leave one behind, and a leftover is inert: the
 * command-wrapper sweeps recognise it as engine output by its marker and remove
 * it on the next sync, and nothing reads the hook directories by wildcard.
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
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
