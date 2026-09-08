/**
 * Symlink targets: what may occupy one, what a person is told when the engine
 * may not touch it, and how each platform decides whether the link on disk is
 * the link the plan asked for.
 *
 * This is the symlink twin of `generate-occupants.ts`, and it exists for the
 * same reason: `--check` and `--fix` must never disagree about a path neither of
 * them may touch. Until it did, a real file or directory at a skill link target
 * was `drifted` to `--check` ("run `--fix` to apply") and a reason-less conflict
 * to `--fix` — the person was told to run the command that had just refused, and
 * told nothing at all about what was in the way.
 *
 * Three shapes get their own sentence, because they are three different
 * situations and only one of them is anybody's mistake:
 *
 * - **A checkout with symlinks turned off.** Git stores a symlink as a blob
 *   holding its target path; a checkout that cannot make links writes that blob
 *   out as a plain FILE. That is the Git for Windows default without Developer
 *   Mode, and it is what a teammate's fresh clone looks like (J-10). Nothing is
 *   wrong with the repository, so the sentence says so and gives the two ways
 *   out.
 * - **A name that differs only in case.** On a case-insensitive volume (macOS
 *   and Windows by default) an existing `.claude/skills/Foo` occupies the path a
 *   planned `foo` link wants, and every probe agrees something is there while
 *   the person is looking at a directory they believe is called something else
 *   (AP-16). The engine does not try to be case-aware; it names the difference.
 * - **Anything else real.** Somebody's own file or directory, left exactly where
 *   it is.
 *
 * @module apply/symlink-occupants
 */
import { readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { occupantKind } from './link-state.js';

/**
 * What a person is told when git wrote the link's own text into a plain file —
 * a clone whose `core.symlinks` is off.
 *
 * It names both ways out, because they belong to different people: the teammate
 * on that checkout turns symlinks on, and anyone on a checkout that can make
 * links re-runs the fix.
 */
export const SYMLINKS_OFF_REASON =
  "blocked by a plain file holding this link's own text — symlinks are turned off in this " +
  'checkout, so git could not create the link. Turn them on with `git config core.symlinks ' +
  'true` and check the file out again, or run `dorkos harness sync --fix` in a checkout that ' +
  'can make links';

/** What a person is told when a real directory occupies a skill link target. */
export const SYMLINK_DIRECTORY_REASON =
  'blocked by a real directory — DorkOS puts a link at this path and never writes over what ' +
  'somebody else put there. Move or delete the directory, then re-run';

/** What a person is told when a real file occupies a skill link target. */
export const SYMLINK_FILE_REASON =
  'blocked by a real file — DorkOS puts a link at this path and never writes over what ' +
  'somebody else put there. Move or delete the file, then re-run';

/**
 * The largest file that could plausibly hold nothing but a path, in bytes.
 *
 * A symlink blob is one relative path and no newline, so anything bigger is
 * somebody's real file and is never read here — the classification must not turn
 * into "load whatever is at this path into memory".
 */
const MAX_LINK_TEXT_BYTES = 4096;

/** A path with every separator spelled `/`, so Windows and POSIX text compare. */
function withForwardSlashes(path: string): string {
  return path.split('\\').join('/');
}

/**
 * Whether the file at `absTarget` holds exactly the link text the plan wants.
 *
 * **Only a REGULAR file is ever opened here, and that guard is load-bearing.**
 * `occupantKind` answers `'file'` for anything real that is not a directory —
 * a FIFO and a unix socket included — and `readFileSync` on a FIFO with no
 * writer blocks in `open(2)` forever. Nothing in this process can interrupt a
 * synchronous block: not a vitest timeout, not a signal handler. So a named pipe
 * at `.claude/skills/<x>` would hang `dorkos harness sync --check` and `--fix`
 * outright — the command whose whole job is to TELL somebody what is wrong with
 * their tree. `statSync().isFile()` is what keeps that from being reachable; a
 * FIFO or a socket is the ordinary blocked conflict, and `--check` returns.
 *
 * Separators are normalized because the two sides come from different places: git
 * writes the blob with POSIX separators on every platform, while `relativeLink`
 * builds the text with `path.relative`, which spells it with backslashes on
 * Windows. Comparing them raw would answer "no" on the one platform this case is
 * about.
 *
 * The comparison accepts the exact text and nothing else, save one trailing
 * newline. Git writes a symlink blob with no newline at all, so the tolerance is
 * for an editor that added one; a general `trim()` would call
 * `"<link text>\n\n   my notes"`-shaped content a symlinks-off checkout, which
 * it is not.
 */
function holdsOwnLinkText(absTarget: string, linkText: string): boolean {
  try {
    const stats = statSync(absTarget);
    if (!stats.isFile() || stats.size > MAX_LINK_TEXT_BYTES) return false;
    const onDisk = withForwardSlashes(readFileSync(absTarget, 'utf8'));
    const wanted = withForwardSlashes(linkText);
    return onDisk === wanted || onDisk === `${wanted}\n` || onDisk === `${wanted}\r\n`;
  } catch {
    return false; // unreadable: not something this sentence can claim
  }
}

/**
 * The real entry name in the target's directory that differs from the planned
 * one only in case, when there is one.
 *
 * `readdirSync` reports what is actually stored, which is the only way to see
 * the difference: every `stat`-shaped probe on a case-insensitive volume answers
 * about the planned spelling and hides the stored one.
 *
 * @param absTarget - absolute path of the symlink target.
 * @returns the differently-cased name on disk, or `undefined`.
 */
function differentlyCasedEntry(absTarget: string): string | undefined {
  const planned = basename(absTarget);
  try {
    for (const entry of readdirSync(dirname(absTarget))) {
      if (entry !== planned && entry.toLowerCase() === planned.toLowerCase()) return entry;
    }
  } catch {
    /* nothing to list: nothing to name */
  }
  return undefined;
}

/**
 * Why the engine may not create a symlink at a target, judged on what is really
 * there.
 *
 * Only a REAL occupant blocks. A symlink — live or dead — is the engine's own
 * shape and is handled as drift by the caller, and an absent target is nothing
 * at all.
 *
 * @param absTarget - absolute path of the symlink target.
 * @param linkText - the relative link text the plan would write there.
 * @returns the one-line reason to report, or `undefined` when nothing real is in
 *   the way.
 */
export function blockingSymlinkOccupant(absTarget: string, linkText: string): string | undefined {
  const kind = occupantKind(absTarget);
  if (kind !== 'file' && kind !== 'directory') return undefined;

  if (kind === 'file' && holdsOwnLinkText(absTarget, linkText)) return SYMLINKS_OFF_REASON;

  const base = kind === 'directory' ? SYMLINK_DIRECTORY_REASON : SYMLINK_FILE_REASON;
  const cased = differentlyCasedEntry(absTarget);
  return cased === undefined
    ? base
    : `${base} — it is named "${cased}" here, and this filesystem does not tell "${cased}" and "${basename(absTarget)}" apart`;
}

/**
 * How a platform can tell whether the link on disk is the link the plan wants.
 *
 * - `link-text` compares the stored text byte for byte. That is the property
 *   AP-06 is actually about: the text is relative, so a checkout that is moved
 *   or cloned somewhere else keeps working.
 * - `resolved-target` compares where the two paths RESOLVE TO.
 */
export type LinkCheck = 'link-text' | 'resolved-target';

/**
 * The comparison a platform is capable of.
 *
 * Windows gets `resolved-target`, and the reason is that a Windows directory
 * link is not a symlink at all. `symlinkType` asks for a JUNCTION — the only
 * directory link Windows makes without Developer Mode or admin rights — and a
 * junction's stored target is ALWAYS absolute: Node resolves the relative text
 * against the link's parent before handing it to Windows, so `readlink` answers
 * `C:\repo\.agents\skills\x` where the plan said `..\..\.agents\skills\x`.
 * Comparing text there calls every junction drifted forever — `--check` could
 * never go clean, and `--fix` would delete and recreate every link on every run.
 *
 * Nothing about POSIX changes: `link-text` is the same byte comparison the
 * engine has always made.
 *
 * @param platform - the running platform, i.e. `process.platform`.
 * @returns the comparison to use.
 */
export function linkCheckFor(platform: NodeJS.Platform): LinkCheck {
  return platform === 'win32' ? 'resolved-target' : 'link-text';
}

/**
 * Whether the symlink at `absTarget` already points where the plan says.
 *
 * Never throws: a link that cannot be read or resolved is simply not the link
 * the plan wants, and the caller repairs it.
 *
 * @param absTarget - absolute path of the symlink (the caller has established
 *   that a symlink is what is there).
 * @param absSource - absolute path of the source it should point at.
 * @param linkText - the relative link text the plan would write.
 * @param how - the comparison this platform can make ({@link linkCheckFor}).
 * @returns `true` when the link already matches the plan.
 */
export function linkMatchesPlan(
  absTarget: string,
  absSource: string,
  linkText: string,
  how: LinkCheck
): boolean {
  try {
    if (how === 'link-text') return readlinkSync(absTarget) === linkText;
    // `realpathSync.native` on BOTH sides, deliberately. It asks the operating
    // system, so the two answers agree on the things only the OS knows: the
    // drive letter's case, an 8.3 short name in the temp path, and the `\\?\`
    // prefix. Resolving one side through the OS and building the other from
    // `repoRoot` is what makes `c:\` and `C:\` look like two different files.
    return realpathSync.native(absTarget) === realpathSync.native(absSource);
  } catch {
    return false;
  }
}
