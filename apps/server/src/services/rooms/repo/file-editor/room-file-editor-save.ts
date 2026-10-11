import { readOriginalRoomEditorView } from '../room-file-editor.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  checkDocHttpRoomFileWriteCurrent,
  requireDocHttpRoomFileWriteCurrent,
} from '../../../canvas/doc-channel/http-composition.js';
import {
  readInstallationRoomUploadStagingRoot,
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { RoomError } from '../../data/room-errors.js';
import {
  assertFits,
  assertNoLinkOnDisk,
  assertNotIgnored,
  assertOrdinaryFile,
  assertText,
  commitChangeSet,
  RoomTreeIndex,
  type RoomFileChange,
} from '../room-file-ops.js';
import type { RoomFileSaveOutcome, RoomFileActor } from './room-file-editor-contracts.js';
import { requireFilePath } from './room-file-editor-path-data.js';

/**
 * Save one text file into the room's `main`, as one commit. Missing folders
 * above it are created.
 *
 * Authorization is answered before the queue and git state inside it — the
 * same ordering `RoomMergeService.merge` writes down: who may save does not
 * change while a caller waits, while everything git can say does.
 *
 * @param roomId - The room whose files are being edited.
 * @param actor - Who is asking. Must be a person on the roster.
 * @param input.path - The file, relative to the repo root.
 * @param input.baseCommit - The commit the editor read the file at, or `null`
 *   when the file is being created.
 * @param input.text - The file's whole new contents.
 * @returns The save, or the conflict that stopped it.
 * @throws {RoomError} `ROOM_REPOS_DISABLED`, `ROOM_NOT_FOUND`,
 *   `ROOM_ARCHIVED`, `PEOPLE_ONLY`, `ROOM_HAS_NO_REPO`,
 *   `ROOM_FILE_PATH_INVALID`, `ROOM_FILE_NOT_FOUND`,
 *   `ROOM_FILE_NOT_READABLE`, `ROOM_FILE_NOT_TEXT`, `FILE_TOO_LARGE`,
 *   `REPO_CAP_EXCEEDED`, `MAIN_CHECKOUT_DIRTY`, `MERGE_IN_FLIGHT`, or
 *   `ROOM_REPO_GIT_UNAVAILABLE`.
 */
export async function save(
  editorOwner: object,
  roomId: string,
  actor: RoomFileActor,
  input: { path: string; baseCommit: string | null; text: string }
): Promise<RoomFileSaveOutcome> {
  const view = readOriginalRoomEditorView(editorOwner);
  view.assertCanChange(roomId, actor);
  const requested = requireFilePath(input.path);

  return view.underLock(roomId, async (state) => {
    const index = new RoomTreeIndex(state.tree.keys());
    // The tree's own spelling of what was asked for — see
    // {@link RoomTreeIndex.canonicalize} for the NFD/NFC overwrite this closes.
    const filePath = index.canonicalize(requested);
    const existing = state.tree.get(filePath) ?? null;

    // **The lock is asked FIRST when the editor said what it read.** A stale
    // save whose file — or whose whole folder — was deleted by somebody else
    // needs the reload / keep-mine choice, not a sentence about paths (found
    // in review). With no `baseCommit` the caller is creating a file and has
    // made no claim about the room's state, so the path checks answer first.
    if (input.baseCommit !== null) {
      const stale = await view.lockConflict(
        roomId,
        state,
        input.baseCommit,
        (p) => p === filePath,
        filePath
      );
      if (stale) return { status: 'conflict' as const, conflict: stale };
    }

    if (existing) assertOrdinaryFile(filePath, existing);
    else index.assertPlaceable(filePath);
    await assertNotIgnored(state.repoDir, state.ceiling, filePath);

    if (input.baseCommit === null && existing) {
      // The editor thought it was creating this file and the room now holds
      // one: somebody got there first.
      return {
        status: 'conflict' as const,
        conflict: await view.conflictAt(roomId, state, filePath),
      };
    }

    const bytes = Buffer.from(input.text, 'utf-8');
    assertText(filePath, bytes);
    const change: RoomFileChange = { path: filePath, content: bytes, existed: existing !== null };
    assertFits([change], state.tree, state.caps);
    await assertNoLinkOnDisk(state.repoDir, filePath);

    const kind = existing ? 'edit' : 'add';
    const committed = await commitChangeSet(
      state.repoDir,
      state.ceiling,
      [change],
      `${existing ? 'Edit' : 'Add'} ${filePath}`,
      view.identityOf(actor),
      state.context
    );
    if (committed) {
      view.post(roomId, actor, { kind, paths: [filePath], commit: committed });
    }
    // `head` is only ever `null` for a repo with no commits, and a save into
    // one always commits — so the fallback is unreachable except where
    // `committed` is a real sha.
    return {
      status: 'saved' as const,
      result: {
        path: filePath,
        commit: committed ?? state.head ?? '',
        size: bytes.length,
        committed: committed !== null,
        lastCommit: await view.lastCommitOf(roomId, filePath),
      },
    };
  });
}

/**
 * Refuse an upload before any of its bytes are read, and give the route what
 * it needs to read them: the room's own file ceiling and a staging folder of
 * this request's own.
 *
 * Fixed request retirement joins the selected storage/FD lifetime, then
 * removes only this identity-matching empty stage. Unsafe cleanup refuses.
 *
 * @param roomId - The room.
 * @param actor - Who is asking.
 * @returns The per-file ceiling and the staging folder.
 * @throws {RoomError} Every refusal {@link save} answers before the queue.
 */
export async function prepareUpload(
  editorOwner: object,
  roomId: string,
  actor: RoomFileActor
): Promise<{ maxFileBytes: number; stagingDir: string }> {
  const view = readOriginalRoomEditorView(editorOwner);
  view.assertCanChange(roomId, actor);
  const operation = view.operation.getStore();
  if (!operation?.context || !view.owner) throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  const caps = await view.requireCaps(roomId);
  const fixed = readInstallationRoomUploadStagingRoot(operation.context);
  const installation = path.dirname(path.dirname(fixed.root));
  if ((await fs.realpath(installation)) !== fixed.canonicalInstallation)
    throw new Error('Original upload installation root changed.');
  const check = async () => {
    await checkDocHttpRoomFileWriteCurrent(view.owner!, roomId, operation.caller);
    await checkInstallationRoomMutationTarget(
      operation.context!,
      readInstallationRoomMutationRoots(operation.context!).repoPath
    );
  };
  const ancestors: { directory: string; dev: bigint; ino: bigint }[] = [];
  for (const directory of [path.dirname(fixed.root), fixed.root]) {
    await check();
    const parent = await fs.lstat(path.dirname(directory), { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink())
      throw new Error('Upload staging parent is not an ordinary directory.');
    let present = false;
    let entryIdentity: { dev: bigint; ino: bigint } | undefined;
    try {
      const entry = await fs.lstat(directory, { bigint: true });
      present = true;
      entryIdentity = { dev: entry.dev, ino: entry.ino };
      if (!entry.isDirectory() || entry.isSymbolicLink())
        throw new Error('Upload staging root is not an ordinary directory.');
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
    await check();
    const current = await fs.lstat(path.dirname(directory), { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== parent.dev ||
      current.ino !== parent.ino
    )
      throw new Error('Upload staging parent identity changed.');
    if (entryIdentity) {
      const finalEntry = await fs.lstat(directory, { bigint: true });
      if (
        !finalEntry.isDirectory() ||
        finalEntry.isSymbolicLink() ||
        finalEntry.dev !== entryIdentity.dev ||
        finalEntry.ino !== entryIdentity.ino
      )
        throw new Error('Upload staging directory identity changed.');
    }
    requireDocHttpRoomFileWriteCurrent(view.owner, roomId, operation.caller);
    readInstallationRoomMutationRoots(operation.context);
    ancestors.push({ directory: path.dirname(directory), dev: parent.dev, ino: parent.ino });
    if (!present) await fs.mkdir(directory);
    if (
      (await fs.realpath(directory)) !==
      path.join(fixed.canonicalInstallation, path.relative(installation, directory))
    )
      throw new Error('Upload staging directory escaped the original installation.');
  }
  const parent = await fs.lstat(fixed.root, { bigint: true });
  await check();
  const current = await fs.lstat(fixed.root, { bigint: true });
  if (
    !current.isDirectory() ||
    current.isSymbolicLink() ||
    current.dev !== parent.dev ||
    current.ino !== parent.ino
  )
    throw new Error('Upload staging root identity changed.');
  // Identity is checked before mkdtemp; the unavoidable external check/effect race remains.
  requireDocHttpRoomFileWriteCurrent(view.owner, roomId, operation.caller);
  readInstallationRoomMutationRoots(operation.context);
  const stagingDir = await fs.mkdtemp(path.join(fixed.root, 'upload-'));
  const identity = await fs.lstat(stagingDir, { bigint: true });
  if (!identity.isDirectory() || identity.isSymbolicLink())
    throw new Error('Invalid upload staging directory.');
  operation.staging.set(stagingDir, {
    dev: identity.dev,
    ino: identity.ino,
    parentDev: parent.dev,
    parentIno: parent.ino,
    maxFileBytes: caps.maxFileBytes,
    ancestors: Object.freeze(ancestors.map((entry) => Object.freeze(entry))),
    minting: false,
  });
  await check();
  return { maxFileBytes: caps.maxFileBytes, stagingDir };
}
