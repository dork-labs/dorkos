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
 * Three shapes are refused, and one that looks like them is not:
 *
 * - a **file** where a folder must be. Nothing can be created under it.
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
 * The reason names the FOLDER, not the target. Every other conflict in this
 * engine is about the target's own path, which the report already prints; here
 * the obstacle is somewhere above it, and a sentence that did not say where
 * would send a person to look at a file that is perfectly fine.
 *
 * @module apply/write-path-occupants
 */
import { statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ProjectionKind, ProjectionPlan } from '../plan/types.js';
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
export type WritePathCause = 'file' | 'unfollowable-link' | 'unreadable';

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
  'unfollowable-link':
    'is a link DorkOS cannot follow — it needs a folder there to write this. Delete the link, ' +
    'then re-run',
  unreadable:
    'is a folder DorkOS cannot read (permission denied). Fix the folder’s permissions, then re-run',
} as const satisfies Record<WritePathCause, string>;

/**
 * The finished reason for one blocked write path.
 *
 * @param relDir - the repo-relative folder that is in the way.
 * @param cause - which of the three shapes it is.
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
 * @param absDir - absolute path of the directory to probe.
 * @returns the cause, or `undefined` when the directory is absent (it will be
 *   created) or usable.
 */
function directoryBlock(absDir: string): WritePathCause | undefined {
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
  if (!stats.isDirectory()) return 'file';
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
 * @param target - the action's repo-relative target path.
 * @returns its ancestor directories, outermost first, excluding the repo root.
 */
function writePathDirs(target: string): string[] {
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
    for (const relDir of writePathDirs(target)) {
      let cause = probed.get(relDir);
      if (!probed.has(relDir)) {
        cause = directoryBlock(join(repoRoot, relDir));
        probed.set(relDir, cause);
      }
      if (cause === undefined) continue;
      blocked.set(target, writePathReason(relDir, cause));
      break; // the outermost obstacle is the one to clear
    }
  }
  return blocked;
}
