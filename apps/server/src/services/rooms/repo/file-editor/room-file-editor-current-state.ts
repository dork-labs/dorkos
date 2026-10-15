import { readOriginalRoomEditorView } from '../room-file-editor.js';
import path from 'node:path';
import { requireDocHttpRoomFileWriteCurrent } from '../../../canvas/doc-channel/http-composition.js';
import {
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import type { RoomRepoCaps } from '@dorkos/shared/room-repo';
import type { RoomFileCommit, RoomFileConflict } from '@dorkos/shared/room-files';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logger } from '../../../../lib/logger.js';
import { RoomError } from '../../data/room-errors.js';
import { assertMainCheckoutReady } from '../room-main-checkout.js';
import {
  GitUnavailableError,
  gitAuthorName,
  listTree,
  OPERATOR_GIT_EMAIL,
  personGitEmail,
  revParse,
  type GitIdentity,
  type TreeEntry,
} from '../room-repo-git.js';
import { checkLockedPaths } from '../room-file-ops.js';
import type { RoomFileActor, MainState } from './room-file-editor-contracts.js';
import { exists } from './room-file-editor-path-data.js';

/**
 * Refuse anybody who may not change this room's files — before the queue,
 * and before a route looks anything else up (an attachment, an upload's
 * bytes), so a caller who may not write learns nothing more.
 *
 * @param roomId - The room.
 * @param actor - Who is asking.
 * @throws {RoomError} `ROOM_REPOS_DISABLED`, `ROOM_NOT_FOUND`,
 *   `ROOM_ARCHIVED`, `PEOPLE_ONLY`, or `ROOM_HAS_NO_REPO`.
 */
export function prequeue(editorOwner: object, roomId: string, caller: object): void {
  const view = readOriginalRoomEditorView(editorOwner);
  if (!view.deps.enabled())
    throw new RoomError(
      'ROOM_REPOS_DISABLED',
      'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
    );
  if (!view.owner) throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  requireDocHttpRoomFileWriteCurrent(view.owner, roomId, caller);
  if (view.deps.store.getRow(roomId) === null)
    throw new RoomError('ROOM_HAS_NO_REPO', 'This room does not have files of its own.');
}

/** Execute the original guarded assertCanChange editor operation. */
export function assertCanChange(editorOwner: object, roomId: string, actor: RoomFileActor): void {
  const view = readOriginalRoomEditorView(editorOwner);
  if (!view.deps.enabled()) {
    throw new RoomError(
      'ROOM_REPOS_DISABLED',
      'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
    );
  }
  // Membership before anything about the repo, so a non-member cannot tell a
  // project room from any other — the order `GET /:id/files` writes down.
  const operation = view.operation.getStore();
  if (!operation || operation.roomId !== roomId || operation.actor !== actor || !view.owner)
    throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  requireDocHttpRoomFileWriteCurrent(view.owner, roomId, operation.caller);
  if (view.deps.store.getRow(roomId) === null) {
    throw new RoomError('ROOM_HAS_NO_REPO', 'This room does not have files of its own.');
  }
}

/**
 * Run a change in the room's lane — the same queue a merge takes — with
 * `main` checked clean and read.
 *
 * @param roomId - The room.
 * @param work - The change, handed what `main` holds now.
 */
export async function underLock<T>(
  editorOwner: object,
  roomId: string,
  work: (state: MainState) => Promise<T>
): Promise<T> {
  const view = readOriginalRoomEditorView(editorOwner);
  const operation = view.operation.getStore();
  if (!operation || operation.roomId !== roomId || !operation.context || !view.owner)
    throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  const context = operation.context;
  const roots = readInstallationRoomMutationRoots(context);
  await checkInstallationRoomMutationTarget(context, roots.repoPath);
  const caps = await view.requireCaps(roomId);
  await checkInstallationRoomMutationTarget(context, roots.repoPath);
  return view.translatingGitAbsence(async () => {
    await assertMainCheckoutReady(roots.repoPath, roots.homePath);
    await checkInstallationRoomMutationTarget(context, roots.repoPath);
    const head = await view.resolveMain(roots.repoPath, roots.homePath);
    const tree = head
      ? await listTree(roots.repoPath, head, roots.homePath)
      : new Map<string, TreeEntry>();
    await checkInstallationRoomMutationTarget(context, roots.repoPath);
    return work({ repoDir: roots.repoPath, ceiling: roots.homePath, caps, head, tree, context });
  });
}

/**
 * The optimistic lock, answered as the conflict a client acts on.
 *
 * @param roomId - The room.
 * @param state - What `main` holds.
 * @param baseCommit - What the person's view was read at.
 * @param isLocked - Which paths the lock covers.
 * @param fallbackPath - What to name when nothing locked exists anywhere.
 * @returns The conflict, or `null` when the change may proceed.
 * @throws {RoomError} `ROOM_FILE_NOT_FOUND` when the room's files hold no
 *   commits at all. `enable` seeds `ROOM.md` in the same call that creates the
 *   repo, so this cannot happen through DorkOS; it is answered rather than
 *   assumed away because a conflict carrying `commit: ''` could never be sent
 *   back, and the person would be stuck (found in review).
 */
export async function lockConflict(
  editorOwner: object,
  roomId: string,
  state: MainState,
  baseCommit: string,
  isLocked: (filePath: string) => boolean,
  fallbackPath: string
): Promise<RoomFileConflict | null> {
  const view = readOriginalRoomEditorView(editorOwner);
  if (state.head === null) {
    throw new RoomError(
      'ROOM_FILE_NOT_FOUND',
      'This room’s files have no history yet, so there is nothing here that you were editing. Open them again.'
    );
  }
  const outcome = await checkLockedPaths(
    state.repoDir,
    state.ceiling,
    state.head,
    state.tree,
    baseCommit,
    isLocked,
    fallbackPath
  );
  return outcome.status === 'changed' ? view.conflictAt(roomId, state, outcome.path) : null;
}

/**
 * The conflict payload for one path: where `main` is now, and who last
 * touched the path there.
 *
 * @param roomId - The room.
 * @param state - What `main` holds.
 * @param filePath - The path that moved.
 */
export async function conflictAt(
  editorOwner: object,
  roomId: string,
  state: MainState,
  filePath: string
): Promise<RoomFileConflict> {
  const view = readOriginalRoomEditorView(editorOwner);
  return {
    path: filePath,
    commit: state.head as string,
    lastCommit: state.tree.has(filePath) ? await view.lastCommitOf(roomId, filePath) : null,
  };
}

/**
 * Who a commit is authored as — the §7.1 rule, in one place.
 *
 * @param actor - Who made the change.
 */
export function identityOf(editorOwner: object, actor: RoomFileActor): GitIdentity {
  const view = readOriginalRoomEditorView(editorOwner);
  if (actor.signedIn) {
    return {
      name: gitAuthorName(view.deps.personName(actor.authorId)),
      email: personGitEmail(actor.authorId),
    };
  }
  return { name: gitAuthorName(view.deps.operatorGitName()), email: OPERATOR_GIT_EMAIL };
}

/**
 * The name the room entry opens with.
 *
 * @param actor - Who made the change.
 */
export function displayNameOf(editorOwner: object, actor: RoomFileActor): string {
  const view = readOriginalRoomEditorView(editorOwner);
  const raw = actor.signedIn ? view.deps.personName(actor.authorId) : view.deps.operatorGitName();
  return sanitizeIdentity(raw ?? '') ?? 'Someone';
}

/**
 * The caps this repo was created under.
 *
 * From the sidecar rather than from config, for the reason
 * `room-merge-service.ts` writes down: a room's contents were legal when they
 * were written, and lowering a setting today must not make yesterday's files
 * retroactively illegal.
 *
 * @param roomId - The room.
 * @throws {RoomError} `ROOM_HAS_NO_REPO` when the sidecar has gone.
 */
export async function requireCaps(editorOwner: object, roomId: string): Promise<RoomRepoCaps> {
  const view = readOriginalRoomEditorView(editorOwner);
  const sidecar = await view.deps.store.readSidecar(roomId);
  if (!sidecar) {
    throw new RoomError('ROOM_HAS_NO_REPO', 'This room does not have files of its own.');
  }
  return sidecar.caps;
}

/**
 * The commit `main` points at, or `null` when the repo has no commits.
 *
 * @param repoDir - The room's main checkout.
 * @param ceiling - The room home directory git's search may not climb past.
 */
export async function resolveMain(
  editorOwner: object,
  repoDir: string,
  ceiling: string
): Promise<string | null> {
  const view = readOriginalRoomEditorView(editorOwner);
  try {
    return await revParse(repoDir, 'main', ceiling);
  } catch (err) {
    if (err instanceof GitUnavailableError) throw err;
    return null;
  }
}

/**
 * Who last touched a path, in the shape a read answers it.
 *
 * @param roomId - The room.
 * @param filePath - The path.
 * @returns The commit, or `null` when it cannot be attributed.
 */
export async function lastCommitOf(
  editorOwner: object,
  roomId: string,
  filePath: string
): Promise<RoomFileCommit | null> {
  const view = readOriginalRoomEditorView(editorOwner);
  try {
    return await view.deps.files.lastCommitFor(roomId, filePath);
  } catch (err) {
    logger.warn('[rooms] a changed room file could not be read back for its provenance', {
      roomId,
      path: filePath,
      err,
    });
    return null;
  }
}

/**
 * Turn "this machine has no git" into the room domain's own refusal — the
 * same sentence every other room-repo surface gives.
 *
 * @param work - The git-touching body.
 * @returns Whatever `work` answers.
 */
export async function translatingGitAbsence<T>(
  editorOwner: object,
  work: () => Promise<T>
): Promise<T> {
  const view = readOriginalRoomEditorView(editorOwner);
  try {
    return await work();
  } catch (err) {
    if (err instanceof GitUnavailableError) {
      throw new RoomError(
        'ROOM_REPO_GIT_UNAVAILABLE',
        'This computer doesn’t have git installed, and a room’s files are a git repository. Install git, then try again.'
      );
    }
    throw err;
  }
}
