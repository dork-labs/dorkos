/**
 * The state of a room's integration tree, and what DorkOS refuses while it is
 * not what DorkOS left (spec `project-rooms` §3.10, dirty-main degradation).
 *
 * `repo/` has exactly one writer and it is this server: merges land there, and
 * so do the saves a person makes in the app. Nothing DorkOS does leaves it
 * dirty — a merge that fails is aborted, a save that fails is rolled back — so
 * a change in it that nobody here made means **something outside DorkOS wrote
 * in the room's files**, almost always a person with a terminal.
 *
 * Two things follow, and they are the whole of this module:
 *
 * - **Everything that writes stops**, with one code (`MAIN_CHECKOUT_DIRTY`) and
 *   one reason, because the remedy is the same for all of them: somebody has to
 *   look. Merging or saving on top would either fold a stranger's work into
 *   somebody else's commit or quietly throw it away, and both are worse than a
 *   refusal. This is the "loud degradation, never quiet corruption" the spec
 *   asks for, and it is why the refusal is shared rather than reimplemented per
 *   caller.
 * - **The state is reportable, file by file.** A refusal a person cannot act on
 *   is a dead end, so the same read that stops the writes also answers WHAT is
 *   different ({@link readMainCheckoutState}), which is what lets the room say
 *   so and lets the operator commit those changes or discard exactly the ones
 *   they name.
 *
 * **A branch other than `main` is the same refusal and not the same remedy.**
 * DorkOS never checks the integration tree out anywhere else, so finding it on
 * another branch means the same thing; but putting it back is a person's act,
 * not this server's — switching a branch under work somebody left there is the
 * corruption the refusal exists to prevent.
 *
 * @module server/services/rooms/repo/room-main-checkout
 */
import { RoomError } from '../room-errors.js';
import {
  currentBranch,
  hasUncommittedChanges,
  listStrayChanges,
  type StrayChange,
} from './room-repo-git.js';

/** What a room's integration tree looks like on disk right now. */
export interface RoomMainCheckoutState {
  /** The branch it is checked out on, or `null` for a detached head. */
  branch: string | null;
  /** Everything in it that is not committed. Empty when the tree is clean. */
  strays: StrayChange[];
}

/**
 * Read the integration tree's branch and everything uncommitted in it.
 *
 * The branch is always asked, because the caller has to tell "on the wrong
 * branch" from "has stray edits" and a person looking at a warning has to be
 * told which.
 *
 * **The expensive question is asked only when the cheap one says yes.** The
 * per-file list needs `--untracked-files=all`, which walks INTO every untracked
 * directory — so a room somebody unpacked a build directory into costs tens of
 * thousands of paths. That list is what the warning renders and what a discard
 * names, so it cannot be given up; but a healthy room is clean, and every merge,
 * every save and every poll of the room's status asks this. So the cheap
 * `status --porcelain` (untracked directories collapsed to one entry each)
 * answers "is anything different at all", and only a room that is really stuck
 * pays for the detail. The two can never disagree: `all` is a superset of the
 * default, so one is empty exactly when the other is (found in review).
 *
 * @param repoDir - The room's main checkout.
 * @param ceilingDir - The room home directory git's search may not climb past.
 * @returns The branch, and one record per uncommitted path.
 */
export async function readMainCheckoutState(
  repoDir: string,
  ceilingDir: string
): Promise<RoomMainCheckoutState> {
  const branch = await currentBranch(repoDir, ceilingDir);
  if (!(await hasUncommittedChanges(repoDir, ceilingDir))) return { branch, strays: [] };
  return { branch, strays: await listStrayChanges(repoDir, ceilingDir) };
}

/**
 * The refusal for a tree DorkOS did not leave this way, or `null` when it is
 * clean.
 *
 * Two sentences for two facts, one code for one remedy: the person has to look
 * at it either way, and telling them WHICH is what makes the message worth
 * reading.
 *
 * @param state - What {@link readMainCheckoutState} answered.
 * @returns The refusal to throw, or `null`.
 */
function mainCheckoutRefusal(state: RoomMainCheckoutState): RoomError | null {
  if (state.branch !== 'main') {
    return new RoomError(
      'MAIN_CHECKOUT_DIRTY',
      `This room’s files are not on their main branch (${state.branch ?? 'no branch'}), which only something outside DorkOS can have done. Put them back on main before merging.`
    );
  }
  if (state.strays.length > 0) {
    return new RoomError(
      'MAIN_CHECKOUT_DIRTY',
      'This room’s files have changes DorkOS did not make. Nothing will be merged or saved until they are committed or undone.'
    );
  }
  return null;
}

/**
 * Refuse to write into an integration tree somebody else has been writing in.
 *
 * The one gate every server-side write to `repo/` goes through, merges and
 * human saves alike. Called while holding the room's queue, so what it saw is
 * still true when the write happens.
 *
 * @param repoDir - The room's main checkout.
 * @param ceilingDir - The room home directory git's search may not climb past.
 * @throws {RoomError} `MAIN_CHECKOUT_DIRTY`.
 */
export async function assertMainCheckoutReady(repoDir: string, ceilingDir: string): Promise<void> {
  const refusal = mainCheckoutRefusal(await readMainCheckoutState(repoDir, ceilingDir));
  if (refusal) throw refusal;
}
