import { promises as fs } from 'node:fs';
import type { AcquiredFile } from './room-upload-source-custody.js';
import { readOriginalRoomUploadWriteView } from '../room-file-upload-storage.js';

/** Read the exact acquired descriptor/path identity only after original constructor ownership lookup. */
export async function checkOriginalRoomUploadIdentity(
  owner: object,
  record: AcquiredFile,
  open: boolean
): Promise<void> {
  readOriginalRoomUploadWriteView(owner);
  if (!record.identity) throw new Error('No acquired upload identity.');
  if (open) {
    if (!record.handle) throw new Error('No acquired upload descriptor.');
    const descriptor = await record.handle.stat({ bigint: true });
    if (
      !descriptor.isFile() ||
      descriptor.dev !== record.identity.dev ||
      descriptor.ino !== record.identity.ino
    )
      throw new Error('Upload descriptor identity changed.');
  }
  const entry = await fs.lstat(record.path, { bigint: true });
  if (
    !entry.isFile() ||
    entry.isSymbolicLink() ||
    entry.dev !== record.identity.dev ||
    entry.ino !== record.identity.ino
  )
    throw new Error('Upload file identity changed.');
}
