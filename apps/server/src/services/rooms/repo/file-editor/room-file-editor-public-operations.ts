import { readOriginalRoomEditorCommands } from '../room-file-editor.js';
import type { Request, Response } from 'express';
import type multer from 'multer';
import { type InstallationRoomMutationContext } from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import type { InstallationFileWrites } from '../../../canvas/doc-channel/writes/installation-file-writes.js';
import type { RoomFileEditor } from '../room-file-editor.js';
import type {
  RoomFileSaveOutcome,
  RoomFileChangeOutcome,
  EditorLegacy,
} from './room-file-editor-contracts.js';

const originalRoomEditorPublicFreeze = Object.freeze;

/** Capture an opaque selector; fake selectors fail the original root guard before native operations. */
export function createOriginalRoomEditorPublicOperations(publicOwner: object) {
  /** Require the Room file editor's exact original owner dependencies. */
  function requireRoomFileEditorOwner(
    editor: RoomFileEditor,
    owner: InstallationFileWrites
  ): undefined {
    readOriginalRoomEditorCommands(publicOwner, editor).requireOwner(owner);
    return undefined;
  }
  /** Constructor-private prepared stage and exact selected storage; these export no supplied checker. */
  function createRoomFileEditorUploadStorage(
    editor: RoomFileEditor,
    handle: object,
    directory: string
  ): multer.StorageEngine {
    return readOriginalRoomEditorCommands(publicOwner, editor).storage(handle, directory);
  }
  /** Require the original Room file upload storage owner. */
  function requireRoomFileEditorUploadStorageOwner(
    editor: RoomFileEditor,
    handle: object,
    directory: string
  ): void {
    readOriginalRoomEditorCommands(publicOwner, editor).storageOwner(handle, directory);
  }
  /** Read the upload limit retained by the original Room file editor. */
  function readRoomFileEditorUploadLimit(
    editor: RoomFileEditor,
    handle: object,
    directory: string,
    storage: multer.StorageEngine
  ): number {
    return readOriginalRoomEditorCommands(publicOwner, editor).storageLimit(
      handle,
      directory,
      storage
    );
  }
  /** Require currentness of the original Room file upload operation. */
  function requireRoomFileEditorUploadCurrent(
    editor: RoomFileEditor,
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    req: Request
  ): void {
    readOriginalRoomEditorCommands(publicOwner, editor).storageCurrent(
      handle,
      directory,
      storage,
      req
    );
  }
  /** Recheck currentness of the original Room file upload operation. */
  function checkRoomFileEditorUploadCurrent(
    editor: RoomFileEditor,
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    req: Request
  ): Promise<void> {
    return readOriginalRoomEditorCommands(publicOwner, editor).storageCheck(
      handle,
      directory,
      storage,
      req,
      false
    );
  }
  /** Require cleanup custody for the original Room file upload. */
  function requireRoomFileEditorUploadCleanup(
    editor: RoomFileEditor,
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    req: Request
  ): void {
    readOriginalRoomEditorCommands(publicOwner, editor).storageCleanup(
      handle,
      directory,
      storage,
      req
    );
  }
  /** Recheck cleanup custody for the original Room file upload. */
  function checkRoomFileEditorUploadCleanup(
    editor: RoomFileEditor,
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    req: Request
  ): Promise<void> {
    return readOriginalRoomEditorCommands(publicOwner, editor).storageCheck(
      handle,
      directory,
      storage,
      req,
      true
    );
  }
  /** Require the original source context for a Room file upload. */
  function requireRoomFileEditorUploadSourceContext(
    editor: RoomFileEditor,
    handle: object,
    directory: string,
    storage: multer.StorageEngine,
    context: InstallationRoomMutationContext
  ): void {
    readOriginalRoomEditorCommands(publicOwner, editor).storageSourceContext(
      handle,
      directory,
      storage,
      context
    );
  }
  /** Capture the original Room file editor HTTP operation. */
  function captureRoomFileEditorHttpOperation(
    editor: RoomFileEditor,
    roomId: string,
    req: Request,
    res: Response
  ): Promise<object> {
    return readOriginalRoomEditorCommands(publicOwner, editor).capture(roomId, req, res);
  }
  /** Require currentness of the captured Room file editor HTTP operation. */
  function requireRoomFileEditorHttpCurrent(editor: RoomFileEditor, handle: object): undefined {
    readOriginalRoomEditorCommands(publicOwner, editor).current(handle);
    return undefined;
  }
  /** Retire the captured original Room file editor HTTP operation. */
  function retireRoomFileEditorHttpOperation(
    editor: RoomFileEditor,
    handle: object
  ): Promise<void> {
    return readOriginalRoomEditorCommands(publicOwner, editor).retire(handle);
  }
  /** Save a Room file through the original editor operation. */
  function executeRoomFileSave(
    editor: RoomFileEditor,
    handle: object,
    input: Parameters<EditorLegacy['save']>[2]
  ): Promise<RoomFileSaveOutcome> {
    return readOriginalRoomEditorCommands(publicOwner, editor).save(handle, input);
  }
  /** Prepare an upload through the original Room file editor. */
  function executeRoomFilePrepareUpload(
    editor: RoomFileEditor,
    handle: object
  ): Promise<{ maxFileBytes: number; stagingDir: string }> {
    return readOriginalRoomEditorCommands(publicOwner, editor).prepare(handle);
  }
  /** Upload a file through the original Room file editor operation. */
  function executeRoomFileUpload(
    editor: RoomFileEditor,
    handle: object,
    input: Parameters<EditorLegacy['upload']>[2]
  ): Promise<RoomFileChangeOutcome> {
    return readOriginalRoomEditorCommands(publicOwner, editor).upload(handle, input);
  }
  /** Create an attachment through the original Room file editor operation. */
  function executeRoomFileAttachment(
    editor: RoomFileEditor,
    handle: object,
    input: Parameters<EditorLegacy['saveAttachment']>[2]
  ): Promise<RoomFileChangeOutcome> {
    return readOriginalRoomEditorCommands(publicOwner, editor).attachment(handle, input);
  }
  /** Move a file through the original Room file editor operation. */
  function executeRoomFileMove(
    editor: RoomFileEditor,
    handle: object,
    input: Parameters<EditorLegacy['move']>[2]
  ): Promise<RoomFileChangeOutcome> {
    return readOriginalRoomEditorCommands(publicOwner, editor).move(handle, input);
  }
  /** Remove a file through the original Room file editor operation. */
  function executeRoomFileRemove(
    editor: RoomFileEditor,
    handle: object,
    input: Parameters<EditorLegacy['remove']>[2]
  ): Promise<RoomFileChangeOutcome> {
    return readOriginalRoomEditorCommands(publicOwner, editor).remove(handle, input);
  }

  return originalRoomEditorPublicFreeze({
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
  });
}
