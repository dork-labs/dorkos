import type { UploadStreamFile, UploadedFile } from '../../../../http/uploads.js';
import type { RoomUploadStorageEngine } from './room-upload-storage-contracts.js';
import type { FileHandle } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import type { Readable } from 'node:stream';
import type { InstallationRoomMutationContext } from '../../../canvas/doc-channel/writes/installation-room-writes.js';

interface Identity {
  dev: bigint;
  ino: bigint;
}
export interface AcquiredFile {
  path: string;
  filename: string;
  file: UploadStreamFile;
  request: IncomingMessage;
  identity?: Identity;
  handle?: FileHandle;
  size: number;
  cancelled: boolean;
  removed: boolean;
  done: Promise<void>;
  removing?: Promise<void>;
  reads: Set<Promise<void>>;
  readers: Set<Readable>;
}
interface StorageCommands {
  complete(error: unknown): Promise<void>;
  retire(): Promise<void>;
  issueSources(
    request: IncomingMessage,
    files: readonly UploadedFile[]
  ): Promise<readonly Readonly<{ upload: object; size: number }>[]>;
  restoreCause(cause: unknown): unknown;
}
/** Each invocation owns unrelated custody maps; actual storage registration remains private in its original module. */
export function createIsolatedRoomUploadSourceCustody() {
  const engines = new WeakMap<object, StorageCommands>();
  const sources = new WeakMap<
    object,
    { size: number; open(context: InstallationRoomMutationContext): Promise<Readable> }
  >();
  function actual(storage: RoomUploadStorageEngine): StorageCommands {
    const engine = engines.get(storage);
    if (!engine) throw new Error('Unknown original Room upload storage.');
    return engine;
  }
  /** Multer's truthy protocol sentinel is resolved to the separately captured original cause. */
  function completeRoomFileUploadStorage(
    storage: RoomUploadStorageEngine,
    error: unknown
  ): Promise<void> {
    return actual(storage).complete(error);
  }
  /** Retire the original Room file upload storage custody. */
  function retireRoomFileUploadStorage(storage: RoomUploadStorageEngine): Promise<void> {
    return actual(storage).retire();
  }
  /** Issue upload source handles from the original owned upload operation. */
  function issueRoomFileUploadSources(
    storage: RoomUploadStorageEngine,
    request: IncomingMessage,
    files: readonly UploadedFile[]
  ): Promise<readonly Readonly<{ upload: object; size: number }>[]> {
    return actual(storage).issueSources(request, files);
  }
  /** Restore the original cause retained by a Room file upload. */
  function restoreRoomFileUploadCause(storage: RoomUploadStorageEngine, cause: unknown): unknown {
    return actual(storage).restoreCause(cause);
  }
  /** Open the original owned Room file upload source. */
  function openRoomFileUploadSource(
    source: object,
    context: InstallationRoomMutationContext,
    size: number
  ): Promise<Readable> {
    const acquired = sources.get(source);
    if (!acquired || !Number.isSafeInteger(size) || size !== acquired.size)
      return Promise.reject(new Error('Unknown or mismatched acquired upload source.'));
    return acquired.open(context);
  }
  return Object.freeze({
    registerEngine: (owner: object, commands: StorageCommands) => engines.set(owner, commands),
    registerSource: (
      source: object,
      acquired: { size: number; open(context: InstallationRoomMutationContext): Promise<Readable> }
    ) => sources.set(source, acquired),
    completeRoomFileUploadStorage,
    retireRoomFileUploadStorage,
    issueRoomFileUploadSources,
    restoreRoomFileUploadCause,
    openRoomFileUploadSource,
  });
}
