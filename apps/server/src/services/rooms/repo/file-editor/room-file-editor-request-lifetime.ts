import { readOriginalRoomEditorView } from '../room-file-editor.js';
import type { Request, Response } from 'express';
import { retireRoomFileUploadStorage } from '../room-file-upload-storage.js';
import {
  captureDocHttpRoomFileWriteCaller,
  checkDocHttpRoomFileWriteCurrent,
  readDocHttpRoomFileWriteAttribution,
  retireDocHttpRoomFileWriteCaller,
} from '../../../canvas/doc-channel/http-composition.js';
import {
  withRecognizedInstallationRoomFileEditor,
  readInstallationRoomHttpMutationContext,
} from '../../../canvas/doc-channel/writes/installation-room-writes.js';
import { RoomError } from '../../data/room-errors.js';
import type { RoomFileActor, EditorOperation } from './room-file-editor-contracts.js';

/** Execute the original request-local editor capture lifetime and preserve its exact cause/drain order. */
export async function capture(
  editorOwner: object,
  roomId: string,
  req: Request,
  res: Response
): Promise<object> {
  const view = readOriginalRoomEditorView(editorOwner);
  const writer = view.deps.installationRoomWrites;
  if (!writer || !view.owner) throw new RoomError('ROOM_NOT_FOUND', 'No such room.');
  const caller = await captureDocHttpRoomFileWriteCaller(
    view.owner,
    req,
    res,
    roomId,
    view.runtime
  );
  let actor: Readonly<RoomFileActor>;
  try {
    actor = readDocHttpRoomFileWriteAttribution(view.owner, roomId, caller);
    view.prequeue(roomId, caller);
  } catch (cause) {
    try {
      retireDocHttpRoomFileWriteCaller(view.owner, caller);
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
    editor: view.runtime,
    request: req,
    roomId,
    caller,
    actor,
    active: true,
    release,
    draining: Promise.resolve(),
    staging: new Map(),
  };
  view.editorOperations.set(handle, operation);
  // One actual room/installation namespace is held through every participating effect and cleanup.
  operation.draining = Promise.resolve().then(() =>
    withRecognizedInstallationRoomFileEditor(writer, roomId, async (scope) => {
      operation.scope = scope;
      operation.context = readInstallationRoomHttpMutationContext(writer, roomId, scope, caller);
      await checkDocHttpRoomFileWriteCurrent(view.owner!, roomId, caller);
      view.current(handle);
      view.prequeue(roomId, caller);
      entered();
      await held;
    })
  );
  void operation.draining.catch(rejected);
  try {
    await ready;
    view.current(handle);
    return handle;
  } catch (cause) {
    operation.active = false;
    view.editorOperations.delete(handle);
    release();
    try {
      await operation.draining;
    } catch {
      /* Preserve exact capture cause, including undefined. */
    }
    try {
      retireDocHttpRoomFileWriteCaller(view.owner, caller);
    } catch {
      /* Preserve capture cause. */
    }
    throw cause;
  }
}

/** Execute the original request-local editor retire lifetime and preserve its exact cause/drain order. */
export async function retire(editorOwner: object, handle: object): Promise<void> {
  const view = readOriginalRoomEditorView(editorOwner);
  const operation = view.editorOperations.get(handle);
  if (!operation || operation.editor !== view.runtime || !view.owner)
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
      await view.discardOwnedStaging(operation, directory);
    } catch (error) {
      if (!failed) {
        failed = true;
        cause = error;
      }
    }
  }
  operation.active = false;
  view.editorOperations.delete(handle);
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
    retireDocHttpRoomFileWriteCaller(view.owner, operation.caller);
  } catch (error) {
    if (!failed) {
      failed = true;
      cause = error;
    }
  }
  if (failed) throw cause;
}
