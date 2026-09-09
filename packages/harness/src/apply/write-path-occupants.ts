/**
 * What may occupy the DIRECTORIES on the way to a target, and what a person is
 * told when one of them may not be written through.
 *
 * `generate-occupants.ts` and `symlink-occupants.ts` answer for the target
 * itself. Nothing answered for the folders above it, and that is where the last
 * shape that could still take a `--fix` down lived (AP-11, DOR-1882). Every
 * write this engine makes creates its parent directories first — `mkdirSync(…,
 * { recursive: true })` inside `writeFileAtomic` and inside `applySymlink` — and
 * `mkdirSync` does not have a "leave it alone" mode: a plain file at
 * `.claude/commands` raises **ENOTDIR** when a directory has to be made under
 * it, **EEXIST** when it IS the directory to make, and **EACCES** through a
 * mode-000 one. Each came out of the middle of `applyPlan`'s action loop, after
 * some actions had already been written and before the six sweeps ran, so the
 * cost was not one failed projection: it was a half-applied tree, and a `--check`
 * that had called every one of those paths ordinary drift and told the person to
 * run the command that was about to die (measured 2026-09-08 across five shapes).
 *
 * So the shape of a write path is decided the way the shape of a target already
 * is: **before anything is written**, by one predicate both `--check` and
 * `--fix` read, and the answer is a `blocked` conflict naming the obstacle and
 * the way out rather than an exception. `applyPlan` computes the whole set in
 * one pure pass over the plan and then applies only the actions whose path it
 * has proved sane, which is what makes the run all-or-nothing per projection
 * instead of "everything up to the first hostile folder".
 *
 * Four SHAPES are refused, and one that looks like them is not:
 *
 * - a **file** where a folder must be. Nothing can be created under it.
 * - a **link to a file**, which is the same obstacle wearing a different hat and
 *   says so in its own words: "`.claude` is a file" about a path that is plainly
 *   a link sends somebody looking for a file that is not there.
 * - a **link that cannot be followed** — dangling, or a loop. `mkdirSync` sees
 *   an existing entry and raises EEXIST rather than creating anything, and a
 *   write through it would land wherever the link says if it ever resolved.
 * - a folder DorkOS **cannot read**. `readdirSync` is how the engine decides
 *   what is already in a wrapper directory, and it cannot write there either.
 * - **a live link to a real folder is fine.** Somebody keeping `.claude` in a
 *   dotfiles checkout is not an obstacle: `mkdirSync` follows it, the write
 *   lands in a real directory, and refusing it would break a working repository
 *   for the sake of a rule about links.
 *
 * PERMISSION is a fifth answer and a different question, so it has its own pass
 * ({@link unwritableWritePath}): a folder that lists perfectly and may not be
 * written in raises EACCES from `mkdirSync`, from the atomic write's
 * `writeFileSync`, or from `symlinkSync` — measured at mode 0555 on
 * `.claude/commands`, `.claude/commands/<pkg>` and `.claude/skills`. It is asked
 * only of the actions that would really write, because a repository whose
 * projections all already match is one this engine writes nothing to, and
 * reporting its folders would turn a clean tree into a wall of faults.
 *
 * The reason names the FOLDER, not the target. Every other conflict in this
 * engine is about the target's own path, which the report already prints; here
 * the obstacle is somewhere above it, and a sentence that did not say where
 * would send a person to look at a file that is perfectly fine.
 *
 * @module apply/write-path-occupants
 */
import { accessSync, constants, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectionAction, ProjectionKind, ProjectionPlan } from '../plan/types.js';
import { isSymlink, tryListDir } from './link-state.js';

/**
 * The projection kinds that write a path, and so have a write path at all.
 *
 * `native` and `drop` are deliberately absent: both write nothing, and a
 * `native` action carries the target the HARNESS reads rather than one DorkOS
 * creates — blocking one because a folder above it is odd would report a fault
 * about a file the engine was never going to touch.
 */
const WRITING_KINDS: ReadonlySet<ProjectionKind> = new Set<ProjectionKind>([
  'symlink',
  'scaffold',
  'generate',
  'merge',
]);

/** Why a directory on a write path cannot be written through. */
export type WritePathCause =
  'file' | 'link-to-file' | 'unfollowable-link' | 'unreadable' | 'read-only';

/**
 * The one sentence each cause gets, written down once.
 *
 * Each reads as the tail of `blocked by \`<path>\`, which …`, so the finished
 * reason is one sentence naming the obstacle and one naming the way out — the
 * same two halves every `reason` in this engine carries, in the same second
 * person the rest of the report uses ({@link writePathReason} joins them).
 *
 * **The sentences live here and nowhere else**, for the reason
 * `sweep-reasons.ts` gives about its own table: the terminal's `--check` and
 * `--fix` blocks, the app's conflict chip and the server's log all print the
 * engine's `reason` verbatim, and two surfaces describing one fact in two voices
 * is how a person stops trusting either.
 */
export const WRITE_PATH_REASONS = {
  file: 'is a file — DorkOS needs a folder there to write this. Move the file aside, then re-run',
  'link-to-file':
    'is a link to a file — DorkOS needs a folder there to write this. Repoint the link at a ' +
    'folder, or delete it, then re-run',
  'unfollowable-link':
    'is a link DorkOS cannot follow — it needs a folder there to write this. Delete the link, ' +
    'then re-run',
  unreadable:
    'is a folder DorkOS cannot read (permission denied). Fix the folder’s permissions, then re-run',
  'read-only':
    'is a folder DorkOS may not write in (permission denied). Fix the folder’s permissions, ' +
    'then re-run',
} as const satisfies Record<WritePathCause, string>;

/**
 * The finished reason for one blocked write path.
 *
 * @param relDir - the repo-relative folder that is in the way.
 * @param cause - which of the five answers it is.
 * @returns the one-line reason to report beside the action.
 */
export function writePathReason(relDir: string, cause: WritePathCause): string {
  return `blocked by \`${relDir}\`, which ${WRITE_PATH_REASONS[cause]}`;
}

/**
 * Why a single directory cannot be written through, or `undefined` when it can.
 *
 * `statSync` FOLLOWS a link on purpose: a link to a real folder is a folder for
 * every purpose this asks about, and `mkdirSync` treats it as one too.
 *
 * Exported for `apply/global-apply.ts`, which asks the identical question about
 * the two absolute roots a global plan writes into. One implementation, so a
 * file at `.claude/skills` in a repository and a file at `~/.agents/skills` in a
 * home directory are described to a person in the same words.
 *
 * @param absDir - absolute path of the directory to probe.
 * @returns the cause, or `undefined` when the directory is absent (it will be
 *   created) or usable.
 */
export function directoryWriteBlock(absDir: string): WritePathCause | undefined {
  let stats;
  try {
    stats = statSync(absDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return 'unreadable';
    // ENOENT and ELOOP both land here, and they are opposite answers: nothing at
    // all is what the engine expects to create, while an entry that exists and
    // resolves to nothing is one `mkdirSync` refuses with EEXIST.
    return isSymlink(absDir) ? 'unfollowable-link' : undefined;
  }
  // A link to a file is refused for the same reason a file is, and says so in
  // its own words: "`.claude` is a file" about a path that is plainly a link
  // sends somebody to look for a file that is not there.
  if (!stats.isDirectory()) return isSymlink(absDir) ? 'link-to-file' : 'file';
  // A directory that stats fine can still be one nobody may open — mode-000 is
  // the measured shape — and the wrapper-dir scan has to READ this one.
  return tryListDir(absDir) === undefined ? 'unreadable' : undefined;
}

/**
 * Every directory a target's write must pass through, shallowest first.
 *
 * Shallowest first is what makes the answer actionable: a file at
 * `.claude/commands` makes `.claude/commands/acme` unreadable too, and naming
 * the deeper one would send a person to a path that only looks wrong because of
 * the one above it.
 *
 * Exported for `apply/global-apply.ts`. Handed an ABSOLUTE target it answers
 * absolute ancestors, which is what a global plan needs: its roots are absolute
 * and there is no repository root to be relative to.
 *
 * @param target - the action's target path, repo-relative or absolute.
 * @returns its ancestor directories, outermost first, excluding the repo root.
 */
export function writePathDirs(target: string): string[] {
  const dirs: string[] = [];
  // `dirname(dir) === dir` is the root of whatever kind of path this is, which
  // terminates on a POSIX `/` and on a Windows drive letter alike.
  for (let dir = dirname(target); dir !== '.' && dir !== dirname(dir); dir = dirname(dir)) {
    dirs.push(dir);
  }
  return dirs.reverse();
}

/**
 * Every action whose write path DorkOS may not create, with the reason to
 * report beside it.
 *
 * Pure: it reads the tree and writes nothing, so `checkPlan` can call it for the
 * same answer `applyPlan` acts on and the two can never disagree about a path
 * neither may touch (AP-03, AP-11).
 *
 * The probe is memoised per directory, because siblings share ancestors — a plan
 * with forty command wrappers asks about `.claude/commands` once.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param plan - the current projection plan.
 * @returns each blocked target mapped to its reason.
 */
export function findBlockedWritePaths(repoRoot: string, plan: ProjectionPlan): Map<string, string> {
  const blocked = new Map<string, string>();
  const probed = new Map<string, WritePathCause | undefined>();

  for (const action of plan.actions) {
    const target = action.target;
    if (target === undefined || !WRITING_KINDS.has(action.kind)) continue;
    const reason = blockedWritePath(repoRoot, target, probed);
    if (reason !== undefined) blocked.set(target, reason);
  }
  return blocked;
}

/**
 * Why the write path to ONE target may not be created, or `undefined` when every
 * directory on the way to it is fine.
 *
 * The per-target half of {@link findBlockedWritePaths}, extracted so a caller
 * that has a path rather than a plan asks the identical question and gets the
 * identical sentence. Adopt is that caller: it has a source folder and a target
 * folder and no projection plan at all, and a second implementation of this
 * would be a second set of words about the same file.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param target - the repo-relative path a write would create.
 * @param probed - a memo of directories already answered for, shared across a
 *   batch so siblings ask about a common ancestor once.
 * @returns the reason naming the OUTERMOST obstacle — the one to clear, since a
 *   file at `.claude/skills` makes everything under it unwritable too.
 */
export function blockedWritePath(
  repoRoot: string,
  target: string,
  probed: Map<string, WritePathCause | undefined> = new Map()
): string | undefined {
  for (const relDir of writePathDirs(target)) {
    let cause = probed.get(relDir);
    if (!probed.has(relDir)) {
      cause = directoryWriteBlock(join(repoRoot, relDir));
      probed.set(relDir, cause);
    }
    if (cause !== undefined) return writePathReason(relDir, cause);
  }
  return undefined;
}

/**
 * Whether this platform can be asked about write permission at all.
 *
 * Not Windows. `accessSync(dir, W_OK)` there reports the read-only ATTRIBUTE,
 * which directories do not meaningfully carry, and answers "writable" for a
 * folder an ACL denies — so the probe would be a promise the platform cannot
 * keep, in both directions. The shapes it protects against are POSIX mode bits,
 * and Windows keeps the behaviour it had: the write itself reports the failure.
 */
const CAN_ASK_ABOUT_WRITING = process.platform !== 'win32';

/**
 * Why a write to this target would fail on permissions — asked only of a target
 * something is actually about to be written to.
 *
 * Where {@link findBlockedWritePaths} is about SHAPE (a file where a folder
 * belongs, whatever anyone intends to do about it), this is about one specific
 * write: the deepest folder that already exists on the way to `target` is the
 * one that has to take a new entry — the temp file every atomic write creates,
 * or the link, or the folder above it — and a folder that lists but may not be
 * written in raises EACCES from `writeFileSync`, `mkdirSync` or `symlinkSync`
 * rather than from anything either mode had asked. Measured at mode 0555 on
 * `.claude/commands`, `.claude/commands/<pkg>` and `.claude/skills`.
 *
 * **Scoped to drifted actions on purpose.** A repository whose projections all
 * already match is one this engine writes nothing to, and calling its folders
 * blocked would turn a clean tree into a wall of faults over a permission
 * nothing was going to need. The caller decides what "would write" means, and
 * `--check` and `--fix` ask it the same way so they cannot disagree.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param target - the action's repo-relative target path.
 * @returns the reason to report, or `undefined` when the write may proceed.
 */
export function unwritableWritePath(repoRoot: string, target: string): string | undefined {
  if (!CAN_ASK_ABOUT_WRITING) return undefined;
  // Deepest first: the folder that will hold the new entry is the last one that
  // is already there. Everything below it this engine creates itself, and owns.
  const dirs = writePathDirs(target).reverse();
  for (const relDir of dirs) {
    const abs = join(repoRoot, relDir);
    let stats;
    try {
      stats = statSync(abs);
    } catch {
      continue; // not there yet: the engine will make it, inside the next one up
    }
    if (!stats.isDirectory()) return undefined; // a shape question, already answered
    try {
      accessSync(abs, constants.W_OK | constants.X_OK);
      return undefined;
    } catch {
      return writePathReason(relDir, 'read-only');
    }
  }
  // Every folder on the way is still to be made, so the repository root takes
  // the first one. It is not probed: a root this process cannot write in has
  // already stopped the manifest read that got us here.
  return undefined;
}

/**
 * The reason a drifted action cannot be written, for the targets a caller says
 * are about to be written to.
 *
 * One helper so `applyPlan` and `checkPlan` ask the identical question of the
 * identical set — the property `generate-occupants.ts` states for shape, applied
 * to permission.
 *
 * @param repoRoot - absolute path to the repository root.
 * @param actions - the actions a write would touch (already shape-checked).
 * @returns each blocked target mapped to its reason.
 */
export function findUnwritableTargets(
  repoRoot: string,
  actions: readonly ProjectionAction[]
): Map<string, string> {
  const blocked = new Map<string, string>();
  for (const action of actions) {
    const target = action.target;
    if (target === undefined || !WRITING_KINDS.has(action.kind)) continue;
    const reason = unwritableWritePath(repoRoot, target);
    if (reason !== undefined) blocked.set(target, reason);
  }
  return blocked;
}
