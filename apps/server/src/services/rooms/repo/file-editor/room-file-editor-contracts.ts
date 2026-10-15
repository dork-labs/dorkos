import type { RoomUploadStorageEngine } from '../upload/room-upload-storage-contracts.js';
import path from 'node:path';
import type { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  type InstallationRoomWrites,
  type InstallationRoomMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import type { InstallationFileWrites } from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import type { RoomRepoCaps } from '@dorkos/shared/room-repo';
import type {
  RoomFileChangeResponse,
  RoomFileCommit,
  RoomFileConflict,
  RoomFileSaveResponse,
} from '@dorkos/shared/room-files';
import { type RoomFileChangeEvent } from '@dorkos/shared/room-schemas';
import type { RoomRepoStore } from '../room-repo-store.js';
import type { RoomRepoMutex } from '../room-repo-mutex.js';
import { type GitIdentity, type TreeEntry } from '../room-repo-git.js';
import { type RoomFileChange, type RoomFileContent } from '../room-file-ops.js';
import type { RoomFileEditor } from '../room-file-editor.js';
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
export interface RoomFileProvenanceReader {
  /**
   * Who last touched one file on `main`.
   *
   * @param roomId - The room.
   * @param filePath - The file, relative to the repo root.
   */
  lastCommitFor(roomId: string, filePath: string): Promise<RoomFileCommit | null>;
}

/** Everything one change reads before it decides anything, under the lock. */
export interface MainState {
  repoDir: string;
  ceiling: string;
  caps: RoomRepoCaps;
  head: string | null;
  tree: Map<string, TreeEntry>;
  context: InstallationRoomMutationContext;
}

/** Original refused legacy argument tuples retained by the public editor facade. */
export interface EditorLegacy {
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
/** Original constructor-owned staged upload identity and admission state. */
export interface UploadStage {
  dev: bigint;
  ino: bigint;
  parentDev: bigint;
  parentIno: bigint;
  maxFileBytes: number;
  ancestors: readonly Readonly<{ directory: string; dev: bigint; ino: bigint }>[];
  minting: boolean;
  storage?: RoomUploadStorageEngine;
}
/** Original request-local editor operation and its owned drains and staging. */
export interface EditorOperation {
  editor: RoomFileEditor;
  request: IncomingMessage;
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
/** Original constructor-registered native editor command signatures. */
export interface EditorCommands {
  requireOwner(owner: InstallationFileWrites): void;
  storage(handle: object, directory: string): RoomUploadStorageEngine;
  storageOwner(handle: object, directory: string): void;
  storageLimit(handle: object, directory: string, storage: RoomUploadStorageEngine): number;
  storageCurrent(
    handle: object,
    directory: string,
    storage: RoomUploadStorageEngine,
    req: IncomingMessage
  ): void;
  storageCheck(
    handle: object,
    directory: string,
    storage: RoomUploadStorageEngine,
    req: IncomingMessage,
    cleanup: boolean
  ): Promise<void>;
  storageSourceContext(
    handle: object,
    directory: string,
    storage: RoomUploadStorageEngine,
    context: InstallationRoomMutationContext
  ): void;
  storageCleanup(
    handle: object,
    directory: string,
    storage: RoomUploadStorageEngine,
    req: IncomingMessage
  ): void;
  capture(roomId: string, req: IncomingMessage, res: ServerResponse): Promise<object>;
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

/** Original editor inputs and private method calls selected only by the constructor-private key. */
export interface OriginalRoomEditorView {
  readonly runtime: RoomFileEditor;
  readonly deps: RoomFileEditorDeps;
  readonly owner: InstallationFileWrites | undefined;
  readonly operation: AsyncLocalStorage<EditorOperation>;
  readonly editorOperations: WeakMap<object, EditorOperation>;
  capture(roomId: string, req: IncomingMessage, res: ServerResponse): Promise<object>;
  retire(handle: object): Promise<void>;
  current(handle: object): EditorOperation;
  dispatch<T>(handle: object, work: () => Promise<T>): Promise<T>;
  stage(
    handle: object,
    directory: string,
    storage: RoomUploadStorageEngine,
    req?: IncomingMessage
  ): { operation: EditorOperation; stage: UploadStage };
  storage(handle: object, directory: string): RoomUploadStorageEngine;
  checkStorage(
    handle: object,
    directory: string,
    storage: RoomUploadStorageEngine,
    req: IncomingMessage,
    cleanup: boolean
  ): Promise<void>;
  checkStageIdentity(operation: EditorOperation, directory: string): Promise<void>;
  discardOwnedStaging(operation: EditorOperation, directory: string): Promise<void>;
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
  addFiles(
    roomId: string,
    actor: RoomFileActor,
    input: {
      dir: string;
      baseCommit: string | null;
      replace: readonly string[];
      files: readonly RoomFileUploadItem[];
      kind: 'upload' | 'from-attachment';
    }
  ): Promise<RoomFileChangeOutcome>;
  commitAndAnnounce(
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
  ): Promise<RoomFileChangeOutcome>;
  post(
    roomId: string,
    actor: RoomFileActor,
    change: { kind: RoomFileChangeEvent['kind']; paths: string[]; commit: string; from?: string },
    target?: string
  ): void;
  prequeue(roomId: string, caller: object): void;
  assertCanChange(roomId: string, actor: RoomFileActor): void;
  underLock<T>(roomId: string, work: (state: MainState) => Promise<T>): Promise<T>;
  lockConflict(
    roomId: string,
    state: MainState,
    baseCommit: string,
    isLocked: (filePath: string) => boolean,
    fallbackPath: string
  ): Promise<RoomFileConflict | null>;
  conflictAt(roomId: string, state: MainState, filePath: string): Promise<RoomFileConflict>;
  identityOf(actor: RoomFileActor): GitIdentity;
  displayNameOf(actor: RoomFileActor): string;
  requireCaps(roomId: string): Promise<RoomRepoCaps>;
  resolveMain(repoDir: string, ceiling: string): Promise<string | null>;
  lastCommitOf(roomId: string, filePath: string): Promise<RoomFileCommit | null>;
  translatingGitAbsence<T>(work: () => Promise<T>): Promise<T>;
}
