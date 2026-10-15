import type { RoomUploadStorageEngine } from './upload/room-upload-storage-contracts.js';
import { createOriginalRoomEditorPublicOperations } from './file-editor/room-file-editor-public-operations.js';
import * as editorRequestLifetime from './file-editor/room-file-editor-request-lifetime.js';
import * as editorUploadStage from './file-editor/room-file-editor-upload-stage.js';
import * as editorSave from './file-editor/room-file-editor-save.js';
import * as editorFileMutations from './file-editor/room-file-editor-file-mutations.js';
import * as editorCommit from './file-editor/room-file-editor-commit.js';
import * as editorCurrentState from './file-editor/room-file-editor-current-state.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { restoreRoomFileUploadCause } from './room-file-upload-storage.js';
import {
  checkDocHttpRoomFileWriteCurrent,
  requireDocHttpRoomFileWriteCurrent,
} from '../../canvas/doc-channel/http-composition.js';
import {
  readInstallationRoomFileWriteOwner,
  requireInstallationRoomNamespaceCurrent,
  readInstallationRoomMutationRoots,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';
import type { InstallationFileWrites } from '../../canvas/doc-channel/writes/installation-file-writes.js';
import type { RoomRepoCaps } from '@dorkos/shared/room-repo';
import type { RoomFileCommit, RoomFileConflict } from '@dorkos/shared/room-files';
import { type RoomFileChangeEvent } from '@dorkos/shared/room-schemas';
import { RoomError } from '../data/room-errors.js';
import type { GitIdentity } from './room-repo-git.js';
import { type RoomFileChange } from './room-file-ops.js';
/**
 * A person changing a room's files (spec `project-rooms` §3.10, widened by
 * `agent-home-desk` §7): saving a text file, uploading files, renaming or
 * moving, deleting, and keeping a chat attachment as one of the room's files.
 *
 * The room's integration tree has one writer, and until now that writer only
 * ever merged. This is the second thing it does: **every change is one commit,
 * authored as the person who made it, made in `repo/` under the same queue a
 * merge takes, and announced by one quiet room entry.** An agent has a working
 * copy and a merge for this; a person has the app and these routes, and neither
 * can write where the other does.
 *
 * How a change LANDS — the path checks, the change set, the rollback — lives in
 * `room-file-ops.ts`, shared by all five. This module decides who may ask, what
 * each operation changes, and what the room is told.
 *
 * ## The lock is about the FILES, not about the room
 *
 * A change carries the commit the person's view was read at (`baseCommit`). The
 * obvious check — refuse if `main` moved — is the wrong one: `main` moves every
 * time anybody merges anything, so a room with active agents would refuse most
 * changes for a reason that has nothing to do with them. So the question asked
 * is narrower and is the one that matters: **did any path this change touches
 * change between the commit the person read and the commit `main` points at
 * now?** A save locks its file, a move and a delete every file under the path, an
 * upload the files it was told it may replace.
 *
 * That refusal carries a payload, so it is a RESULT rather than a `RoomError`,
 * exactly as `ROOM_REPO_EXISTS` is. See {@link RoomFileSaveOutcome}.
 *
 * ## Who the commit is authored as
 *
 * With login on, the signed-in person: their display name and
 * `person-<authorId>@dorkos.local`, so two people get two authors and no real
 * address lands in history. With login off, the operator, as it always was. A
 * name git refuses falls back ({@link gitAuthorName}). Names shown anywhere come
 * from the room entry, never from git.
 *
 * @module server/services/rooms/repo/room-file-editor
 */

import type {
  RoomFileSaveOutcome,
  RoomFileChangeOutcome,
  RoomFileActor,
  RoomFileUploadItem,
  RoomFileEditorDeps,
  MainState,
  EditorLegacy,
  UploadStage,
  EditorOperation,
  EditorCommands,
  OriginalRoomEditorView,
} from './file-editor/room-file-editor-contracts.js';
export type {
  RoomFileSaveOutcome,
  RoomFileChangeOutcome,
  RoomFileActor,
  RoomFileUploadItem,
  RoomFileAnnouncement,
  RoomFileEditorDeps,
} from './file-editor/room-file-editor-contracts.js';
const editorViewGet = WeakMap.prototype.get;
const editorViewSet = WeakMap.prototype.set;
const editorViewApply = Reflect.apply;
const editorViewFreeze = Object.freeze;
const originalRoomEditorPublicKey = editorViewFreeze({});
const originalRoomEditorViews = new WeakMap<object, OriginalRoomEditorView>();
/** Require the actual constructor-private selector before reaching editor effects. */
export function readOriginalRoomEditorView(editorOwner: object): OriginalRoomEditorView {
  const view: OriginalRoomEditorView | undefined = editorViewApply(
    editorViewGet,
    originalRoomEditorViews,
    [editorOwner]
  );
  if (!view) throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  return view;
}
const editors = new WeakMap<RoomFileEditor, EditorCommands>();
const editorOperations = new WeakMap<object, EditorOperation>();
/** Select only the original constructor-registered editor commands. */
export function readOriginalRoomEditorCommands(
  publicOwner: object,
  editor: RoomFileEditor
): EditorCommands {
  if (publicOwner !== originalRoomEditorPublicKey)
    throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  const actual = editors.get(editor);
  if (!actual) throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  return actual;
}
/** Original native editor operations capture only the inaccessible module-private selector. */
export const {
  requireRoomFileEditorOwner,
  createRoomFileEditorUploadStorage,
  requireRoomFileEditorUploadStorageOwner,
  readRoomFileEditorUploadLimit,
  requireRoomFileEditorUploadCurrent,
  checkRoomFileEditorUploadCurrent,
  requireRoomFileEditorUploadCleanup,
  checkRoomFileEditorUploadCleanup,
  requireRoomFileEditorUploadSourceContext,
  captureRoomFileEditorHttpOperation,
  requireRoomFileEditorHttpCurrent,
  retireRoomFileEditorHttpOperation,
  executeRoomFileSave,
  executeRoomFilePrepareUpload,
  executeRoomFileUpload,
  executeRoomFileAttachment,
  executeRoomFileMove,
  executeRoomFileRemove,
} = createOriginalRoomEditorPublicOperations(originalRoomEditorPublicKey);

/** Changing a room's `main`, as the person who asked. */
export class RoomFileEditor {
  readonly #methodOwner = editorViewFreeze({});
  readonly #deps: RoomFileEditorDeps;
  readonly #owner?: InstallationFileWrites;
  readonly #operation = new AsyncLocalStorage<EditorOperation>();
  constructor(deps: RoomFileEditorDeps) {
    this.#deps = Object.freeze({ ...deps });
    this.#owner = deps.installationRoomWrites
      ? readInstallationRoomFileWriteOwner(deps.installationRoomWrites, deps.store, deps.mutex)
      : undefined;
    const createOriginalView = (editor: RoomFileEditor): Readonly<OriginalRoomEditorView> =>
      editorViewFreeze<OriginalRoomEditorView>({
        runtime: editor,
        get deps() {
          return editor.#deps;
        },
        get owner() {
          return editor.#owner;
        },
        get operation() {
          return editor.#operation;
        },
        get editorOperations() {
          return editorOperations;
        },
        get capture() {
          const fn = editor.#capture;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get retire() {
          const fn = editor.#retire;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get current() {
          const fn = editor.#current;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get dispatch() {
          const fn = editor.#dispatch;
          return <T>(...args: Parameters<typeof fn<T>>) => editorViewApply(fn, editor, args);
        },
        get stage() {
          const fn = editor.#stage;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get storage() {
          const fn = editor.#storage;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get checkStorage() {
          const fn = editor.#checkStorage;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get checkStageIdentity() {
          const fn = editor.#checkStageIdentity;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get discardOwnedStaging() {
          const fn = editor.#discardOwnedStaging;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get save() {
          const fn = editor.#save;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get prepareUpload() {
          const fn = editor.#prepareUpload;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get upload() {
          const fn = editor.#upload;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get saveAttachment() {
          const fn = editor.#saveAttachment;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get move() {
          const fn = editor.#move;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get remove() {
          const fn = editor.#remove;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get addFiles() {
          const fn = editor.#addFiles;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get commitAndAnnounce() {
          const fn = editor.#commitAndAnnounce;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get post() {
          const fn = editor.#post;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get prequeue() {
          const fn = editor.#prequeue;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get assertCanChange() {
          const fn = editor.#assertCanChange;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get underLock() {
          const fn = editor.#underLock;
          return <T>(...args: Parameters<typeof fn<T>>) => editorViewApply(fn, editor, args);
        },
        get lockConflict() {
          const fn = editor.#lockConflict;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get conflictAt() {
          const fn = editor.#conflictAt;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get identityOf() {
          const fn = editor.#identityOf;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get displayNameOf() {
          const fn = editor.#displayNameOf;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get requireCaps() {
          const fn = editor.#requireCaps;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get resolveMain() {
          const fn = editor.#resolveMain;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get lastCommitOf() {
          const fn = editor.#lastCommitOf;
          return (...args: Parameters<typeof fn>) => editorViewApply(fn, editor, args);
        },
        get translatingGitAbsence() {
          const fn = editor.#translatingGitAbsence;
          return <T>(...args: Parameters<typeof fn<T>>) => editorViewApply(fn, editor, args);
        },
      });
    editorViewApply(editorViewSet, originalRoomEditorViews, [
      this.#methodOwner,
      createOriginalView(this),
    ]);
    editors.set(
      this,
      Object.freeze<EditorCommands>({
        requireOwner: (owner) => {
          if (
            this.#owner !== owner ||
            !this.#deps.installationRoomWrites ||
            readInstallationRoomFileWriteOwner(
              this.#deps.installationRoomWrites,
              this.#deps.store,
              this.#deps.mutex
            ) !== owner
          )
            throw new Error('Unknown original Room file editor owner.');
        },
        storage: (handle, directory) => this.#storage(handle, directory),
        storageOwner: (handle, directory) => {
          const stage = this.#current(handle).staging.get(directory);
          if (!stage?.minting || stage.storage)
            throw new Error('Not the original Editor storage minting turn.');
        },
        storageLimit: (handle, directory, storage) =>
          this.#stage(handle, directory, storage).stage.maxFileBytes,
        storageCurrent: (handle, directory, storage, req) => {
          this.#stage(handle, directory, storage, req);
          this.#current(handle);
        },
        storageCleanup: (handle, directory, storage, req) => {
          const { operation } = this.#stage(handle, directory, storage, req);
          if (!operation.scope || !this.#deps.installationRoomWrites)
            throw new Error('No admitted upload cleanup scope.');
          requireInstallationRoomNamespaceCurrent(
            this.#deps.installationRoomWrites,
            operation.roomId,
            operation.scope
          );
        },
        storageSourceContext: (handle, directory, storage, context) => {
          const { operation } = this.#stage(handle, directory, storage);
          this.#current(handle);
          if (operation.context !== context)
            throw new Error('Upload source belongs to another original mutation context.');
        },
        storageCheck: (handle, directory, storage, req, cleanup) =>
          this.#checkStorage(handle, directory, storage, req, cleanup),
        capture: (roomId, req, res) => this.#capture(roomId, req, res),
        current: (handle) => this.#current(handle),
        retire: (handle) => this.#retire(handle),
        save: (handle, input) =>
          this.#dispatch(handle, () =>
            this.#save(this.#current(handle).roomId, this.#current(handle).actor, input)
          ),
        prepare: (handle) =>
          this.#dispatch(handle, () =>
            this.#prepareUpload(this.#current(handle).roomId, this.#current(handle).actor)
          ),
        upload: (handle, input) =>
          this.#dispatch(handle, () =>
            this.#upload(this.#current(handle).roomId, this.#current(handle).actor, input)
          ),
        attachment: (handle, input) =>
          this.#dispatch(handle, () =>
            this.#saveAttachment(this.#current(handle).roomId, this.#current(handle).actor, input)
          ),
        move: (handle, input) =>
          this.#dispatch(handle, () =>
            this.#move(this.#current(handle).roomId, this.#current(handle).actor, input)
          ),
        remove: (handle, input) =>
          this.#dispatch(handle, () =>
            this.#remove(this.#current(handle).roomId, this.#current(handle).actor, input)
          ),
      })
    );
  }
  // Legacy DTO calls remain unavailable: only fixed request-local operations enter native bodies.
  save(..._args: Parameters<EditorLegacy['save']>): Promise<RoomFileSaveOutcome> {
    return Promise.reject(new RoomError('ROOM_NOT_FOUND', 'No such room.'));
  }
  prepareUpload(
    ..._args: Parameters<EditorLegacy['prepareUpload']>
  ): Promise<{ maxFileBytes: number; stagingDir: string }> {
    return Promise.reject(new RoomError('ROOM_NOT_FOUND', 'No such room.'));
  }
  upload(..._args: Parameters<EditorLegacy['upload']>): Promise<RoomFileChangeOutcome> {
    return Promise.reject(new RoomError('ROOM_NOT_FOUND', 'No such room.'));
  }
  saveAttachment(
    ..._args: Parameters<EditorLegacy['saveAttachment']>
  ): Promise<RoomFileChangeOutcome> {
    return Promise.reject(new RoomError('ROOM_NOT_FOUND', 'No such room.'));
  }
  move(..._args: Parameters<EditorLegacy['move']>): Promise<RoomFileChangeOutcome> {
    return Promise.reject(new RoomError('ROOM_NOT_FOUND', 'No such room.'));
  }
  remove(..._args: Parameters<EditorLegacy['remove']>): Promise<RoomFileChangeOutcome> {
    return Promise.reject(new RoomError('ROOM_NOT_FOUND', 'No such room.'));
  }
  discardUpload(_stagingDir: string): Promise<void> {
    return Promise.reject(new RoomError('ROOM_NOT_FOUND', 'No such room.'));
  }
  assertCanChange(_roomId: string, _actor: RoomFileActor): void {
    throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  }
  #current(handle: object): EditorOperation {
    const operation = editorOperations.get(handle);
    if (!operation?.active || operation.editor !== this || !this.#owner || !operation.context)
      throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
    requireDocHttpRoomFileWriteCurrent(this.#owner, operation.roomId, operation.caller);
    readInstallationRoomMutationRoots(operation.context);
    return operation;
  }
  #capture(roomId: string, req: IncomingMessage, res: ServerResponse): Promise<object> {
    return editorRequestLifetime.capture(this.#methodOwner, roomId, req, res);
  }
  async #dispatch<T>(handle: object, work: () => Promise<T>): Promise<T> {
    const operation = this.#current(handle);
    return this.#operation.run(operation, async () => {
      await checkDocHttpRoomFileWriteCurrent(this.#owner!, operation.roomId, operation.caller);
      this.#current(handle);
      try {
        const result = await work();
        await checkDocHttpRoomFileWriteCurrent(this.#owner!, operation.roomId, operation.caller);
        this.#current(handle);
        return result;
      } catch (error) {
        let cause = error;
        for (const stage of operation.staging.values())
          if (stage.storage) cause = restoreRoomFileUploadCause(stage.storage, cause);
        throw cause;
      }
    });
  }
  #retire(handle: object): Promise<void> {
    return editorRequestLifetime.retire(this.#methodOwner, handle);
  }
  #stage(
    handle: object,
    directory: string,
    storage: RoomUploadStorageEngine,
    req?: IncomingMessage
  ): { operation: EditorOperation; stage: UploadStage } {
    return editorUploadStage.stage(this.#methodOwner, handle, directory, storage, req);
  }
  #storage(handle: object, directory: string): RoomUploadStorageEngine {
    return editorUploadStage.storage(this.#methodOwner, handle, directory);
  }
  #checkStorage(
    handle: object,
    directory: string,
    storage: RoomUploadStorageEngine,
    req: IncomingMessage,
    cleanup: boolean
  ): Promise<void> {
    return editorUploadStage.checkStorage(
      this.#methodOwner,
      handle,
      directory,
      storage,
      req,
      cleanup
    );
  }
  #checkStageIdentity(operation: EditorOperation, directory: string): Promise<void> {
    return editorUploadStage.checkStageIdentity(this.#methodOwner, operation, directory);
  }
  #discardOwnedStaging(operation: EditorOperation, directory: string): Promise<void> {
    return editorUploadStage.discardOwnedStaging(this.#methodOwner, operation, directory);
  }

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
  #save(
    roomId: string,
    actor: RoomFileActor,
    input: { path: string; baseCommit: string | null; text: string }
  ): Promise<RoomFileSaveOutcome> {
    return editorSave.save(this.#methodOwner, roomId, actor, input);
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
  #prepareUpload(
    roomId: string,
    actor: RoomFileActor
  ): Promise<{ maxFileBytes: number; stagingDir: string }> {
    return editorSave.prepareUpload(this.#methodOwner, roomId, actor);
  }

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
  #upload(
    roomId: string,
    actor: RoomFileActor,
    input: {
      dir: string;
      baseCommit: string | null;
      replace: readonly string[];
      files: readonly RoomFileUploadItem[];
    }
  ): Promise<RoomFileChangeOutcome> {
    return editorFileMutations.upload(this.#methodOwner, roomId, actor, input);
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
  #saveAttachment(
    roomId: string,
    actor: RoomFileActor,
    input: { dir: string; name: string; baseCommit: string | null; bytes: Buffer }
  ): Promise<RoomFileChangeOutcome> {
    return editorFileMutations.saveAttachment(this.#methodOwner, roomId, actor, input);
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
  #move(
    roomId: string,
    actor: RoomFileActor,
    input: { from: string; to: string; baseCommit: string }
  ): Promise<RoomFileChangeOutcome> {
    return editorFileMutations.move(this.#methodOwner, roomId, actor, input);
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
  #remove(
    roomId: string,
    actor: RoomFileActor,
    input: { path: string; baseCommit: string }
  ): Promise<RoomFileChangeOutcome> {
    return editorFileMutations.remove(this.#methodOwner, roomId, actor, input);
  }

  /**
   * The shared body of an upload and a save-from-the-chat: new files into one
   * folder, as one commit.
   *
   * @param roomId - The room.
   * @param actor - Who is asking.
   * @param input - The folder, the lock, what may be replaced, and the files.
   */
  #addFiles(
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
    return editorCommit.addFiles(this.#methodOwner, roomId, actor, input);
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
  #commitAndAnnounce(
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
    return editorCommit.commitAndAnnounce(this.#methodOwner, roomId, actor, state, changes, what);
  }

  /**
   * Post the one quiet entry a committed change gets.
   *
   * @param roomId - The room.
   * @param actor - Who made the change.
   * @param change - What it changed.
   * @param target - The folder or path the sentence names, where it names one.
   */
  #post(
    roomId: string,
    actor: RoomFileActor,
    change: { kind: RoomFileChangeEvent['kind']; paths: string[]; commit: string; from?: string },
    target = change.paths[0] ?? ''
  ): void {
    return editorCommit.post(this.#methodOwner, roomId, actor, change, target);
  }

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
  #prequeue(roomId: string, caller: object): void {
    return editorCurrentState.prequeue(this.#methodOwner, roomId, caller);
  }
  #assertCanChange(roomId: string, actor: RoomFileActor): void {
    return editorCurrentState.assertCanChange(this.#methodOwner, roomId, actor);
  }

  /**
   * Run a change in the room's lane — the same queue a merge takes — with
   * `main` checked clean and read.
   *
   * @param roomId - The room.
   * @param work - The change, handed what `main` holds now.
   */
  #underLock<T>(roomId: string, work: (state: MainState) => Promise<T>): Promise<T> {
    return editorCurrentState.underLock(this.#methodOwner, roomId, work);
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
  #lockConflict(
    roomId: string,
    state: MainState,
    baseCommit: string,
    isLocked: (filePath: string) => boolean,
    fallbackPath: string
  ): Promise<RoomFileConflict | null> {
    return editorCurrentState.lockConflict(
      this.#methodOwner,
      roomId,
      state,
      baseCommit,
      isLocked,
      fallbackPath
    );
  }

  /**
   * The conflict payload for one path: where `main` is now, and who last
   * touched the path there.
   *
   * @param roomId - The room.
   * @param state - What `main` holds.
   * @param filePath - The path that moved.
   */
  #conflictAt(roomId: string, state: MainState, filePath: string): Promise<RoomFileConflict> {
    return editorCurrentState.conflictAt(this.#methodOwner, roomId, state, filePath);
  }

  /**
   * Who a commit is authored as — the §7.1 rule, in one place.
   *
   * @param actor - Who made the change.
   */
  #identityOf(actor: RoomFileActor): GitIdentity {
    return editorCurrentState.identityOf(this.#methodOwner, actor);
  }

  /**
   * The name the room entry opens with.
   *
   * @param actor - Who made the change.
   */
  #displayNameOf(actor: RoomFileActor): string {
    return editorCurrentState.displayNameOf(this.#methodOwner, actor);
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
  #requireCaps(roomId: string): Promise<RoomRepoCaps> {
    return editorCurrentState.requireCaps(this.#methodOwner, roomId);
  }

  /**
   * The commit `main` points at, or `null` when the repo has no commits.
   *
   * @param repoDir - The room's main checkout.
   * @param ceiling - The room home directory git's search may not climb past.
   */
  #resolveMain(repoDir: string, ceiling: string): Promise<string | null> {
    return editorCurrentState.resolveMain(this.#methodOwner, repoDir, ceiling);
  }

  /**
   * Who last touched a path, in the shape a read answers it.
   *
   * @param roomId - The room.
   * @param filePath - The path.
   * @returns The commit, or `null` when it cannot be attributed.
   */
  #lastCommitOf(roomId: string, filePath: string): Promise<RoomFileCommit | null> {
    return editorCurrentState.lastCommitOf(this.#methodOwner, roomId, filePath);
  }

  /**
   * Turn "this machine has no git" into the room domain's own refusal — the
   * same sentence every other room-repo surface gives.
   *
   * @param work - The git-touching body.
   * @returns Whatever `work` answers.
   */
  #translatingGitAbsence<T>(work: () => Promise<T>): Promise<T> {
    return editorCurrentState.translatingGitAbsence(this.#methodOwner, work);
  }
}
