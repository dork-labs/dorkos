import { constants, promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import multer from 'multer';
import type { AcquiredFile } from './room-upload-source-custody.js';
import {
  checkRoomFileEditorUploadCurrent,
  readRoomFileEditorUploadLimit,
} from '../room-file-editor.js';
import { readOriginalRoomUploadWriteView } from '../room-file-upload-storage.js';

/** Write only through the exact constructor-private storage turn. */
export async function writeOriginalRoomUploadFile(
  owner: object,
  record: AcquiredFile
): Promise<void> {
  const facet = readOriginalRoomUploadWriteView(owner);
  let failed = false,
    cause: unknown;
  try {
    record.filename = await new Promise<string>((resolve, reject) =>
      randomBytes(16, (error, raw) => (error ? reject(error) : resolve(raw.toString('hex'))))
    );
    record.path = path.join(facet.directory, record.filename);
    await checkRoomFileEditorUploadCurrent(
      facet.editor,
      facet.operation,
      facet.directory,
      facet.storage,
      record.request
    );
    facet.admission(record);
    record.handle = await fs.open(
      record.path,
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
      0o600
    );
    const identity = await record.handle.stat({ bigint: true });
    if (!identity.isFile()) throw new Error('Upload descriptor is not an ordinary file.');
    record.identity = { dev: identity.dev, ino: identity.ino };
    facet.files.set(record.path, record);
    record.file.path = record.path; // Multer's pending raw file and later spread clone refer to this acquired record.
    await facet.checkFile(record, true);
    for await (const part of record.file.stream) {
      const bytes = Buffer.isBuffer(part) ? part : Buffer.from(part);
      const limit = readRoomFileEditorUploadLimit(
        facet.editor,
        facet.operation,
        facet.directory,
        facet.storage
      );
      if (record.size + bytes.length > limit)
        throw new multer.MulterError('LIMIT_FILE_SIZE', record.file.fieldname);
      let offset = 0;
      while (offset < bytes.length) {
        await facet.checkFile(record, true);
        const written = await record.handle.write(bytes, offset, bytes.length - offset, null);
        if (written.bytesWritten <= 0) throw new Error('Upload descriptor made no write progress.');
        offset += written.bytesWritten;
        record.size += written.bytesWritten;
      }
    }
    await facet.checkFile(record, true);
  } catch (error) {
    failed = true;
    cause = error;
  } finally {
    // Successful source FD is retained for the later original commit, never pathname-reopened.
    // On failure the genuine returned FD closes regardless of current credential/root state.
    if (failed) {
      try {
        await facet.close(record);
      } catch {
        /* Preserve original body cause including undefined. */
      }
    }
  }
  if (failed) throw cause;
}
