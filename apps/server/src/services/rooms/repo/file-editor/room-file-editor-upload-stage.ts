import type { RoomUploadStorageEngine } from '../upload/room-upload-storage-contracts.js';
import { readOriginalRoomEditorView } from '../room-file-editor.js';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { createRoomFileUploadStorage } from '../room-file-upload-storage.js';
import { checkDocHttpRoomFileWriteCurrent } from '../../../canvas/doc-channel/http-composition.js';
import {
  checkInstallationRoomScope,
  requireInstallationRoomNamespaceCurrent,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import type { UploadStage, EditorOperation } from './room-file-editor-contracts.js';

/** Execute the original guarded stage editor operation. */
export function stage(
  editorOwner: object,
  handle: object,
  directory: string,
  storage: RoomUploadStorageEngine,
  req?: IncomingMessage
): { operation: EditorOperation; stage: UploadStage } {
  const view = readOriginalRoomEditorView(editorOwner);
  const operation = view.editorOperations.get(handle);
  const stage = operation?.staging.get(directory);
  if (
    !operation?.active ||
    operation.editor !== view.runtime ||
    !stage ||
    stage.storage !== storage ||
    (req && req !== operation.request)
  )
    throw new Error('Unknown original prepared upload storage.');
  return { operation, stage };
}

/** Execute the original guarded storage editor operation. */
export function storage(
  editorOwner: object,
  handle: object,
  directory: string
): RoomUploadStorageEngine {
  const view = readOriginalRoomEditorView(editorOwner);
  const operation = view.current(handle),
    stage = operation.staging.get(directory);
  if (!stage || stage.storage || stage.minting)
    throw new Error('No fresh original prepared upload stage.');
  stage.minting = true;
  try {
    const storage = createRoomFileUploadStorage(view.runtime, handle, directory);
    stage.storage = storage;
    return storage;
  } finally {
    stage.minting = false;
  }
}

/** Execute the original guarded checkStorage editor operation. */
export async function checkStorage(
  editorOwner: object,
  handle: object,
  directory: string,
  storage: RoomUploadStorageEngine,
  req: IncomingMessage,
  cleanup: boolean
): Promise<void> {
  const view = readOriginalRoomEditorView(editorOwner);
  const { operation } = view.stage(handle, directory, storage, req);
  if (!cleanup) {
    await checkDocHttpRoomFileWriteCurrent(view.owner!, operation.roomId, operation.caller);
    view.current(handle);
  }
  await view.checkStageIdentity(operation, directory);
  view.stage(handle, directory, storage, req);
  if (!cleanup) view.current(handle);
  // Cleanup uses only the still-admitted actual scope/FD custody, never refreshed forward permission.
}

/** Execute the original guarded checkStageIdentity editor operation. */
export async function checkStageIdentity(
  editorOwner: object,
  operation: EditorOperation,
  directory: string
): Promise<void> {
  const view = readOriginalRoomEditorView(editorOwner);
  const expected = operation.staging.get(directory);
  if (!expected || !operation.scope || !view.deps.installationRoomWrites)
    throw new Error('No admitted upload cleanup scope.');
  await checkInstallationRoomScope(
    view.deps.installationRoomWrites,
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
    view.deps.installationRoomWrites,
    operation.roomId,
    operation.scope
  );
}

/** Execute the original guarded discardOwnedStaging editor operation. */
export async function discardOwnedStaging(
  editorOwner: object,
  operation: EditorOperation,
  directory: string
): Promise<void> {
  const view = readOriginalRoomEditorView(editorOwner);
  await view.checkStageIdentity(operation, directory);
  // Empty-directory removal cannot recursively delete an unacquired/replaced child.
  // External namespace replacement between these separate syscalls remains an honest race.
  await fs.rmdir(directory);
  operation.staging.delete(directory);
}
