/**
 * What Windows can make where a link goes — and what it costs when the answer
 * is "a junction".
 *
 * Windows has two shapes for a directory link and they are not interchangeable:
 *
 * - A **directory symlink** is the real thing. Git stores it as a blob holding
 *   the link's own text at mode `120000`, exactly as it does on POSIX, so a link
 *   committed from Windows is still a link to everybody who clones it. Creating
 *   one needs a privilege: Developer Mode, or an administrator.
 * - A **junction** needs no privilege at all, which is the only reason the
 *   engine ever asked for one. But git sees a junction as a DIRECTORY: `git add`
 *   walks into it and commits the skill's files a second time under
 *   `.claude/skills/<name>/`, and the committed tree holds no link at all.
 *   Measured on a `windows-latest` runner (DOR-1855, run 34189732292):
 *   `git ls-files --stage` reported zero entries in mode 120000 after a `--fix`.
 *
 * So the engine asks for the real thing and settles for the junction: a one-time
 * capability {@link canSymlinkDirs} probe decides, and where the answer is the
 * junction and the repository is a git checkout, a person is TOLD before they
 * commit ({@link JUNCTION_COMMIT_WARNING}). The privilege is the common case on
 * a CI runner and the uncommon one on a developer's machine, which is why both
 * halves are needed.
 *
 * **A junction is still a correct link.** It resolves where the plan says, every
 * agent tool reading it gets the right files, and nothing here calls it drift —
 * `--check` goes clean on a Windows machine with no Developer Mode, exactly as
 * it did before. The warning is about COMMITTING, and only about committing.
 *
 * ## How a junction is recognised, on any platform
 *
 * By its stored text: **a junction's target is always absolute**. Node resolves
 * the relative text against the link's parent before Windows ever sees it, so
 * `readlink` answers `C:\repo\.agents\skills\x` where the plan said
 * `..\..\.agents\skills\x`. That is the same fact `linkCheckFor` rests on, and
 * the Windows CI leg prints it on every run.
 *
 * It is a fact about the TEXT rather than about an API, which is what lets the
 * shape be staged and driven on POSIX: a test redefines `process.platform` and
 * writes an absolute-text link, and every predicate here answers what it would
 * answer on Windows. The one thing it cannot tell apart is a real symlink
 * somebody wrote by hand with an absolute path — rare, not the engine's, and the
 * sentence's advice ("delete it and re-run") is right for that too, since AP-06
 * wants the text relative.
 *
 * @module apply/windows-links
 */
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import type { ProjectionPlan } from '../plan/types.js';
import { isGitRepo } from './gitignore.js';

/**
 * What a person is told when the links DorkOS just made are junctions and this
 * repository is a git checkout.
 *
 * ONE sentence per run, never per link: the fact is about the machine, and
 * eighteen copies of it is not eighteen times the information.
 *
 * Every clause is load-bearing. It says what is on disk, what git will do with
 * it, what not to do, and the two ways out — turn the privilege on and make the
 * links again, or commit from a machine that has it. "Delete the junctions" is
 * in there because a link that already resolves correctly is not drift, so a
 * plain re-run of `--fix` leaves them exactly where they are.
 */
export const JUNCTION_COMMIT_WARNING =
  'The skill links in this project are Windows junctions, and git commits the files inside a ' +
  'junction instead of the link itself. Do not commit them from this machine: turn on Developer ' +
  'Mode (Settings → For developers) so DorkOS can make real links, delete the junctions and run ' +
  '`dorkos harness sync --fix` again — or commit from a checkout that can make links.';

/** The probe a test has substituted, if any — see {@link setDirSymlinkProbe}. */
let injectedProbe: (() => boolean) | undefined;

/** The memoised answer, kept for the life of the process (or until a test resets it). */
let probeAnswer: boolean | undefined;

/**
 * Substitute the capability probe, and forget whatever it last answered.
 *
 * **For tests only.** It is what lets both branches of a Windows-only decision
 * run on a POSIX machine: with `process.platform` redefined to `win32`, a probe
 * answering `true` drives the real-symlink branch and one answering `false`
 * drives the junction fallback. Pass `undefined` to restore the real probe,
 * which every suite that touches this must do when it ends.
 *
 * @param probe - what to ask instead, or `undefined` to ask the filesystem again.
 */
export function setDirSymlinkProbe(probe: (() => boolean) | undefined): void {
  injectedProbe = probe;
  probeAnswer = undefined;
}

/**
 * Ask the filesystem, once, whether this account may create a directory symlink.
 *
 * A real attempt in a temporary directory, because nothing else answers it:
 * Windows exposes no "may I" API for `SeCreateSymbolicLinkPrivilege` that is
 * simpler or more truthful than making one link. Success means Developer Mode or
 * an administrator; `EPERM` means neither. Anything else — no temp directory to
 * write in, a filesystem that has no idea what a link is — answers `false` as
 * well, because the fallback is the shape that works without privilege and a
 * probe that cannot answer must not be the reason a sync fails.
 *
 * The probe link is removed with the directory that holds it, so nothing is left
 * behind either way.
 *
 * @returns `true` when a directory symlink could really be created.
 */
function probeDirSymlink(): boolean {
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), 'dorkos-link-probe-'));
    const source = join(dir, 'source');
    mkdirSync(source);
    symlinkSync(source, join(dir, 'link'), 'dir');
    return true;
  } catch {
    return false;
  } finally {
    // `rmSync` unlinks a symlink rather than following it, so this removes the
    // probe and never what it pointed at.
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Whether this machine may create a real directory symlink — asked once and
 * remembered.
 *
 * Memoised because it is a property of the account and the filesystem rather
 * than of any one path, and a sync makes one link per skill: probing per link
 * would create and delete a link for every projection in the plan.
 *
 * **Never called on POSIX by the engine.** `symlinkSync` ignores its type
 * argument there, so there is nothing to decide and nothing to probe.
 *
 * @returns `true` when a directory symlink is possible here.
 */
export function canSymlinkDirs(): boolean {
  probeAnswer ??= (injectedProbe ?? probeDirSymlink)();
  return probeAnswer;
}

/**
 * The symlink type to request for a source path — the ONE implementation both
 * the project and the global apply stages use.
 *
 * POSIX ignores the third argument to `symlinkSync`, so the answer there is
 * `undefined` and nothing is probed. On Windows a directory source gets the real
 * `'dir'` link where the privilege exists and a `'junction'` where it does not,
 * which is the whole of DOR-1883: the junction was unconditional, and a link
 * committed from Windows was therefore never a link.
 *
 * The stat FOLLOWS the source deliberately. A skill source may itself be a
 * symlink into a shared directory, and `lstat` on that answers "not a directory"
 * — which asked Windows for a file link to a directory, an EPERM off Developer
 * Mode. A dangling source still answers `undefined`, which lets `symlinkSync`
 * report the real failure rather than this guessing at one.
 *
 * @param absSource - absolute path of the file or directory being linked TO.
 * @returns the type argument to pass to `symlinkSync`.
 */
export function symlinkTypeFor(absSource: string): 'dir' | 'junction' | 'file' | undefined {
  if (process.platform !== 'win32') return undefined;
  try {
    if (!statSync(absSource).isDirectory()) return 'file';
  } catch {
    return undefined;
  }
  return canSymlinkDirs() ? 'dir' : 'junction';
}

/**
 * Whether what is at `absTarget` is a junction — the link shape git commits as a
 * directory.
 *
 * Never throws: an absent path, an unreadable one and a plain file are all "no".
 *
 * @param absTarget - absolute path of the link to judge.
 * @returns `true` on Windows when a link is there and its stored target is
 *   absolute (see this module's header for why that is the discriminator).
 */
export function isJunctionAt(absTarget: string): boolean {
  if (process.platform !== 'win32') return false;
  try {
    if (!lstatSync(absTarget).isSymbolicLink()) return false;
    return isAbsolute(readlinkSync(absTarget));
  } catch {
    return false;
  }
}

/**
 * The one warning a run carries when junctions are sitting at this plan's link
 * targets inside a git checkout — empty every other time.
 *
 * Both modes ask it, off the same plan and the same disk, so `--check` and
 * `--fix` can never disagree about whether a person is about to commit
 * something that is not a link. `--fix` asks it AFTER writing, so the links it
 * just made are what it answers about; `--check` asks about the links already
 * there, which is what warns somebody before they commit.
 *
 * **No `.git`, no warning.** The whole sentence is about what `git add` would
 * do, and there is nothing here to add to.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the plan whose symlink targets are examined.
 * @returns one warning, or none.
 */
export function junctionCommitWarnings(repoRoot: string, plan: ProjectionPlan): string[] {
  if (process.platform !== 'win32') return [];
  const anyJunction = plan.actions.some(
    (action) =>
      action.kind === 'symlink' &&
      action.target !== undefined &&
      isJunctionAt(join(repoRoot, action.target))
  );
  return anyJunction && isGitRepo(repoRoot) ? [JUNCTION_COMMIT_WARNING] : [];
}
