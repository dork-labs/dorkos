/** Stream storage selected by the original Room editor, independent of HTTP frameworks. */
import type { IncomingMessage } from 'node:http';
import type { UploadStreamFile, UploadedFile } from '../../../../http/uploads.js';

export interface RoomUploadStorageEngine {
  _handleFile(
    request: IncomingMessage,
    file: UploadStreamFile,
    callback: (error?: unknown, info?: Partial<UploadedFile>) => void
  ): void;
  _removeFile(
    request: IncomingMessage,
    file: UploadedFile,
    callback: (error: Error | null) => void
  ): void;
}
