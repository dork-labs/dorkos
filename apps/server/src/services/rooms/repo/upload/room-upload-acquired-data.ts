import type { UploadStreamFile, UploadedFile } from '../../../../http/uploads.js';
import type { IncomingMessage } from 'node:http';
import type { AcquiredFile } from './room-upload-source-custody.js';

/** Create the original fresh upload record before its owning storage registers or launches it. */
export function createAcquiredRoomUpload(
  req: IncomingMessage,
  file: UploadStreamFile
): AcquiredFile {
  return {
    path: '',
    filename: '',
    file,
    request: req,
    size: 0,
    cancelled: false,
    removed: false,
    done: Promise.resolve(),
    reads: new Set(),
    readers: new Set(),
  };
}

/** Validate the original result projection; this read-only check issues no upload authority. */
export function requireMatchingAcquiredRoomUpload(
  record: AcquiredFile | undefined,
  req: IncomingMessage,
  file: UploadedFile,
  seen: ReadonlySet<AcquiredFile>
): asserts record is AcquiredFile {
  if (
    !record ||
    record.request !== req ||
    record.removed ||
    seen.has(record) ||
    file.size !== record.size
  )
    throw new Error('Upload result does not match acquired original files.');
}
