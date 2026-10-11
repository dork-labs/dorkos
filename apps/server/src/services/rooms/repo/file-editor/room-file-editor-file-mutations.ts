import { readOriginalRoomEditorView } from '../room-file-editor.js';
import path from 'node:path';
import { ROOM_UPLOAD_MAX_FILES } from '@dorkos/shared/room-files';
import { RoomError } from '../../data/room-errors.js';
import { GITLINK_MODE, SYMLINK_MODE } from '../room-repo-git.js';
import {
  assertFits,
  assertNoLinkOnDisk,
  assertNotIgnored,
  assertOrdinaryFile,
  assertWritablePath,
  isExecutable,
  RoomTreeIndex,
  type RoomFileChange,
} from '../room-file-ops.js';
import type {
  RoomFileChangeOutcome,
  RoomFileActor,
  RoomFileUploadItem,
} from './room-file-editor-contracts.js';
import { requireFilePath, exists, notThere } from './room-file-editor-path-data.js';

/**
 * Upload files into one folder of the room's files, as one commit.
 *
 * Each target must be absent at `main`, or named in `replace` and unchanged
 * since `baseCommit`. Anything else already there is refused
 * `ROOM_FILE_EXISTS`, naming the path, so the app can ask the person.
 *
 * @param roomId - The room.
 * @param actor - Who is asking.
 * @param input.dir - The folder, relative to the repo root; `''` for the root.
 * @param input.baseCommit - What the person's view was read at.
 * @param input.replace - The names this upload may overwrite.
 * @param input.files - The files, in request order.
 * @returns The change, or the conflict that stopped it.
 */
export async function upload(
  editorOwner: object,
  roomId: string,
  actor: RoomFileActor,
  input: {
    dir: string;
    baseCommit: string | null;
    replace: readonly string[];
    files: readonly RoomFileUploadItem[];
  }
): Promise<RoomFileChangeOutcome> {
  const view = readOriginalRoomEditorView(editorOwner);
  view.assertCanChange(roomId, actor);
  if (input.files.length === 0) {
    throw new RoomError('ROOM_FILE_PATH_INVALID', 'There were no files in that upload.');
  }
  if (input.files.length > ROOM_UPLOAD_MAX_FILES) {
    throw new RoomError(
      'ROOM_UPLOAD_TOO_MANY_FILES',
      `One upload can carry at most ${ROOM_UPLOAD_MAX_FILES} files.`
    );
  }
  return view.addFiles(roomId, actor, { ...input, kind: 'upload' });
}

/**
 * Keep a file somebody attached to a message as one of the room's files, as
 * one commit. The route has already checked the attachment belongs to a
 * message in this room and read its bytes.
 *
 * @param roomId - The room.
 * @param actor - Who is asking.
 * @param input.dir - The folder to save it into; `''` for the root.
 * @param input.name - The file name to save it under.
 * @param input.baseCommit - What the person's view was read at.
 * @param input.bytes - The attachment's bytes.
 * @returns The change, or the conflict that stopped it.
 */
export async function saveAttachment(
  editorOwner: object,
  roomId: string,
  actor: RoomFileActor,
  input: { dir: string; name: string; baseCommit: string | null; bytes: Buffer }
): Promise<RoomFileChangeOutcome> {
  const view = readOriginalRoomEditorView(editorOwner);
  view.assertCanChange(roomId, actor);
  return view.addFiles(roomId, actor, {
    dir: input.dir,
    baseCommit: input.baseCommit,
    replace: [],
    files: [{ name: input.name, content: input.bytes }],
    kind: 'from-attachment',
  });
}

/**
 * Rename or move one file or folder, as one commit.
 *
 * Every path under `from` must be unchanged since `baseCommit`; `to` must not
 * exist. A file keeps its executable bit. A link or another repository inside
 * the folder is refused rather than carried — a move writes files, and those
 * two are not files.
 *
 * @param roomId - The room.
 * @param actor - Who is asking.
 * @param input.from - The file or folder.
 * @param input.to - Where it goes.
 * @param input.baseCommit - What the person's view was read at.
 * @returns The change, or the conflict that stopped it.
 */
export async function move(
  editorOwner: object,
  roomId: string,
  actor: RoomFileActor,
  input: { from: string; to: string; baseCommit: string }
): Promise<RoomFileChangeOutcome> {
  const view = readOriginalRoomEditorView(editorOwner);
  view.assertCanChange(roomId, actor);
  const requestedFrom = requireFilePath(input.from);
  const requestedTo = requireFilePath(input.to);

  return view.underLock(roomId, async (state) => {
    const treeIndex = new RoomTreeIndex(state.tree.keys());
    const from = treeIndex.canonicalize(requestedFrom);
    const to = treeIndex.canonicalize(requestedTo);
    if (from === to) {
      throw new RoomError('ROOM_FILE_PATH_INVALID', 'That is already its name.');
    }
    if (to.startsWith(`${from}/`)) {
      throw new RoomError('ROOM_FILE_PATH_INVALID', 'A folder cannot be moved inside itself.');
    }
    // Always locked: moving files is only safe over the files the person saw.
    const isUnder = (p: string): boolean => p === from || p.startsWith(`${from}/`);
    const stale = await view.lockConflict(roomId, state, input.baseCommit, isUnder, from);
    if (stale) return { status: 'conflict' as const, conflict: stale };

    const sources = [...state.tree.values()].filter((entry) => isUnder(entry.path));
    if (sources.length === 0) throw notThere(from);
    const isFolder = !state.tree.has(from);
    if (state.tree.has(to) || [...state.tree.keys()].some((p) => p.startsWith(`${to}/`))) {
      throw exists(to);
    }

    const moved = new Set(sources.map((entry) => entry.path));
    const index = new RoomTreeIndex([...state.tree.keys()].filter((p) => !moved.has(p)));
    const changes: RoomFileChange[] = [];
    const writes: RoomFileChange[] = [];
    for (const entry of sources) {
      if (entry.mode === SYMLINK_MODE || entry.mode === GITLINK_MODE) {
        assertOrdinaryFile(entry.path, entry);
      }
      const target = `${to}${entry.path.slice(from.length)}`;
      assertWritablePath(target);
      index.assertPlaceable(target);
      index.add(target);
      await assertNotIgnored(state.repoDir, state.ceiling, target);
      await assertNoLinkOnDisk(state.repoDir, entry.path);
      await assertNoLinkOnDisk(state.repoDir, target);
      changes.push({ path: entry.path, content: null, existed: true });
      writes.push({
        path: target,
        // Read when it is written, one at a time — never the whole folder at once.
        content: { blob: entry.sha, size: entry.size },
        existed: false,
        executable: isExecutable(entry),
      });
    }
    changes.push(...writes);
    assertFits(changes, state.tree, state.caps);

    const fromLabel = isFolder ? `${from}/` : from;
    const toLabel = isFolder ? `${to}/` : to;
    return view.commitAndAnnounce(roomId, actor, state, changes, {
      subject: `Rename ${fromLabel} to ${toLabel}`,
      kind: 'rename',
      paths: writes.map((change) => change.path),
      from: fromLabel,
      target: toLabel,
    });
  });
}

/**
 * Delete one file or folder, as one commit.
 *
 * Every path under it must be unchanged since `baseCommit` — nobody deletes a
 * file they have not seen. The room's history keeps what was deleted: it is a
 * commit, so an agent or git can bring it back.
 *
 * @param roomId - The room.
 * @param actor - Who is asking.
 * @param input.path - The file or folder.
 * @param input.baseCommit - What the person's view was read at.
 * @returns The change, or the conflict that stopped it.
 */
export async function remove(
  editorOwner: object,
  roomId: string,
  actor: RoomFileActor,
  input: { path: string; baseCommit: string }
): Promise<RoomFileChangeOutcome> {
  const view = readOriginalRoomEditorView(editorOwner);
  view.assertCanChange(roomId, actor);
  const requested = requireFilePath(input.path);

  return view.underLock(roomId, async (state) => {
    const target = new RoomTreeIndex(state.tree.keys()).canonicalize(requested);
    // Always locked: nobody deletes a file they have not seen.
    const isUnder = (p: string): boolean => p === target || p.startsWith(`${target}/`);
    const stale = await view.lockConflict(roomId, state, input.baseCommit, isUnder, target);
    if (stale) return { status: 'conflict' as const, conflict: stale };

    const doomed = [...state.tree.values()].filter((entry) => isUnder(entry.path));
    if (doomed.length === 0) throw notThere(target);
    const changes: RoomFileChange[] = [];
    for (const entry of doomed) {
      // A link is removed, never followed; another repository is refused.
      if (entry.mode === GITLINK_MODE) assertOrdinaryFile(entry.path, entry);
      await assertNoLinkOnDisk(state.repoDir, entry.path, entry.mode === SYMLINK_MODE);
      changes.push({ path: entry.path, content: null, existed: true });
    }

    const label = state.tree.has(target) ? target : `${target}/`;
    return view.commitAndAnnounce(roomId, actor, state, changes, {
      subject: `Delete ${label}`,
      kind: 'delete',
      paths: changes.map((change) => change.path),
      target: label,
    });
  });
}
