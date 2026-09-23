import type { RangeReader } from './segmented-source.js';
import { collectBytes } from './streams.js';
import {
  CENTRAL_DIRECTORY_RECORD_BYTES,
  END_OF_CENTRAL_DIRECTORY_BYTES,
  END_OF_CENTRAL_DIRECTORY_SIGNATURE,
  toSafeNumber,
  UINT16_SENTINEL,
  UINT32_SENTINEL,
  ZIP64_END_BYTES,
  ZIP64_END_SIGNATURE,
  ZIP64_LOCATOR_BYTES,
  ZIP64_LOCATOR_SIGNATURE,
} from './zip-format.js';

/** Why an archive was refused. */
export type ZipReaderErrorCode =
  | 'ZIP_NOT_AN_ARCHIVE'
  | 'ZIP_CORRUPT'
  | 'ZIP_UNSUPPORTED'
  | 'ZIP_ENCRYPTED'
  | 'ZIP_METHOD_UNSUPPORTED'
  | 'ZIP_NAME_REJECTED'
  | 'ZIP_DIRECTORY_ENTRY'
  | 'ZIP_DUPLICATE_NAME'
  | 'ZIP_HEADER_MISMATCH'
  | 'ZIP_OVERLAPPING_ENTRIES'
  | 'ZIP_SIZE_MISMATCH'
  | 'ZIP_CRC_MISMATCH';

/** A refused archive, with a stable code callers map to their own error. */
export class ZipReaderError extends Error {
  constructor(
    readonly code: ZipReaderErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ZipReaderError';
  }
}

/** Where the central directory is and how many entries it declares. */
export interface CentralDirectoryLocation {
  entryCount: number;
  centralDirectoryOffset: number;
  centralDirectorySize: number;
}

/**
 * Find the end of central directory record in the last 64 KiB + 22 bytes, follow the ZIP64
 * locator when there is one, and check that the directory ends exactly where the end records
 * begin. Multi-disk archives are refused.
 */
export async function locateCentralDirectory(
  source: RangeReader,
  signal?: AbortSignal
): Promise<CentralDirectoryLocation> {
  const size = source.size;
  if (!Number.isSafeInteger(size) || size < END_OF_CENTRAL_DIRECTORY_BYTES) {
    throw new ZipReaderError('ZIP_NOT_AN_ARCHIVE', 'The file is not a zip archive');
  }
  const tailLength = Math.min(size, END_OF_CENTRAL_DIRECTORY_BYTES + 0xffff + ZIP64_LOCATOR_BYTES);
  const tailStart = size - tailLength;
  const tail = await readExact(source, tailStart, tailLength, signal);
  let at = -1;
  for (let index = tail.length - END_OF_CENTRAL_DIRECTORY_BYTES; index >= 0; index--) {
    if (
      tail.readUInt32LE(index) === END_OF_CENTRAL_DIRECTORY_SIGNATURE &&
      tail.readUInt16LE(index + 20) === tail.length - index - END_OF_CENTRAL_DIRECTORY_BYTES
    ) {
      at = index;
      break;
    }
  }
  if (at < 0) throw new ZipReaderError('ZIP_NOT_AN_ARCHIVE', 'The file is not a zip archive');

  const endOffset = tailStart + at;
  const disk = tail.readUInt16LE(at + 4);
  const directoryDisk = tail.readUInt16LE(at + 6);
  const entriesOnDisk = tail.readUInt16LE(at + 8);
  let entryCount = tail.readUInt16LE(at + 10);
  let directorySize = tail.readUInt32LE(at + 12);
  let directoryOffset = tail.readUInt32LE(at + 16);
  let directoryLimit = endOffset;

  const hasLocator =
    at >= ZIP64_LOCATOR_BYTES &&
    tail.readUInt32LE(at - ZIP64_LOCATOR_BYTES) === ZIP64_LOCATOR_SIGNATURE;
  if (hasLocator) {
    const locator = at - ZIP64_LOCATOR_BYTES;
    const recordOffset = toSafeNumber(tail.readBigUInt64LE(locator + 8));
    const totalDisks = tail.readUInt32LE(locator + 16);
    if (tail.readUInt32LE(locator + 4) !== 0 || totalDisks > 1) {
      throw new ZipReaderError('ZIP_UNSUPPORTED', 'Multi-disk archives are not supported');
    }
    if (recordOffset === null || recordOffset + ZIP64_END_BYTES > endOffset - ZIP64_LOCATOR_BYTES) {
      throw corrupt('The ZIP64 end record is out of place');
    }
    const record = await readExact(source, recordOffset, ZIP64_END_BYTES, signal);
    if (record.readUInt32LE(0) !== ZIP64_END_SIGNATURE) {
      throw corrupt('The ZIP64 end record is missing');
    }
    if (record.readUInt32LE(16) !== 0 || record.readUInt32LE(20) !== 0) {
      throw new ZipReaderError('ZIP_UNSUPPORTED', 'Multi-disk archives are not supported');
    }
    const onDisk = toSafeNumber(record.readBigUInt64LE(24));
    const total = toSafeNumber(record.readBigUInt64LE(32));
    const zip64Size = toSafeNumber(record.readBigUInt64LE(40));
    const zip64Offset = toSafeNumber(record.readBigUInt64LE(48));
    if (onDisk === null || total === null || zip64Size === null || zip64Offset === null) {
      throw corrupt('The ZIP64 end record is out of range');
    }
    if (onDisk !== total) throw corrupt('The ZIP64 end record disagrees with itself');
    entryCount = total;
    directorySize = zip64Size;
    directoryOffset = zip64Offset;
    directoryLimit = recordOffset;
  } else {
    if (disk !== 0 || directoryDisk !== 0) {
      throw new ZipReaderError('ZIP_UNSUPPORTED', 'Multi-disk archives are not supported');
    }
    if (
      entryCount === UINT16_SENTINEL ||
      directorySize === UINT32_SENTINEL ||
      directoryOffset === UINT32_SENTINEL
    ) {
      throw corrupt('The end record needs a ZIP64 record that is missing');
    }
    if (entriesOnDisk !== entryCount) throw corrupt('The end record disagrees with itself');
  }
  if (
    directoryOffset + directorySize !== directoryLimit ||
    entryCount * CENTRAL_DIRECTORY_RECORD_BYTES > directorySize
  ) {
    throw corrupt('The central directory is out of place');
  }
  return {
    entryCount,
    centralDirectoryOffset: directoryOffset,
    centralDirectorySize: directorySize,
  };
}

/** Read exactly `length` bytes at `start`, or refuse the archive as truncated. */
export async function readExact(
  source: RangeReader,
  start: number,
  length: number,
  signal?: AbortSignal
): Promise<Buffer> {
  if (start + length > source.size) throw corrupt('A record is past the end of the file');
  const bytes = await collectBytes(source.read(start, start + length - 1, { signal }));
  if (bytes.length !== length) throw corrupt('A record is truncated');
  return bytes;
}

/** A structurally broken archive. */
export function corrupt(message: string) {
  return new ZipReaderError('ZIP_CORRUPT', message);
}
