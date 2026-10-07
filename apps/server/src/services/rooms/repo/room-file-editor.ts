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
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Request, Response } from 'express';
import type multer from 'multer';
import {
  createRoomFileUploadStorage,
  retireRoomFileUploadStorage,
  restoreRoomFileUploadCause,
} from './room-file-upload-storage.js';
import {
  captureDocHttpRoomFileWriteCaller,
  checkDocHttpRoomFileWriteCurrent,
  requireDocHttpRoomFileWriteCurrent,
  readDocHttpRoomFileWriteAttribution,
  retireDocHttpRoomFileWriteCaller,
} from '../../canvas/doc-channel/http-composition.js';
import {
  readInstallationRoomFileWriteOwner,
  withRecognizedInstallationRoomFileEditor,
  readInstallationRoomUploadStagingRoot,
  checkInstallationRoomScope,
  requireInstallationRoomNamespaceCurrent,
  readInstallationRoomHttpMutationContext,
  readInstallationRoomMutationRoots,
  checkInstallationRoomMutationTarget,
  requireInstallationRoomMutationTarget,
  type InstallationRoomWrites,
  type InstallationRoomMutationContext,
} from '../../canvas/doc-channel/writes/installation-room-writes.js';
import type { InstallationFileWrites } from '../../canvas/doc-channel/writes/installation-file-writes.js';

import type { RoomRepoCaps } from '@dorkos/shared/room-repo';
import type {
  RoomFileChangeResponse,
  RoomFileCommit,
  RoomFileConflict,
  RoomFileSaveResponse,
} from '@dorkos/shared/room-files';
import { ROOM_UPLOAD_MAX_FILES } from '@dorkos/shared/room-files';
import { ROOM_FILE_CHANGE_MAX_PATHS, type RoomFileChangeEvent } from '@dorkos/shared/room-schemas';
import { sanitizeIdentity } from '@dorkos/shared/untrusted-text';
import { logger } from '../../../lib/logger.js';
import { RoomError } from '../data/room-errors.js';
import { normalizeRoomFilePath } from './room-files.js';
import { fileChangeSentence, ROOT_FOLDER_LABEL, sanitizeSegment } from './room-file-change-text.js';
import type { RoomRepoStore } from './room-repo-store.js';
import type { RoomRepoMutex } from './room-repo-mutex.js';
import { assertMainCheckoutReady } from './room-main-checkout.js';
import {
  GITLINK_MODE,
  GitUnavailableError,
  gitAuthorName,
  listTree,
  OPERATOR_GIT_EMAIL,
  personGitEmail,
  revParse,
  SYMLINK_MODE,
  type GitIdentity,
  type TreeEntry,
} from './room-repo-git.js';
import {
  assertFits,
  assertNoLinkOnDisk,
  assertNotIgnored,
  assertOrdinaryFile,
  assertText,
  assertWritablePath,
  checkLockedPaths,
  commitChangeSet,
  describeCommit,
  isExecutable,
  RoomTreeIndex,
  type RoomFileChange,
  type RoomFileContent,
} from './room-file-ops.js';

/** What a save answers: it landed, or the file moved underneath it. */
export type RoomFileSaveOutcome =
  | { status: 'saved'; result: RoomFileSaveResponse }
  | { status: 'conflict'; conflict: RoomFileConflict };

/** What an upload, a move, a delete or a save-from-the-chat answers. */
export type RoomFileChangeOutcome =
  | { status: 'changed'; result: RoomFileChangeResponse }
  | { status: 'conflict'; conflict: RoomFileConflict };

/** Who is making a change, as the route resolved them. */
export interface RoomFileActor {
  /** Their room author id. */
  authorId: string;
  /**
   * Whether the request carried a signed-in session — login is on and this is
   * somebody's own account. `false` is the operator at the keyboard of an
   * install with login off.
   */
  signedIn: boolean;
}

/** One file an upload carries. */
export interface RoomFileUploadItem {
  /** The file name the person gave it — a name, never a path. */
  name: string;
  /** The bytes, staged on disk by the route. */
  content: RoomFileContent;
}

/** What {@link RoomFileEditor.announce} is handed for one committed change. */
export interface RoomFileAnnouncement {
  /** The sentence a person reads, composed from sanitized path segments. */
  text: string;
  /** The machine-readable half. */
  fileChange: RoomFileChangeEvent;
  /** The person who made the change. */
  subjectAuthorId: string;
}

/** The seams {@link RoomFileEditor} needs from the rest of the server. */
export interface RoomFileEditorDeps {
  /** Owns every path under a room's home; never construct one by hand. */
  store: RoomRepoStore;
  /** Same constructor-owned installation room writer; absent keeps mutations unavailable. */
  installationRoomWrites?: InstallationRoomWrites;
  /** The per-room serialized queue every write to `repo/` goes through. */
  mutex: RoomRepoMutex;
  /** `config.rooms.repo.enabled`, read per call. */
  enabled(): boolean;
  /** `config.rooms.repo.mergeQueueWaitMs`, read per call. */
  queueWaitMs(): number;
  /**
   * Refuse anybody who may not change a file in this room.
   *
   * `RoomService.assertCanWriteFiles` in production: a member, not archived,
   * and a person — an agent has its own working copy and a merge, and a second
   * write path into the integration tree is the one-writer rule undone.
   */
  assertCanWriteFiles(roomId: string, authorId: string): void;
  /**
   * The name an operator commit is authored under (login off), or `null` when
   * this install has no name for them yet. `RoomRepoService`'s own seam.
   */
  operatorGitName(): string | null;
  /**
   * A signed-in person's own name (login on), or `null` when there is none.
   *
   * For the owner that is their profile name — never the room registry's
   * `'You'`, which is right in their own window and bizarre in `git log`.
   */
  personName(authorId: string): string | null;
  /** Post the quiet entry for one committed change. `RoomService.postFileChangeEvent`. */
  announce(roomId: string, input: RoomFileAnnouncement): unknown;
  /**
   * The folder uploads are staged under — `<dorkHome>/.temp/room-uploads`.
   * Each request gets a folder of its own inside it, removed when it settles.
   */
  uploadStagingRoot(): string;
  /**
   * Who last touched a file — `RoomFilesService` in production, narrowed to the
   * one method a change needs, so a save's answer and an explorer row can never
   * describe one file two ways.
   */
  files: RoomFileProvenanceReader;
}

/** The one thing a change needs from the read side. */
interface RoomFileProvenanceReader {
  /**
   * Who last touched one file on `main`.
   *
   * @param roomId - The room.
   * @param filePath - The file, relative to the repo root.
   */
  lastCommitFor(roomId: string, filePath: string): Promise<RoomFileCommit | null>;
}

/** Everything one change reads before it decides anything, under the lock. */
interface MainState {
  repoDir: string;
  ceiling: string;
  caps: RoomRepoCaps;
  head: string | null;
  tree: Map<string, TreeEntry>;
  context: InstallationRoomMutationContext;
}

interface EditorLegacy {
  save(
    roomId: string,
    actor: RoomFileActor,
    input: { path: string; baseCommit: string | null; text: string }
  ): Promise<RoomFileSaveOutcome>;
  prepareUpload(
    roomId: string,
    actor: RoomFileActor
  ): Promise<{ maxFileBytes: number; stagingDir: string }>;
  upload(
    roomId: string,
    actor: RoomFileActor,
    input: {
      dir: string;
      baseCommit: string | null;
      replace: readonly string[];
      files: readonly RoomFileUploadItem[];
    }
  ): Promise<RoomFileChangeOutcome>;
  saveAttachment(
    roomId: string,
    actor: RoomFileActor,
    input: { dir: string; name: string; baseCommit: string | null; bytes: Buffer }
  ): Promise<RoomFileChangeOutcome>;
  move(
    roomId: string,
    actor: RoomFileActor,
    input: { from: string; to: string; baseCommit: string }
  ): Promise<RoomFileChangeOutcome>;
  remove(
    roomId: string,
    actor: RoomFileActor,
    input: { path: string; baseCommit: string }
  ): Promise<RoomFileChangeOutcome>;
}
interface UploadStage {
  dev: bigint;
  ino: bigint;
  parentDev: bigint;
  parentIno: bigint;
  maxFileBytes: number;
  ancestors: readonly Readonly<{ directory: string; dev: bigint; ino: bigint }>[];
  minting: boolean;
  storage?: multer.StorageEngine;
}
interface EditorOperation {
  editor: RoomFileEditor;
  request: Request;
  roomId: string;
  caller: object;
  actor: Readonly<RoomFileActor>;
  active: boolean;
  scope?: object;
  context?: InstallationRoomMutationContext;
  release(): void;
  draining: Promise<void>;
  staging: Map<string, UploadStage>;
}
interface EditorCommands {
  requireOwner(owner: InstallationFileWrites): void;
  storage(handle: object, directory: string): multer.StorageEngine;
  storageOwner(handle: object, directory: string): void;
  storageLimit(handle: object, directory: string, storage: multer.StorageEngine): number;
  storageCurrent(
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    req: Request
  ): void;
  storageCheck(
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    req: Request,
    cleanup: boolean
  ): Promise<void>;
  storageSourceContext(
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    context: InstallationRoomMutationContext
  ): void;
  storageCleanup(
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    req: Request
  ): void;
  capture(roomId: string, req: Request, res: Response): Promise<object>;
  current(handle: object): EditorOperation;
  retire(handle: object): Promise<void>;
  save(handle: object, input: Parameters<EditorLegacy['save']>[2]): Promise<RoomFileSaveOutcome>;
  prepare(handle: object): Promise<{ maxFileBytes: number; stagingDir: string }>;
  upload(
    handle: object,
    input: Parameters<EditorLegacy['upload']>[2]
  ): Promise<RoomFileChangeOutcome>;
  attachment(
    handle: object,
    input: Parameters<EditorLegacy['saveAttachment']>[2]
  ): Promise<RoomFileChangeOutcome>;
  move(handle: object, input: Parameters<EditorLegacy['move']>[2]): Promise<RoomFileChangeOutcome>;
  remove(
    handle: object,
    input: Parameters<EditorLegacy['remove']>[2]
  ): Promise<RoomFileChangeOutcome>;
}
const editors = new WeakMap<RoomFileEditor, EditorCommands>();
const editorOperations = new WeakMap<object, EditorOperation>();
function fixedEditor(editor: RoomFileEditor): EditorCommands {
  const actual = editors.get(editor);
  if (!actual) throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  return actual;
}
/** Require the Room file editor's exact original owner dependencies. */
export function requireRoomFileEditorOwner(
  editor: RoomFileEditor,
  owner: InstallationFileWrites
): undefined {
  fixedEditor(editor).requireOwner(owner);
  return undefined;
}
/** Constructor-private prepared stage and exact selected storage; these export no supplied checker. */
export function createRoomFileEditorUploadStorage(
  editor: RoomFileEditor,
  handle: object,
  directory: string
): multer.StorageEngine {
  return fixedEditor(editor).storage(handle, directory);
}
/** Require the original Room file upload storage owner. */
export function requireRoomFileEditorUploadStorageOwner(
  editor: RoomFileEditor,
  handle: object,
  directory: string
): void {
  fixedEditor(editor).storageOwner(handle, directory);
}
/** Read the upload limit retained by the original Room file editor. */
export function readRoomFileEditorUploadLimit(
  editor: RoomFileEditor,
  handle: object,
  directory: string,
  storage: multer.StorageEngine
): number {
  return fixedEditor(editor).storageLimit(handle, directory, storage);
}
/** Require currentness of the original Room file upload operation. */
export function requireRoomFileEditorUploadCurrent(
  editor: RoomFileEditor,
  handle: object,
  directory: string,
  storage: multer.StorageEngine,
  req: Request
): void {
  fixedEditor(editor).storageCurrent(handle, directory, storage, req);
}
/** Recheck currentness of the original Room file upload operation. */
export function checkRoomFileEditorUploadCurrent(
  editor: RoomFileEditor,
  handle: object,
  directory: string,
  storage: multer.StorageEngine,
  req: Request
): Promise<void> {
  return fixedEditor(editor).storageCheck(handle, directory, storage, req, false);
}
/** Require cleanup custody for the original Room file upload. */
export function requireRoomFileEditorUploadCleanup(
  editor: RoomFileEditor,
  handle: object,
  directory: string,
  storage: multer.StorageEngine,
  req: Request
): void {
  fixedEditor(editor).storageCleanup(handle, directory, storage, req);
}
/** Recheck cleanup custody for the original Room file upload. */
export function checkRoomFileEditorUploadCleanup(
  editor: RoomFileEditor,
  handle: object,
  directory: string,
  storage: multer.StorageEngine,
  req: Request
): Promise<void> {
  return fixedEditor(editor).storageCheck(handle, directory, storage, req, true);
}
/** Require the original source context for a Room file upload. */
export function requireRoomFileEditorUploadSourceContext(
  editor: RoomFileEditor,
  handle: object,
  directory: string,
  storage: multer.StorageEngine,
  context: InstallationRoomMutationContext
): void {
  fixedEditor(editor).storageSourceContext(handle, directory, storage, context);
}
/** Capture the original Room file editor HTTP operation. */
export function captureRoomFileEditorHttpOperation(
  editor: RoomFileEditor,
  roomId: string,
  req: Request,
  res: Response
): Promise<object> {
  return fixedEditor(editor).capture(roomId, req, res);
}
/** Require currentness of the captured Room file editor HTTP operation. */
export function requireRoomFileEditorHttpCurrent(
  editor: RoomFileEditor,
  handle: object
): undefined {
  fixedEditor(editor).current(handle);
  return undefined;
}
/** Retire the captured original Room file editor HTTP operation. */
export function retireRoomFileEditorHttpOperation(
  editor: RoomFileEditor,
  handle: object
): Promise<void> {
  return fixedEditor(editor).retire(handle);
}
/** Save a Room file through the original editor operation. */
export function executeRoomFileSave(
  editor: RoomFileEditor,
  handle: object,
  input: Parameters<EditorLegacy['save']>[2]
): Promise<RoomFileSaveOutcome> {
  return fixedEditor(editor).save(handle, input);
}
/** Prepare an upload through the original Room file editor. */
export function executeRoomFilePrepareUpload(
  editor: RoomFileEditor,
  handle: object
): Promise<{ maxFileBytes: number; stagingDir: string }> {
  return fixedEditor(editor).prepare(handle);
}
/** Upload a file through the original Room file editor operation. */
export function executeRoomFileUpload(
  editor: RoomFileEditor,
  handle: object,
  input: Parameters<EditorLegacy['upload']>[2]
): Promise<RoomFileChangeOutcome> {
  return fixedEditor(editor).upload(handle, input);
}
/** Create an attachment through the original Room file editor operation. */
export function executeRoomFileAttachment(
  editor: RoomFileEditor,
  handle: object,
  input: Parameters<EditorLegacy['saveAttachment']>[2]
): Promise<RoomFileChangeOutcome> {
  return fixedEditor(editor).attachment(handle, input);
}
/** Move a file through the original Room file editor operation. */
export function executeRoomFileMove(
  editor: RoomFileEditor,
  handle: object,
  input: Parameters<EditorLegacy['move']>[2]
): Promise<RoomFileChangeOutcome> {
  return fixedEditor(editor).move(handle, input);
}
/** Remove a file through the original Room file editor operation. */
export function executeRoomFileRemove(
  editor: RoomFileEditor,
  handle: object,
  input: Parameters<EditorLegacy['remove']>[2]
): Promise<RoomFileChangeOutcome> {
  return fixedEditor(editor).remove(handle, input);
}

/** Changing a room's `main`, as the person who asked. */
export class RoomFileEditor {
  readonly #deps: RoomFileEditorDeps;
  readonly #owner?: InstallationFileWrites;
  readonly #operation = new AsyncLocalStorage<EditorOperation>();
  constructor(deps: RoomFileEditorDeps) {
    this.#deps = Object.freeze({ ...deps });
    this.#owner = deps.installationRoomWrites
      ? readInstallationRoomFileWriteOwner(deps.installationRoomWrites, deps.store, deps.mutex)
      : undefined;
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
  async #capture(roomId: string, req: Request, res: Response): Promise<object> {
    const writer = this.#deps.installationRoomWrites;
    if (!writer || !this.#owner) throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
    const caller = await captureDocHttpRoomFileWriteCaller(this.#owner, req, res, roomId, this);
    let actor: Readonly<RoomFileActor>;
    try {
      actor = readDocHttpRoomFileWriteAttribution(this.#owner, roomId, caller);
      this.#prequeue(roomId, caller);
    } catch (cause) {
      try {
        retireDocHttpRoomFileWriteCaller(this.#owner, caller);
      } catch {
        /* Preserve exact capture cause. */
      }
      throw cause;
    }
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void, rejected!: (cause: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => {
      entered = resolve;
      rejected = reject;
    });
    const handle = Object.freeze({});
    const operation: EditorOperation = {
      editor: this,
      request: req,
      roomId,
      caller,
      actor,
      active: true,
      release,
      draining: Promise.resolve(),
      staging: new Map(),
    };
    editorOperations.set(handle, operation);
    // One actual room/installation namespace is held through every participating effect and cleanup.
    operation.draining = Promise.resolve().then(() =>
      withRecognizedInstallationRoomFileEditor(writer, roomId, async (scope) => {
        operation.scope = scope;
        operation.context = readInstallationRoomHttpMutationContext(writer, roomId, scope, caller);
        await checkDocHttpRoomFileWriteCurrent(this.#owner!, roomId, caller);
        this.#current(handle);
        this.#prequeue(roomId, caller);
        entered();
        await held;
      })
    );
    void operation.draining.catch(rejected);
    try {
      await ready;
      this.#current(handle);
      return handle;
    } catch (cause) {
      operation.active = false;
      editorOperations.delete(handle);
      release();
      try {
        await operation.draining;
      } catch {
        /* Preserve exact capture cause, including undefined. */
      }
      try {
        retireDocHttpRoomFileWriteCaller(this.#owner, caller);
      } catch {
        /* Preserve capture cause. */
      }
      throw cause;
    }
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
  async #retire(handle: object): Promise<void> {
    const operation = editorOperations.get(handle);
    if (!operation || operation.editor !== this || !this.#owner)
      throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
    let failed = false,
      cause: unknown;
    // Close ALL actual storage admissions before awaiting any write/FD/removal drain.
    const drains: Promise<void>[] = [];
    for (const stage of operation.staging.values())
      if (stage.storage) {
        try {
          drains.push(retireRoomFileUploadStorage(stage.storage));
        } catch (error) {
          if (!failed) {
            failed = true;
            cause = error;
          }
        }
      }
    const settled = await Promise.allSettled(drains);
    for (const result of settled)
      if (result.status === 'rejected' && !failed) {
        failed = true;
        cause = result.reason;
      }
    for (const directory of operation.staging.keys()) {
      try {
        await this.#discardOwnedStaging(operation, directory);
      } catch (error) {
        if (!failed) {
          failed = true;
          cause = error;
        }
      }
    }
    operation.active = false;
    editorOperations.delete(handle);
    operation.release();
    try {
      await operation.draining;
    } catch (error) {
      if (!failed) {
        failed = true;
        cause = error;
      }
    }
    try {
      retireDocHttpRoomFileWriteCaller(this.#owner, operation.caller);
    } catch (error) {
      if (!failed) {
        failed = true;
        cause = error;
      }
    }
    if (failed) throw cause;
  }
  #stage(
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    req?: Request
  ): { operation: EditorOperation; stage: UploadStage } {
    const operation = editorOperations.get(handle);
    const stage = operation?.staging.get(directory);
    if (
      !operation?.active ||
      operation.editor !== this ||
      !stage ||
      stage.storage !== storage ||
      (req && req !== operation.request)
    )
      throw new Error('Unknown original prepared upload storage.');
    return { operation, stage };
  }
  #storage(handle: object, directory: string): multer.StorageEngine {
    const operation = this.#current(handle),
      stage = operation.staging.get(directory);
    if (!stage || stage.storage || stage.minting)
      throw new Error('No fresh original prepared upload stage.');
    stage.minting = true;
    try {
      const storage = createRoomFileUploadStorage(this, handle, directory);
      stage.storage = storage;
      return storage;
    } finally {
      stage.minting = false;
    }
  }
  async #checkStorage(
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    req: Request,
    cleanup: boolean
  ): Promise<void> {
    const { operation } = this.#stage(handle, directory, storage, req);
    if (!cleanup) {
      await checkDocHttpRoomFileWriteCurrent(this.#owner!, operation.roomId, operation.caller);
      this.#current(handle);
    }
    await this.#checkStageIdentity(operation, directory);
    this.#stage(handle, directory, storage, req);
    if (!cleanup) this.#current(handle);
    // Cleanup uses only the still-admitted actual scope/FD custody, never refreshed forward permission.
  }
  async #checkStageIdentity(operation: EditorOperation, directory: string): Promise<void> {
    const expected = operation.staging.get(directory);
    if (!expected || !operation.scope || !this.#deps.installationRoomWrites)
      throw new Error('No admitted upload cleanup scope.');
    await checkInstallationRoomScope(
      this.#deps.installationRoomWrites,
      operation.roomId,
      operation.scope
    );
    for (const ancestor of expected.ancestors) {
      const observed = await fs.lstat(ancestor.directory, { bigint: true });
      if (
        !observed.isDirectory() ||
        observed.isSymbolicLink() ||
        observed.dev !== ancestor.dev ||
        observed.ino !== ancestor.ino
      )
        throw new Error('Upload staging ancestry identity changed.');
    }
    const parent = await fs.lstat(path.dirname(directory), { bigint: true });
    if (
      !parent.isDirectory() ||
      parent.isSymbolicLink() ||
      parent.dev !== expected.parentDev ||
      parent.ino !== expected.parentIno
    )
      throw new Error('Upload staging parent identity changed.');
    const current = await fs.lstat(directory, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino
    )
      throw new Error('Upload staging directory identity changed.');
    const finalParent = await fs.lstat(path.dirname(directory), { bigint: true });
    if (
      !finalParent.isDirectory() ||
      finalParent.isSymbolicLink() ||
      finalParent.dev !== expected.parentDev ||
      finalParent.ino !== expected.parentIno
    )
      throw new Error('Upload staging parent identity changed.');
    const finalDirectory = await fs.lstat(directory, { bigint: true });
    if (
      !finalDirectory.isDirectory() ||
      finalDirectory.isSymbolicLink() ||
      finalDirectory.dev !== expected.dev ||
      finalDirectory.ino !== expected.ino
    )
      throw new Error('Upload staging directory identity changed.');
    requireInstallationRoomNamespaceCurrent(
      this.#deps.installationRoomWrites,
      operation.roomId,
      operation.scope
    );
  }
  async #discardOwnedStaging(operation: EditorOperation, directory: string): Promise<void> {
    await this.#checkStageIdentity(operation, directory);
    // Empty-directory removal cannot recursively delete an unacquired/replaced child.
    // External namespace replacement between these separate syscalls remains an honest race.
    await fs.rmdir(directory);
    operation.staging.delete(directory);
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
  async #save(
    roomId: string,
    actor: RoomFileActor,
    input: { path: string; baseCommit: string | null; text: string }
  ): Promise<RoomFileSaveOutcome> {
    this.#assertCanChange(roomId, actor);
    const requested = requireFilePath(input.path);

    return this.#underLock(roomId, async (state) => {
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
        const stale = await this.#lockConflict(
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
          conflict: await this.#conflictAt(roomId, state, filePath),
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
        this.#identityOf(actor),
        state.context
      );
      if (committed) {
        this.#post(roomId, actor, { kind, paths: [filePath], commit: committed });
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
          lastCommit: await this.#lastCommitOf(roomId, filePath),
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
  async #prepareUpload(
    roomId: string,
    actor: RoomFileActor
  ): Promise<{ maxFileBytes: number; stagingDir: string }> {
    this.#assertCanChange(roomId, actor);
    const operation = this.#operation.getStore();
    if (!operation?.context || !this.#owner) throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
    const caps = await this.#requireCaps(roomId);
    const fixed = readInstallationRoomUploadStagingRoot(operation.context);
    const installation = path.dirname(path.dirname(fixed.root));
    if ((await fs.realpath(installation)) !== fixed.canonicalInstallation)
      throw new Error('Original upload installation root changed.');
    const check = async () => {
      await checkDocHttpRoomFileWriteCurrent(this.#owner!, roomId, operation.caller);
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
      requireDocHttpRoomFileWriteCurrent(this.#owner, roomId, operation.caller);
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
    requireDocHttpRoomFileWriteCurrent(this.#owner, roomId, operation.caller);
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
  async #upload(
    roomId: string,
    actor: RoomFileActor,
    input: {
      dir: string;
      baseCommit: string | null;
      replace: readonly string[];
      files: readonly RoomFileUploadItem[];
    }
  ): Promise<RoomFileChangeOutcome> {
    this.#assertCanChange(roomId, actor);
    if (input.files.length === 0) {
      throw new RoomError('ROOM_FILE_PATH_INVALID', 'There were no files in that upload.');
    }
    if (input.files.length > ROOM_UPLOAD_MAX_FILES) {
      throw new RoomError(
        'ROOM_UPLOAD_TOO_MANY_FILES',
        `One upload can carry at most ${ROOM_UPLOAD_MAX_FILES} files.`
      );
    }
    return this.#addFiles(roomId, actor, { ...input, kind: 'upload' });
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
  async #saveAttachment(
    roomId: string,
    actor: RoomFileActor,
    input: { dir: string; name: string; baseCommit: string | null; bytes: Buffer }
  ): Promise<RoomFileChangeOutcome> {
    this.#assertCanChange(roomId, actor);
    return this.#addFiles(roomId, actor, {
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
  async #move(
    roomId: string,
    actor: RoomFileActor,
    input: { from: string; to: string; baseCommit: string }
  ): Promise<RoomFileChangeOutcome> {
    this.#assertCanChange(roomId, actor);
    const requestedFrom = requireFilePath(input.from);
    const requestedTo = requireFilePath(input.to);

    return this.#underLock(roomId, async (state) => {
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
      const stale = await this.#lockConflict(roomId, state, input.baseCommit, isUnder, from);
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
      return this.#commitAndAnnounce(roomId, actor, state, changes, {
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
  async #remove(
    roomId: string,
    actor: RoomFileActor,
    input: { path: string; baseCommit: string }
  ): Promise<RoomFileChangeOutcome> {
    this.#assertCanChange(roomId, actor);
    const requested = requireFilePath(input.path);

    return this.#underLock(roomId, async (state) => {
      const target = new RoomTreeIndex(state.tree.keys()).canonicalize(requested);
      // Always locked: nobody deletes a file they have not seen.
      const isUnder = (p: string): boolean => p === target || p.startsWith(`${target}/`);
      const stale = await this.#lockConflict(roomId, state, input.baseCommit, isUnder, target);
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
      return this.#commitAndAnnounce(roomId, actor, state, changes, {
        subject: `Delete ${label}`,
        kind: 'delete',
        paths: changes.map((change) => change.path),
        target: label,
      });
    });
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
    const requestedDir = normalizeRoomFilePath(input.dir);
    const replace = new Set(input.replace.map((name) => name.normalize('NFC')));
    const requested = input.files.map((file) => {
      const name = requireFileName(file.name);
      const filePath = requestedDir === '' ? name : `${requestedDir}/${name}`;
      assertWritablePath(filePath);
      return { path: filePath, content: file.content };
    });

    return this.#underLock(roomId, async (state) => {
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
        const stale = await this.#lockConflict(
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
              conflict: await this.#conflictAt(roomId, state, target.path),
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
      return this.#commitAndAnnounce(roomId, actor, state, changes, {
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
  async #commitAndAnnounce(
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
    const committed = await commitChangeSet(
      state.repoDir,
      state.ceiling,
      changes,
      what.subject,
      this.#identityOf(actor),
      state.context
    );
    const paths = [...what.paths].sort();
    if (committed) {
      this.#post(
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
          : await this.#lastCommitOf(roomId, paths[0] as string),
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
  #post(
    roomId: string,
    actor: RoomFileActor,
    change: { kind: RoomFileChangeEvent['kind']; paths: string[]; commit: string; from?: string },
    target = change.paths[0] ?? ''
  ): void {
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
    const operation = this.#operation.getStore();
    if (!operation || !operation.context || !this.#owner)
      throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
    requireInstallationRoomMutationTarget(
      operation.context,
      readInstallationRoomMutationRoots(operation.context).repoPath
    );
    this.#deps.announce(roomId, {
      text: fileChangeSentence(this.#displayNameOf(actor), fileChange, target),
      fileChange,
      subjectAuthorId: actor.authorId,
    });
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
    if (!this.#deps.enabled())
      throw new RoomError(
        'ROOM_REPOS_DISABLED',
        'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
      );
    if (!this.#owner) throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
    requireDocHttpRoomFileWriteCurrent(this.#owner, roomId, caller);
    if (this.#deps.store.getRow(roomId) === null)
      throw new RoomError('ROOM_HAS_NO_REPO', 'This room does not have files of its own.');
  }
  #assertCanChange(roomId: string, actor: RoomFileActor): void {
    if (!this.#deps.enabled()) {
      throw new RoomError(
        'ROOM_REPOS_DISABLED',
        'Rooms cannot have files of their own on this install. Turn that back on in Settings first.'
      );
    }
    // Membership before anything about the repo, so a non-member cannot tell a
    // project room from any other — the order `GET /:id/files` writes down.
    const operation = this.#operation.getStore();
    if (!operation || operation.roomId !== roomId || operation.actor !== actor || !this.#owner)
      throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
    requireDocHttpRoomFileWriteCurrent(this.#owner, roomId, operation.caller);
    if (this.#deps.store.getRow(roomId) === null) {
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
  async #underLock<T>(roomId: string, work: (state: MainState) => Promise<T>): Promise<T> {
    const operation = this.#operation.getStore();
    if (!operation || operation.roomId !== roomId || !operation.context || !this.#owner)
      throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
    const context = operation.context;
    const roots = readInstallationRoomMutationRoots(context);
    await checkInstallationRoomMutationTarget(context, roots.repoPath);
    const caps = await this.#requireCaps(roomId);
    await checkInstallationRoomMutationTarget(context, roots.repoPath);
    return this.#translatingGitAbsence(async () => {
      await assertMainCheckoutReady(roots.repoPath, roots.homePath);
      await checkInstallationRoomMutationTarget(context, roots.repoPath);
      const head = await this.#resolveMain(roots.repoPath, roots.homePath);
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
  async #lockConflict(
    roomId: string,
    state: MainState,
    baseCommit: string,
    isLocked: (filePath: string) => boolean,
    fallbackPath: string
  ): Promise<RoomFileConflict | null> {
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
    return outcome.status === 'changed' ? this.#conflictAt(roomId, state, outcome.path) : null;
  }

  /**
   * The conflict payload for one path: where `main` is now, and who last
   * touched the path there.
   *
   * @param roomId - The room.
   * @param state - What `main` holds.
   * @param filePath - The path that moved.
   */
  async #conflictAt(roomId: string, state: MainState, filePath: string): Promise<RoomFileConflict> {
    return {
      path: filePath,
      commit: state.head as string,
      lastCommit: state.tree.has(filePath) ? await this.#lastCommitOf(roomId, filePath) : null,
    };
  }

  /**
   * Who a commit is authored as — the §7.1 rule, in one place.
   *
   * @param actor - Who made the change.
   */
  #identityOf(actor: RoomFileActor): GitIdentity {
    if (actor.signedIn) {
      return {
        name: gitAuthorName(this.#deps.personName(actor.authorId)),
        email: personGitEmail(actor.authorId),
      };
    }
    return { name: gitAuthorName(this.#deps.operatorGitName()), email: OPERATOR_GIT_EMAIL };
  }

  /**
   * The name the room entry opens with.
   *
   * @param actor - Who made the change.
   */
  #displayNameOf(actor: RoomFileActor): string {
    const raw = actor.signedIn
      ? this.#deps.personName(actor.authorId)
      : this.#deps.operatorGitName();
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
  async #requireCaps(roomId: string): Promise<RoomRepoCaps> {
    const sidecar = await this.#deps.store.readSidecar(roomId);
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
  async #resolveMain(repoDir: string, ceiling: string): Promise<string | null> {
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
  async #lastCommitOf(roomId: string, filePath: string): Promise<RoomFileCommit | null> {
    try {
      return await this.#deps.files.lastCommitFor(roomId, filePath);
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
  async #translatingGitAbsence<T>(work: () => Promise<T>): Promise<T> {
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
}

/**
 * A path that names a FILE or folder in the room — never the room itself.
 *
 * @param raw - The path as the request carried it.
 * @throws {RoomError} `ROOM_FILE_PATH_INVALID` or `ROOM_FILE_NOT_READABLE`.
 */
function requireFilePath(raw: string): string {
  const filePath = normalizeRoomFilePath(raw);
  if (filePath === '') {
    throw new RoomError('ROOM_FILE_NOT_READABLE', 'That is the whole room, not a file in it.');
  }
  assertWritablePath(filePath);
  return filePath;
}

/**
 * A file NAME an upload or an attachment carries — one path segment, which the
 * same rules as a path govern.
 *
 * @param raw - The name.
 * @throws {RoomError} `ROOM_FILE_PATH_INVALID`.
 */
function requireFileName(raw: string): string {
  if (raw.includes('/') || raw.includes('\\')) {
    throw new RoomError(
      'ROOM_FILE_PATH_INVALID',
      `\`${sanitizeSegment(raw)}\` is not a file name: it has a slash in it.`
    );
  }
  const name = normalizeRoomFilePath(raw);
  if (name === '') {
    throw new RoomError('ROOM_FILE_PATH_INVALID', 'A file needs a name.');
  }
  return name;
}

/**
 * `ROOM_FILE_EXISTS`, naming the path.
 *
 * @param filePath - What is already there.
 */
function exists(filePath: string): RoomError {
  return new RoomError(
    'ROOM_FILE_EXISTS',
    `This room already has \`${filePath}\`. Replace it, or choose another name.`
  );
}

/**
 * `ROOM_FILE_NOT_FOUND`, naming the path.
 *
 * @param filePath - What is not there.
 */
function notThere(filePath: string): RoomError {
  return new RoomError('ROOM_FILE_NOT_FOUND', `There is no \`${filePath}\` in this room’s files.`);
}

/**
 * The last segment of a path.
 *
 * @param filePath - The path.
 */
function basenameOf(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf('/') + 1);
}

/**
 * `1 file` / `3 files`.
 *
 * @param count - How many.
 * @param noun - The singular noun.
 */
function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
