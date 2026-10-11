import { readOriginalRoomEditorView } from '../room-file-editor.js';
import path from 'node:path';
import {
  readInstallationRoomMutationRoots,
  requireInstallationRoomMutationTarget,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { ROOM_FILE_CHANGE_MAX_PATHS, type RoomFileChangeEvent } from '@dorkos/shared/room-schemas';
import { RoomError } from '../../data/room-errors.js';
import { normalizeRoomFilePath } from '../room-files.js';
import { fileChangeSentence, ROOT_FOLDER_LABEL } from './room-file-change-text.js';
import {
  assertFits,
  assertNoLinkOnDisk,
  assertNotIgnored,
  assertOrdinaryFile,
  assertWritablePath,
  commitChangeSet,
  describeCommit,
  RoomTreeIndex,
  type RoomFileChange,
} from '../room-file-ops.js';
import type {
  RoomFileChangeOutcome,
  RoomFileActor,
  RoomFileUploadItem,
  MainState,
} from './room-file-editor-contracts.js';
import { requireFileName, exists, basenameOf, plural } from './room-file-editor-path-data.js';

/**
 * The shared body of an upload and a save-from-the-chat: new files into one
 * folder, as one commit.
 *
 * @param roomId - The room.
 * @param actor - Who is asking.
 * @param input - The folder, the lock, what may be replaced, and the files.
 */
export function addFiles(
  editorOwner: object,
  roomId: string,
  actor: RoomFileActor,
  input: {
    dir: string;
    baseCommit: string | null;
    replace: readonly string[];
    files: readonly RoomFileUploadItem[];
    kind: 'upload' | 'from-attachment';
  }
): Promise<RoomFileChangeOutcome> {
  const view = readOriginalRoomEditorView(editorOwner);
  const requestedDir = normalizeRoomFilePath(input.dir);
  const replace = new Set(input.replace.map((name) => name.normalize('NFC')));
  const requested = input.files.map((file) => {
    const name = requireFileName(file.name);
    const filePath = requestedDir === '' ? name : `${requestedDir}/${name}`;
    assertWritablePath(filePath);
    return { path: filePath, content: file.content };
  });

  return view.underLock(roomId, async (state) => {
    const index = new RoomTreeIndex(state.tree.keys());
    const dir = requestedDir === '' ? '' : index.canonicalize(requestedDir);
    // Every target in the tree's own spelling, so a name that is the same
    // file under another Unicode spelling is found rather than overwritten.
    const targets = requested.map((target) => {
      const filePath = index.canonicalize(target.path);
      return { path: filePath, name: basenameOf(filePath), content: target.content };
    });
    const seen = new Set<string>();
    for (const target of targets) {
      if (seen.has(target.path)) {
        throw new RoomError(
          'ROOM_FILE_PATH_INVALID',
          `\`${target.path}\` is in this upload twice. Give one of them another name.`
        );
      }
      seen.add(target.path);
    }
    const replaced = new Set(
      targets
        .filter((target) => replace.has(target.name.normalize('NFC')))
        .map((target) => target.path)
    );
    if (input.baseCommit !== null && replaced.size > 0) {
      const first = [...replaced].sort()[0] as string;
      const stale = await view.lockConflict(
        roomId,
        state,
        input.baseCommit,
        (p) => replaced.has(p),
        first
      );
      if (stale) return { status: 'conflict' as const, conflict: stale };
    }

    const changes: RoomFileChange[] = [];
    for (const target of targets) {
      const existing = state.tree.get(target.path) ?? null;
      if (existing) {
        if (!replaced.has(target.path)) throw exists(target.path);
        if (input.baseCommit === null) {
          return {
            status: 'conflict' as const,
            conflict: await view.conflictAt(roomId, state, target.path),
          };
        }
        assertOrdinaryFile(target.path, existing);
      } else {
        index.assertPlaceable(target.path);
        index.add(target.path);
      }
      await assertNotIgnored(state.repoDir, state.ceiling, target.path);
      await assertNoLinkOnDisk(state.repoDir, target.path);
      changes.push({ path: target.path, content: target.content, existed: existing !== null });
    }
    assertFits(changes, state.tree, state.caps);

    const paths = changes.map((change) => change.path);
    const dirLabel = dir === '' ? '' : `${dir}/`;
    const subject =
      input.kind === 'from-attachment'
        ? `Add ${paths[0]} from the chat`
        : `Upload ${plural(paths.length, 'file')} to ${dirLabel === '' ? ROOT_FOLDER_LABEL : dirLabel}`;
    return view.commitAndAnnounce(roomId, actor, state, changes, {
      subject,
      kind: input.kind,
      paths,
      target: dirLabel,
    });
  });
}

/**
 * Commit a checked change set, announce it, and answer.
 *
 * @param roomId - The room.
 * @param actor - Who made the change.
 * @param state - What `main` held when the change was checked.
 * @param changes - The change set.
 * @param what - The commit subject and what the room entry says.
 */
export async function commitAndAnnounce(
  editorOwner: object,
  roomId: string,
  actor: RoomFileActor,
  state: MainState,
  changes: RoomFileChange[],
  what: {
    subject: string;
    kind: RoomFileChangeEvent['kind'];
    paths: string[];
    from?: string;
    target: string;
  }
): Promise<RoomFileChangeOutcome> {
  const view = readOriginalRoomEditorView(editorOwner);
  const committed = await commitChangeSet(
    state.repoDir,
    state.ceiling,
    changes,
    what.subject,
    view.identityOf(actor),
    state.context
  );
  const paths = [...what.paths].sort();
  if (committed) {
    view.post(
      roomId,
      actor,
      {
        kind: what.kind,
        paths,
        commit: committed,
        ...(what.from !== undefined ? { from: what.from } : {}),
      },
      what.target
    );
  }
  return {
    status: 'changed',
    result: {
      commit: committed ?? state.head ?? '',
      paths,
      lastCommit: committed
        ? await describeCommit(state.repoDir, committed, state.ceiling)
        : await view.lastCommitOf(roomId, paths[0] as string),
    },
  };
}

/**
 * Post the one quiet entry a committed change gets.
 *
 * @param roomId - The room.
 * @param actor - Who made the change.
 * @param change - What it changed.
 * @param target - The folder or path the sentence names, where it names one.
 */
export function post(
  editorOwner: object,
  roomId: string,
  actor: RoomFileActor,
  change: { kind: RoomFileChangeEvent['kind']; paths: string[]; commit: string; from?: string },
  target = change.paths[0] ?? ''
): void {
  const view = readOriginalRoomEditorView(editorOwner);
  const fileChange: RoomFileChangeEvent = {
    kind: change.kind,
    paths: change.paths.slice(0, ROOM_FILE_CHANGE_MAX_PATHS),
    pathCount: change.paths.length,
    commit: change.commit,
    ...(change.from !== undefined ? { from: change.from } : {}),
    // The one thing `paths` cannot say: which folder a rename landed in, or
    // which folder a delete removed, whatever depth its files sat at.
    target,
  };
  // Past this line the change IS on main. If the entry cannot be written —
  // the room was archived in the window since the gate — it propagates, as a
  // merge's does: a change nobody was told about is worse news than an error.
  const operation = view.operation.getStore();
  if (!operation || !operation.context || !view.owner)
    throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  requireInstallationRoomMutationTarget(
    operation.context,
    readInstallationRoomMutationRoots(operation.context).repoPath
  );
  view.deps.announce(roomId, {
    text: fileChangeSentence(view.displayNameOf(actor), fileChange, target),
    fileChange,
    subjectAuthorId: actor.authorId,
  });
}
