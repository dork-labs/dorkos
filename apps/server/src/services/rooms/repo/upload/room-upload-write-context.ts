import type { RoomUploadStorageEngine } from './room-upload-storage-contracts.js';
import type { AcquiredFile } from './room-upload-source-custody.js';
import type { RoomFileEditor } from '../room-file-editor.js';

/** Fixed original storage-owned view; the private key is never published. */
export interface OriginalRoomUploadWriteView {
  readonly editor: RoomFileEditor;
  readonly operation: object;
  readonly directory: string;
  readonly storage: RoomUploadStorageEngine;
  readonly files: Map<string, AcquiredFile>;
  admission(record: AcquiredFile): void;
  checkFile(record: AcquiredFile, open: boolean): Promise<void>;
  close(record: AcquiredFile): Promise<void>;
}
